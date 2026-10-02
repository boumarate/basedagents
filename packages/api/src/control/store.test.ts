/**
 * Tests for the owner control-plane data layer (ControlStore) + owner identity.
 *
 * The app test schema (db/schema.sql) does NOT contain the 0023 owner tables, so
 * we build a dedicated in-memory DB here: a minimal `agents` table (for the
 * delegation FK) plus the exact 0023 migration SQL, with foreign_keys ON so the
 * UNIQUE/FK constraints are actually exercised.
 *
 * Emphasis (CONTROL_PLANE.md §4/§5): the atomic single-use challenge, the atomic
 * monotonic counter, and the per-owner hash chain.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { GENESIS_HASH, base58Encode } from '../crypto/index.js';
import { ControlStore } from './store.js';
import {
  ownerIdFromVaultPubkey,
  vaultPubkeyFromOwnerId,
  isOwnerId,
} from './identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const MIGRATION_SQL =
  readFileSync(join(MIGRATIONS_DIR, '0023_owner_accounts.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0024_keyring_approvals.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0025_owner_recovery.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0026_owner_billing.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0027_authority_ladder.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0032_daemon_kill_confirm.sql'), 'utf-8') +
  // 0040 retires the keyring tables/columns — the harness sees prod's schema.
  readFileSync(join(MIGRATIONS_DIR, '0048_retire_keyring.sql'), 'utf-8');

let rawDb: Database.Database;
let db: SQLiteAdapter;
let store: ControlStore;

function makeStore(): void {
  rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  // Minimal agents table so delegations.agent_id FK resolves.
  rawDb.exec(
    `CREATE TABLE agents (
       id TEXT PRIMARY KEY,
       public_key BLOB,
       name TEXT,
       status TEXT NOT NULL DEFAULT 'active',
       registered_at TEXT
     );`
  );
  rawDb.exec(MIGRATION_SQL);
  db = new SQLiteAdapter(rawDb);
  store = new ControlStore(db);
}

let vaultCounter = 0;
function randomVaultPubkey(): Uint8Array {
  // Deterministic-ish 32-byte key; unique per call so owner ids don't collide.
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  b[0] = ++vaultCounter & 0xff;
  return b;
}

async function makeOwner(opts: { email?: string; displayName?: string } = {}) {
  const pub = randomVaultPubkey();
  const ownerId = ownerIdFromVaultPubkey(pub);
  const owner = await store.createOwner({ ownerId, ...opts });
  return { owner, ownerId, pub };
}

let agentCounter = 0;
function makeAgent(): string {
  const id = `ag_test_${++agentCounter}`;
  rawDb.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'active')`).run(id, `agent-${id}`);
  return id;
}

/** Append an assertion and return its id (used for FK-satisfying authorizations). */
async function appendAssertion(ownerId: string, actionType = 'approve_grant', actionHash = 'h') {
  return store.appendActionAssertion({
    ownerId,
    credentialId: 'cred-b64url',
    actionType,
    actionHash,
    authenticatorData: 'ad',
    clientDataJson: 'cd',
    signature: 'sig',
  });
}

beforeEach(() => {
  makeStore();
});

// ─────────────────────────────────────────────────────────────────────────────
// identity.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('identity', () => {
  it('derives ow_ ids and round-trips the vault pubkey', () => {
    const pub = new Uint8Array(32).fill(7);
    const id = ownerIdFromVaultPubkey(pub);
    expect(id.startsWith('ow_')).toBe(true);
    expect(id.slice(3)).toBe(base58Encode(pub));
    expect(Array.from(vaultPubkeyFromOwnerId(id))).toEqual(Array.from(pub));
    expect(isOwnerId(id)).toBe(true);
  });

  it('rejects malformed owner ids', () => {
    expect(isOwnerId('ag_whatever')).toBe(false);
    expect(isOwnerId('ow_')).toBe(false);
    expect(isOwnerId('not-an-id')).toBe(false);
    // ow_ + base58 of a 16-byte key is the wrong length.
    const shortId = 'ow_' + base58Encode(new Uint8Array(16).fill(1));
    expect(isOwnerId(shortId)).toBe(false);
    expect(() => vaultPubkeyFromOwnerId(shortId)).toThrow();
    expect(() => vaultPubkeyFromOwnerId('nope')).toThrow(/ow_ prefix/);
    expect(() => ownerIdFromVaultPubkey(new Uint8Array(31))).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Owners + credentials CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe('owners + credentials', () => {
  it('round-trips owners by id and email', async () => {
    const { owner, ownerId } = await makeOwner({ email: 'a@b.com', displayName: 'Ada' });
    expect(owner.id).toBe(ownerId);
    expect(owner.email).toBe('a@b.com');
    expect(owner.display_name).toBe('Ada');
    expect(owner.status).toBe('active');
    expect(owner.email_verified).toBe(0);

    expect(await store.getOwner(ownerId)).toMatchObject({ id: ownerId, email: 'a@b.com' });
    expect(await store.getOwnerByEmail('a@b.com')).toMatchObject({ id: ownerId });
    expect(await store.getOwner('ow_missing')).toBeNull();
    expect(await store.getOwnerByEmail('none@none.com')).toBeNull();
  });

  it('stores and returns credential public_key bytes intact', async () => {
    const { ownerId } = await makeOwner();
    const publicKey = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 0, 42]);
    const cred = await store.addCredential({
      ownerId,
      credentialId: 'YWJjZA', // base64url
      publicKey,
      counter: 5,
      aaguid: 'aaguid-1',
      backedUp: true,
      transports: ['internal', 'hybrid'],
      nickname: 'my phone',
    });

    expect(cred.id.startsWith('cred_')).toBe(true);
    expect(cred.public_key).toBeInstanceOf(Uint8Array);
    expect(Array.from(cred.public_key)).toEqual(Array.from(publicKey));
    expect(cred.transports).toEqual(['internal', 'hybrid']);
    expect(cred.backed_up).toBe(1);
    expect(cred.signature_counter).toBe(5);

    const byCredId = await store.getCredentialByCredentialId('YWJjZA');
    expect(byCredId).not.toBeNull();
    expect(Array.from(byCredId!.public_key)).toEqual(Array.from(publicKey));

    const list = await store.listCredentials(ownerId);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(cred.id);

    expect(await store.getCredentialByCredentialId('nope')).toBeNull();
  });

  it('enforces credential_id uniqueness and owner FK', async () => {
    const { ownerId } = await makeOwner();
    await store.addCredential({
      ownerId,
      credentialId: 'dup',
      publicKey: new Uint8Array([1]),
      counter: 0,
      backedUp: false,
    });
    await expect(
      store.addCredential({
        ownerId,
        credentialId: 'dup',
        publicKey: new Uint8Array([2]),
        counter: 0,
        backedUp: false,
      })
    ).rejects.toThrow();

    // owner FK: a credential for a non-existent owner is rejected.
    await expect(
      store.addCredential({
        ownerId: 'ow_ghost',
        credentialId: 'x',
        publicKey: new Uint8Array([1]),
        counter: 0,
        backedUp: false,
      })
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Challenges — single-use atomicity
// ─────────────────────────────────────────────────────────────────────────────

describe('consumeChallenge (single-use atomic guard)', () => {
  it('consumes exactly once; a replay returns null', async () => {
    const { ownerId } = await makeOwner();
    const { challenge } = await store.createChallenge({ ownerId, purpose: 'login', ttlSeconds: 300 });
    const now = new Date().toISOString();

    const first = await store.consumeChallenge(challenge, 'login', now);
    expect(first).not.toBeNull();
    expect(first!.challenge).toBe(challenge);
    expect(first!.consumed_at).toBe(now);

    const second = await store.consumeChallenge(challenge, 'login', new Date().toISOString());
    expect(second).toBeNull();
  });

  it('returns null for an expired challenge', async () => {
    const { ownerId } = await makeOwner();
    const { challenge } = await store.createChallenge({ ownerId, purpose: 'login', ttlSeconds: -10 });
    const res = await store.consumeChallenge(challenge, 'login', new Date().toISOString());
    expect(res).toBeNull();
  });

  it('returns null when the purpose does not match', async () => {
    const { ownerId } = await makeOwner();
    const { challenge } = await store.createChallenge({ ownerId, purpose: 'action', ttlSeconds: 300 });
    const res = await store.consumeChallenge(challenge, 'login', new Date().toISOString());
    expect(res).toBeNull();
    // The mismatch must not have consumed it; the correct purpose still works.
    const ok = await store.consumeChallenge(challenge, 'action', new Date().toISOString());
    expect(ok).not.toBeNull();
  });

  it('CONCURRENCY: two racing consumers, exactly one wins', async () => {
    const { ownerId } = await makeOwner();
    const { challenge } = await store.createChallenge({ ownerId, purpose: 'action', ttlSeconds: 300 });
    const now = new Date().toISOString();

    const [a, b] = await Promise.all([
      store.consumeChallenge(challenge, 'action', now),
      store.consumeChallenge(challenge, 'action', now),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// advanceCounter — atomic monotonic bump / replay defense
// ─────────────────────────────────────────────────────────────────────────────

describe('advanceCounter (atomic monotonic bump)', () => {
  async function credWithCounter(counter: number): Promise<string> {
    const { ownerId } = await makeOwner();
    const cred = await store.addCredential({
      ownerId,
      credentialId: `c-${counter}-${Math.random()}`,
      publicKey: new Uint8Array([9]),
      counter,
      backedUp: false,
    });
    return cred.id;
  }
  const storedCounter = async (id: string) =>
    (await store.getCredentialByCredentialId(
      (await db.get<{ credential_id: string }>(
        'SELECT credential_id FROM owner_webauthn_credentials WHERE id = ?',
        id
      ))!.credential_id
    ))!.signature_counter;

  it('advances to a higher counter and persists', async () => {
    const id = await credWithCounter(5);
    expect(await store.advanceCounter(id, 10)).toBe(true);
    expect(await storedCounter(id)).toBe(10);
  });

  it('rejects an equal counter and does NOT change the stored value', async () => {
    const id = await credWithCounter(5);
    expect(await store.advanceCounter(id, 10)).toBe(true);
    expect(await store.advanceCounter(id, 10)).toBe(false);
    expect(await storedCounter(id)).toBe(10);
  });

  it('rejects a lower counter (clone/replay) and keeps the stored value', async () => {
    const id = await credWithCounter(5);
    expect(await store.advanceCounter(id, 20)).toBe(true);
    expect(await store.advanceCounter(id, 3)).toBe(false);
    expect(await storedCounter(id)).toBe(20);
  });

  it('allows the no-counter 0->0 case, then advances, then rejects a 0 from a nonzero stored', async () => {
    const id = await credWithCounter(0);
    expect(await store.advanceCounter(id, 0)).toBe(true); // no-counter authenticator
    expect(await storedCounter(id)).toBe(0);
    expect(await store.advanceCounter(id, 5)).toBe(true);
    expect(await storedCounter(id)).toBe(5);
    // A device now claiming 0 while stored is 5 is a clone — rejected.
    expect(await store.advanceCounter(id, 0)).toBe(false);
    expect(await storedCounter(id)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('sessions', () => {
  it('creates, fetches by token hash, touches, and revokes', async () => {
    const { ownerId } = await makeOwner();
    const s = await store.createSession({
      ownerId,
      tokenHash: 'th-1',
      credentialId: 'cred-x',
      ttlSeconds: 3600,
      userAgent: 'ua',
      ipHash: 'iph',
    });
    expect(s.id.startsWith('ses_')).toBe(true);

    const fetched = await store.getSessionByTokenHash('th-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.owner_id).toBe(ownerId);

    await store.touchSession(s.id, '2030-01-01T00:00:00.000Z');
    expect((await store.getSessionByTokenHash('th-1'))!.last_seen_at).toBe('2030-01-01T00:00:00.000Z');

    await store.revokeSession(s.id, new Date().toISOString());
    expect(await store.getSessionByTokenHash('th-1')).toBeNull();
  });

  it('does not return an expired session', async () => {
    const { ownerId } = await makeOwner();
    await store.createSession({ ownerId, tokenHash: 'th-exp', ttlSeconds: -5 });
    expect(await store.getSessionByTokenHash('th-exp')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Action-assertion hash chain
// ─────────────────────────────────────────────────────────────────────────────

describe('action assertion chain', () => {
  it('appends a linked chain that verifies', async () => {
    const { ownerId } = await makeOwner();
    expect(await store.getOwnerChainHead(ownerId)).toEqual({ sequence: 0, entry_hash: GENESIS_HASH });

    const a1 = await appendAssertion(ownerId, 'bind_vault', 'h1');
    const a2 = await appendAssertion(ownerId, 'delegate', 'h2');
    const a3 = await appendAssertion(ownerId, 'revoke', 'h3');

    expect([a1.sequence, a2.sequence, a3.sequence]).toEqual([1, 2, 3]);
    expect(a1.prev_hash).toBe(GENESIS_HASH);
    expect(a2.prev_hash).toBe(a1.entry_hash);
    expect(a3.prev_hash).toBe(a2.entry_hash);

    const head = await store.getOwnerChainHead(ownerId);
    expect(head.sequence).toBe(3);
    expect(head.entry_hash).toBe(a3.entry_hash);

    const v = await store.verifyOwnerChain(ownerId);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('detects tampering with a stored field', async () => {
    const { ownerId } = await makeOwner();
    await appendAssertion(ownerId, 'a', 'h1');
    await appendAssertion(ownerId, 'b', 'h2');
    await appendAssertion(ownerId, 'c', 'h3');

    expect((await store.verifyOwnerChain(ownerId)).ok).toBe(true);

    // Tamper the action_hash of sequence 2 WITHOUT recomputing entry_hash.
    rawDb
      .prepare('UPDATE action_assertions SET action_hash = ? WHERE owner_id = ? AND sequence = 2')
      .run('TAMPERED', ownerId);

    const v = await store.verifyOwnerChain(ownerId);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
    expect(v.errors.some((e) => e.includes('entry_hash mismatch'))).toBe(true);
  });

  it('keeps two owners on independent chains', async () => {
    const { ownerId: o1 } = await makeOwner();
    const { ownerId: o2 } = await makeOwner();

    await appendAssertion(o1, 'x', '1');
    await appendAssertion(o1, 'y', '2');
    await appendAssertion(o2, 'z', '1');

    expect((await store.getOwnerChainHead(o1)).sequence).toBe(2);
    expect((await store.getOwnerChainHead(o2)).sequence).toBe(1);
    expect((await store.verifyOwnerChain(o1)).ok).toBe(true);
    expect((await store.verifyOwnerChain(o2)).ok).toBe(true);

    // Tampering o1's chain does not break o2's.
    rawDb
      .prepare('UPDATE action_assertions SET signature = ? WHERE owner_id = ? AND sequence = 1')
      .run('bad', o1);
    expect((await store.verifyOwnerChain(o1)).ok).toBe(false);
    expect((await store.verifyOwnerChain(o2)).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delegations
// ─────────────────────────────────────────────────────────────────────────────

describe('delegations', () => {
  it('creates, dedups, revokes, and lists', async () => {
    const { ownerId } = await makeOwner();
    const agentId = makeAgent();
    const authz = await appendAssertion(ownerId, 'delegate', 'dh');

    const del = await store.createDelegation({
      ownerId,
      agentId,
      label: 'laptop agent',
      authorizingAssertionId: authz.id,
    });
    expect(del.id.startsWith('del_')).toBe(true);
    expect(del.status).toBe('active');
    expect(del.authorizing_assertion_id).toBe(authz.id);

    // Duplicate (owner, agent) is rejected with a clear error.
    await expect(
      store.createDelegation({ ownerId, agentId, authorizingAssertionId: authz.id })
    ).rejects.toThrow(/already delegated/);

    expect(await store.getDelegation(ownerId, agentId)).toMatchObject({ id: del.id });

    // Revoke.
    const revokeAssertion = await appendAssertion(ownerId, 'revoke', 'rh');
    const revoked = await store.revokeDelegation({
      delegationId: del.id,
      revokeAssertionId: revokeAssertion.id,
      nowIso: '2031-05-05T05:05:05.000Z',
    });
    expect(revoked.status).toBe('revoked');
    expect(revoked.revoke_assertion_id).toBe(revokeAssertion.id);
    expect(revoked.revoked_at).toBe('2031-05-05T05:05:05.000Z');
  });

});
