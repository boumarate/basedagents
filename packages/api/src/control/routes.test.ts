/**
 * End-to-end tests for the Keyring owner console routes.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * These exercise the FULL authority model of CONTROL_PLANE.md §3 ("sessions to
 * look, signatures to act") against a SIMULATED WebAuthn authenticator: a real
 * ES256/P-256 keypair (Web Crypto) that hand-builds the exact byte structures a
 * browser authenticator emits (COSE key, authenticatorData, clientDataJSON, a
 * DER ECDSA signature, a fmt='none' attestationObject) — the same approach as
 * webauthn.test.ts. Every adversarial test proves one security property.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { AppEnv } from '../types/index.js';
import { sha256, base58Encode, bytesToHex } from '../crypto/index.js';
import { base64urlEncode, base64urlDecode } from './webauthn.js';
import { ownerIdFromVaultPubkey } from './identity.js';
import { ControlStore } from './store.js';
import { resetCertificationProbeForTests } from './certification.js';
import ownerRoutes from './routes.js';
import boardRoutes from '../routes/board.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const MIGRATION_SQL =
  // 0021: rate_limit_log — the owner board-post route's 60/hr bucket
  // (checkRateLimit) reads it.
  readFileSync(join(MIGRATIONS_DIR, '0021_rate_limit_table.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0023_owner_accounts.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0024_keyring_approvals.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0025_owner_recovery.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0026_owner_billing.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0027_authority_ladder.sql'), 'utf-8') +
  // 0033: board_posts — owner board posting writes it, and the public read
  // path (mounted below) joins it back against the control-plane tables
  // (GOTCHAS.md: explicit per-harness migration lists).
  readFileSync(join(MIGRATIONS_DIR, '0033_board.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0032_daemon_kill_confirm.sql'), 'utf-8') +
  // 0040 retires the keyring tables/columns — the harness sees prod's schema.
  readFileSync(join(MIGRATIONS_DIR, '0048_retire_keyring.sql'), 'utf-8');

const te = new TextEncoder();
const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';

// ─── byte helpers (mirrors webauthn.test.ts) ───

type CborType = Parameters<typeof isoCBOR.encode>[0];

function concat(...arrs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function u32be(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** raw ECDSA r||s (64 bytes) → ASN.1 DER, as WebAuthn authenticators emit. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const encInt = (v: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = v.slice(i);
    if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([0x02, b.length]), b);
  };
  const body = concat(encInt(raw.slice(0, 32)), encInt(raw.slice(32, 64)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

async function signDer(privateKey: CryptoKey, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array(
    await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message),
  );
  return rawToDer(raw);
}

// ─── simulated authenticator ───

interface AssertionBody {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

class Authenticator {
  private constructor(
    private privateKey: CryptoKey,
    readonly cose: Uint8Array,
    readonly credentialId: string,
    /** the base58 Ed25519 vault pubkey this authenticator's owner derives from */
    readonly vaultB58: string,
    readonly ownerId: string,
  ) {}

  static async create(): Promise<Authenticator> {
    const kp = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, base64urlDecode(jwk.x!)],
        [-3, base64urlDecode(jwk.y!)],
      ]) as CborType,
    );
    const rawId = new Uint8Array(16);
    globalThis.crypto.getRandomValues(rawId);

    // A distinct 32-byte "vault Ed25519 pubkey" → owner id.
    const vaultPub = new Uint8Array(32);
    globalThis.crypto.getRandomValues(vaultPub);
    const vaultB58 = base58Encode(vaultPub);
    const ownerId = ownerIdFromVaultPubkey(vaultPub);

    return new Authenticator(kp.privateKey, cose, base64urlEncode(rawId), vaultB58, ownerId);
  }

  /** fmt='none' attestation for /register/finish (counter starts at 0). */
  registration(challenge: string): { attestationObject: string; clientDataJSON: string } {
    const rpIdHash = sha256(te.encode(RP_ID));
    const aaguid = new Uint8Array(16);
    const credIdBytes = base64urlDecode(this.credentialId);
    const credIdLen = new Uint8Array([(credIdBytes.length >> 8) & 0xff, credIdBytes.length & 0xff]);
    const attested = concat(aaguid, credIdLen, credIdBytes, this.cose);
    const authData = concat(rpIdHash, new Uint8Array([0x5d]), u32be(0), attested); // UP|UV|BE|BS|AT

    const attestationObject = isoCBOR.encode(
      new Map<string, CborType>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, CborType>()],
        ['authData', authData],
      ]) as CborType,
    );
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false });
    return {
      attestationObject: base64urlEncode(attestationObject),
      clientDataJSON: base64urlEncode(te.encode(clientDataJSON)),
    };
  }

  /** A get() assertion over `challenge` at the given signature counter. */
  async assert(challenge: string, counter: number): Promise<AssertionBody> {
    const rpIdHash = sha256(te.encode(RP_ID));
    const authData = concat(rpIdHash, new Uint8Array([0x05]), u32be(counter)); // UP|UV
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false });
    const cdjBytes = te.encode(clientDataJSON);
    const der = await signDer(this.privateKey, concat(authData, sha256(cdjBytes)));
    return {
      credentialId: this.credentialId,
      authenticatorData: base64urlEncode(authData),
      clientDataJSON: base64urlEncode(cdjBytes),
      signature: base64urlEncode(der),
    };
  }
}

// ─── app + db harness ───

let rawDb: Database.Database;
let db: SQLiteAdapter;
let app: Hono<AppEnv>;
let store: ControlStore;

function buildApp(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  a.route('/v1/owner', ownerRoutes);
  // The public board read path too: owner posts are asserted through the SAME
  // lens agents and humans read them through (author filter + cert badge).
  a.route('/v1/board', boardRoutes);
  return a;
}

let agentCounter = 0;
function makeAgent(): string {
  const id = `ag_test_${++agentCounter}`;
  rawDb.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'active')`).run(id, `agent-${id}`);
  return id;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie) headers.Cookie = cookie;
  return await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  return await app.request(path, { method: 'GET', headers });
}

function sessionCookie(res: Response): string {
  const setC = res.headers.get('set-cookie');
  if (!setC) throw new Error('no Set-Cookie header on response');
  const m = /ba_owner_session=([^;]+)/.exec(setC);
  if (!m) throw new Error(`ba_owner_session not found in: ${setC}`);
  return `ba_owner_session=${m[1]}`;
}

/** Register a fresh authenticator's passkey (owner is created if absent). */
async function register(auth: Authenticator): Promise<void> {
  const beginRes = await post('/v1/owner/register/begin', { vault_public_key: auth.vaultB58 });
  expect(beginRes.status).toBe(200);
  const begin = (await beginRes.json()) as { options: { challenge: string } };
  const reg = auth.registration(begin.options.challenge);
  const finishRes = await post('/v1/owner/register/finish', {
    vault_public_key: auth.vaultB58,
    attestationObject: reg.attestationObject,
    clientDataJSON: reg.clientDataJSON,
  });
  expect(finishRes.status).toBe(200);
}

/** Log in a registered authenticator; returns the session cookie. Uses counter 1. */
async function login(auth: Authenticator): Promise<string> {
  const beginRes = await post('/v1/owner/login/begin', { owner_id: auth.ownerId });
  expect(beginRes.status).toBe(200);
  const begin = (await beginRes.json()) as { challenge: string };
  const assertion = await auth.assert(begin.challenge, 1);
  const finishRes = await post('/v1/owner/login/finish', assertion);
  expect(finishRes.status).toBe(200);
  return sessionCookie(finishRes);
}

/** Ask the server to arm an action challenge; returns the action_hash to sign. */
async function actionBegin(
  cookie: string,
  action_type: string,
  params: Record<string, unknown>,
): Promise<{ challenge: string; nonce: string }> {
  const res = await post('/v1/owner/action/begin', { action_type, params }, cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { challenge: string; nonce: string };
  return { challenge: body.challenge, nonce: body.nonce };
}

beforeEach(() => {
  rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  rawDb.exec(
    `CREATE TABLE agents (
       id TEXT PRIMARY KEY, public_key BLOB, name TEXT,
       status TEXT NOT NULL DEFAULT 'active', registered_at TEXT
     );`,
  );
  rawDb.exec(MIGRATION_SQL);
  db = new SQLiteAdapter(rawDb);
  store = new ControlStore(db);
  agentCounter = 0;
  // The board read path's per-isolate table probe must re-run against each
  // fresh DB (the control tables always exist here, but a memoized verdict
  // from another test's DB is still a lie).
  resetCertificationProbeForTests();
  app = buildApp();
});

// ─────────────────────────────────────────────────────────────────────────────
// HAPPY PATH — register → login → action/begin → sign → create delegation
// ─────────────────────────────────────────────────────────────────────────────

describe('happy path: sessions to look, signatures to act', () => {
  it('registers, logs in, and creates a delegation with a fresh assertion', async () => {
    const auth = await Authenticator.create();
    await register(auth);

    // The passkey + owner now exist.
    expect(await store.getOwner(auth.ownerId)).not.toBeNull();
    const creds = await store.listCredentials(auth.ownerId);
    expect(creds).toHaveLength(1);
    expect(creds[0].credential_id).toBe(auth.credentialId);

    const cookie = await login(auth);
    const agentA = makeAgent();

    // action/begin binds the challenge to the EXACT action.
    const { challenge, nonce } = await actionBegin(cookie, 'create_delegation', {
      agent_id: agentA,
      label: 'laptop',
    });
    const assertion = await auth.assert(challenge, 2); // counter advances past login's 1

    const res = await post('/v1/owner/delegations', { agent_id: agentA, label: 'laptop', nonce, assertion }, cookie);
    expect(res.status).toBe(200);
    const delegation = (await res.json()) as { id: string; status: string; agent_id: string };
    expect(delegation.status).toBe('active');
    expect(delegation.agent_id).toBe(agentA);

    // GET /me surfaces it.
    const meRes = await get('/v1/owner/me', cookie);
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { delegations: Array<{ id: string; status: string }> };
    expect(me.delegations).toHaveLength(1);
    expect(me.delegations[0].id).toBe(delegation.id);

    // The owner authority chain recorded the assertion and still verifies.
    const chain = await store.verifyOwnerChain(auth.ownerId);
    expect(chain.ok).toBe(true);
    const head = await store.getOwnerChainHead(auth.ownerId);
    expect(head.sequence).toBe(1);
  });

  it('revokes a delegation with a fresh assertion', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agentA = makeAgent();

    const a1 = await actionBegin(cookie, 'create_delegation', { agent_id: agentA, label: null });
    const del = (await (
      await post('/v1/owner/delegations', { agent_id: agentA, nonce: a1.nonce, assertion: await auth.assert(a1.challenge, 2) }, cookie)
    ).json()) as { id: string };

    const a2 = await actionBegin(cookie, 'revoke_delegation', { delegation_id: del.id });
    const res = await post(`/v1/owner/delegations/${del.id}/revoke`, { nonce: a2.nonce, assertion: await auth.assert(a2.challenge, 3) }, cookie);
    expect(res.status).toBe(200);
    const revoked = (await res.json()) as { status: string };
    expect(revoked.status).toBe('revoked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL — each proves one property from CONTROL_PLANE.md
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: replay defense (single-use challenge, §4)', () => {
  it('rejects the SAME assertion submitted twice (challenge consumed)', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agentA = makeAgent();

    const { challenge, nonce } = await actionBegin(cookie, 'create_delegation', { agent_id: agentA, label: 'x' });
    const assertion = await auth.assert(challenge, 2);
    const body = { agent_id: agentA, label: 'x', nonce, assertion };

    const first = await post('/v1/owner/delegations', body, cookie);
    expect(first.status).toBe(200);

    // Replay the identical assertion + body: the action challenge is already consumed.
    const second = await post('/v1/owner/delegations', body, cookie);
    expect(second.status).toBe(401);
    expect(((await second.json()) as { message: string }).message).toMatch(/replayed action challenge/);

    // Exactly one delegation exists.
    expect(await store.listDelegationsByOwner(auth.ownerId)).toHaveLength(1);
  });
});

describe('adversarial: wrong-action binding (WYSIWYS, §2/§3)', () => {
  it('rejects an assertion for agent A reused to delegate agent B', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agentA = makeAgent();
    const agentB = makeAgent();

    // Sign an assertion authorizing a delegation for agent A...
    const { challenge, nonce } = await actionBegin(cookie, 'create_delegation', { agent_id: agentA, label: null });
    const assertion = await auth.assert(challenge, 2);

    // ...then submit it for agent B (different params → different action_hash),
    // reusing agent A's nonce. The reconstructed action_hash won't match what was signed.
    const res = await post('/v1/owner/delegations', { agent_id: agentB, nonce, assertion }, cookie);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/does not authorize this action/);

    expect(await store.getDelegation(auth.ownerId, agentB)).toBeNull();
  });
});

describe('adversarial: cloned authenticator (monotonic counter, §4)', () => {
  it('rejects an assertion whose counter regresses below the stored value', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth); // stored counter → 1
    const agentA = makeAgent();
    const agentB = makeAgent();

    // A legitimate action at counter 5 advances the stored counter to 5.
    const a1 = await actionBegin(cookie, 'create_delegation', { agent_id: agentA, label: null });
    const ok = await post('/v1/owner/delegations', { agent_id: agentA, nonce: a1.nonce, assertion: await auth.assert(a1.challenge, 5) }, cookie);
    expect(ok.status).toBe(200);

    // A clone replays an OLD counter (3 ≤ 5) over a fresh, correctly-signed action.
    const a2 = await actionBegin(cookie, 'create_delegation', { agent_id: agentB, label: null });
    const res = await post('/v1/owner/delegations', { agent_id: agentB, nonce: a2.nonce, assertion: await auth.assert(a2.challenge, 3) }, cookie);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/counter regression/);

    expect(await store.getDelegation(auth.ownerId, agentB)).toBeNull();
  });
});

describe('adversarial: a session alone cannot mutate (§3)', () => {
  it('rejects a mutation with a valid cookie but no/garbage assertion, creating nothing', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agentA = makeAgent();

    // Missing assertion → validation failure.
    const missing = await post('/v1/owner/delegations', { agent_id: agentA }, cookie);
    expect(missing.status).toBe(400);

    // Garbage assertion (well-typed but not a real WebAuthn assertion) → rejected.
    const garbage = await post(
      '/v1/owner/delegations',
      {
        agent_id: agentA,
        assertion: { credentialId: 'x', authenticatorData: 'y', clientDataJSON: 'z', signature: 'w' },
      },
      cookie,
    );
    expect(garbage.status).toBeGreaterThanOrEqual(400);
    expect(garbage.status).toBeLessThan(500);

    // No delegation was created by the look-session alone.
    expect(await store.listDelegationsByOwner(auth.ownerId)).toHaveLength(0);
  });
});

describe('adversarial: unauthenticated read (§3)', () => {
  it('rejects GET /me with no session cookie', async () => {
    const res = await get('/v1/owner/me');
    expect(res.status).toBe(401);
  });

  it('rejects GET /delegations with no session cookie', async () => {
    const res = await get('/v1/owner/delegations');
    expect(res.status).toBe(401);
  });
});

describe("adversarial: another owner's passkey cannot act for me (§3)", () => {
  it("rejects an assertion signed by a different owner's credential", async () => {
    const owner1 = await Authenticator.create();
    await register(owner1);
    const cookie1 = await login(owner1);

    const owner2 = await Authenticator.create();
    await register(owner2); // owner2's credential exists in the DB, but is not owner1's

    const agentA = makeAgent();

    // owner1's session begins the action; owner2 signs the SAME action_hash.
    const { challenge, nonce } = await actionBegin(cookie1, 'create_delegation', { agent_id: agentA, label: null });
    const foreignAssertion = await owner2.assert(challenge, 2);

    const res = await post('/v1/owner/delegations', { agent_id: agentA, nonce, assertion: foreignAssertion }, cookie1);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/unknown credential for this owner/);

    expect(await store.listDelegationsByOwner(owner1.ownerId)).toHaveLength(0);
  });
});

describe('adversarial: static-counter (counter=0) assertion cannot be replayed after re-arm (§3/§4)', () => {
  it('rejects a captured assertion resubmitted after the action challenge is re-armed', async () => {
    // Simulates iCloud-Keychain-style passkeys that always report signature
    // counter 0, so the monotonic-counter guard never fires — the per-ceremony
    // nonce is what defends against replay by a stolen look-session.
    const auth = await Authenticator.create();
    await register(auth);
    // Log in at counter 0 (advanceCounter special-cases the no-counter authenticator).
    const beginRes = await post('/v1/owner/login/begin', { owner_id: auth.ownerId });
    const begin = (await beginRes.json()) as { challenge: string };
    const finishRes = await post('/v1/owner/login/finish', await auth.assert(begin.challenge, 0));
    expect(finishRes.status).toBe(200);
    const cookie = finishRes.headers.get('set-cookie')!.split(';')[0];
    const agentA = makeAgent();

    // A legitimate delegation, everything at counter 0. Capture the assertion.
    const a1 = await actionBegin(cookie, 'create_delegation', { agent_id: agentA, label: null });
    const captured = await auth.assert(a1.challenge, 0);
    const first = await post('/v1/owner/delegations', { agent_id: agentA, nonce: a1.nonce, assertion: captured }, cookie);
    expect(first.status).toBe(200);

    // Attacker re-arms the SAME action (fresh nonce a2, different action_hash) and
    // replays the captured assertion two ways — both must fail despite counter 0.
    const a2 = await actionBegin(cookie, 'create_delegation', { agent_id: agentA, label: null });
    expect(a2.nonce).not.toBe(a1.nonce);

    // (a) with the original nonce → its challenge is already consumed → replay 401.
    const replayOrig = await post('/v1/owner/delegations', { agent_id: agentA, nonce: a1.nonce, assertion: captured }, cookie);
    expect(replayOrig.status).toBe(401);
    expect(((await replayOrig.json()) as { message: string }).message).toMatch(/replayed action challenge/);

    // (b) with the re-armed nonce → captured assertion signed a1's hash, not a2's → WYSIWYS 400.
    const replayRearmed = await post('/v1/owner/delegations', { agent_id: agentA, nonce: a2.nonce, assertion: captured }, cookie);
    expect(replayRearmed.status).toBe(400);
    expect(((await replayRearmed.json()) as { message: string }).message).toMatch(/does not authorize this action/);

    // Exactly one delegation — no replay slipped through.
    expect(await store.listDelegationsByOwner(auth.ownerId)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Login/session lifecycle sanity
// ─────────────────────────────────────────────────────────────────────────────

describe('session lifecycle', () => {
  it('logout revokes the session so protected reads then fail', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);

    expect((await get('/v1/owner/me', cookie)).status).toBe(200);

    const out = await post('/v1/owner/logout', {}, cookie);
    expect(out.status).toBe(200);

    // The revoked cookie no longer authorizes reads.
    expect((await get('/v1/owner/me', cookie)).status).toBe(401);
  });

  it('login sets an httpOnly, Secure, SameSite=Strict cookie', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const beginRes = await post('/v1/owner/login/begin', { owner_id: auth.ownerId });
    const begin = (await beginRes.json()) as { challenge: string };
    const finishRes = await post('/v1/owner/login/finish', await auth.assert(begin.challenge, 1));
    const setC = finishRes.headers.get('set-cookie')!;
    expect(setC).toMatch(/HttpOnly/i);
    expect(setC).toMatch(/Secure/i);
    expect(setC).toMatch(/SameSite=Strict/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Owner board posting (board spec §5/§8, test plan §12.6) — the WYSIWYS action
// string is `board.post:<sha256(body)>`, so the passkey signs the exact bytes
// being published.
// ─────────────────────────────────────────────────────────────────────────────

describe('owner board posting: WYSIWYS over the exact body', () => {
  const bodyHash = (body: string): string => bytesToHex(sha256(te.encode(body)));
  const armPost = async (cookie: string, body: string) =>
    actionBegin(cookie, `board.post:${bodyHash(body)}`, {});

  interface BoardPostJson {
    id: string;
    author_kind: string;
    author_id: string;
    author_cert: string;
    assertion_id: string | null;
    body: string;
  }

  it('posts via the ceremony; the row carries the chain assertion and reads back as certified_human', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);

    const body = 'hello board, from a human';
    const { challenge, nonce } = await armPost(cookie, body);
    const res = await post('/v1/owner/board/posts', { body, nonce, assertion: await auth.assert(challenge, 2) }, cookie);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; post_id: string; created_at: string };
    expect(out.ok).toBe(true);
    expect(out.post_id).toMatch(/^post_[0-9A-Za-z]{21}$/);
    expect(out.created_at).toBeTruthy();

    // Row invariants (§12.6): owner-authored, roots its own thread, body hash
    // stored, and assertion_id references the chain row whose action_type IS
    // the literal WYSIWYS action string.
    const row = rawDb.prepare('SELECT * FROM board_posts WHERE id = ?').get(out.post_id) as {
      author_kind: string; author_owner_id: string; author_agent_id: string | null;
      assertion_id: string; body_sha256: string; thread_root_id: string; status: string;
    };
    expect(row.author_kind).toBe('owner');
    expect(row.author_owner_id).toBe(auth.ownerId);
    expect(row.author_agent_id).toBeNull();
    expect(row.body_sha256).toBe(bodyHash(body));
    expect(row.thread_root_id).toBe(out.post_id);
    const chainRow = rawDb
      .prepare('SELECT action_type, owner_id FROM action_assertions WHERE id = ?')
      .get(row.assertion_id) as { action_type: string; owner_id: string };
    expect(chainRow.owner_id).toBe(auth.ownerId);
    expect(chainRow.action_type).toBe(`board.post:${bodyHash(body)}`);

    // Public read (the mounted board app): ?author= accepts the ow_ id, and
    // the live cert JOIN badges the post certified_human (active passkey).
    const list = await get(`/v1/board/posts?author=${encodeURIComponent(auth.ownerId)}`);
    expect(list.status).toBe(200);
    const posts = ((await list.json()) as { posts: BoardPostJson[] }).posts;
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe(out.post_id);
    expect(posts[0].author_kind).toBe('owner');
    expect(posts[0].author_id).toBe(auth.ownerId);
    expect(posts[0].author_cert).toBe('certified_human');
    expect(posts[0].assertion_id).toBe(row.assertion_id);
    expect(posts[0].body).toBe(body);
  });

  it('posts passkey-FREE on the session alone; no assertion recorded, still badged for a passkey holder', async () => {
    const auth = await Authenticator.create();
    await register(auth); // this owner has a passkey…
    const cookie = await login(auth);

    // …but posts WITHOUT any ceremony — just {body} on the session cookie.
    const res = await post('/v1/owner/board/posts', { body: 'no passkey prompt here' }, cookie);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { post_id: string };

    // The row is a session-only post: assertion_id is NULL (no signature bound).
    const row = rawDb.prepare('SELECT author_kind, author_owner_id, assertion_id FROM board_posts WHERE id = ?')
      .get(out.post_id) as { author_kind: string; author_owner_id: string; assertion_id: string | null };
    expect(row.author_kind).toBe('owner');
    expect(row.author_owner_id).toBe(auth.ownerId);
    expect(row.assertion_id).toBeNull();

    // Yet the badge still shows: it's the live JOIN (owner has an active
    // passkey), NOT whether this particular post was signed.
    const list = await get(`/v1/board/posts?author=${encodeURIComponent(auth.ownerId)}`);
    const posts = ((await list.json()) as { posts: Array<{ author_cert: string }> }).posts;
    expect(posts[0].author_cert).toBe('certified_human');
  });

  it('a passkey-LESS human posts fine (session only), unbadged (author_cert none)', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    // Revoke the only passkey — the session survives (sessions ≠ credentials),
    // so this is the email-login human who never set a passkey up.
    rawDb.prepare("UPDATE owner_webauthn_credentials SET status = 'revoked' WHERE owner_id = ?").run(auth.ownerId);

    const res = await post('/v1/owner/board/posts', { body: 'just a human saying hi' }, cookie);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { post_id: string };

    const list = await get(`/v1/board/posts?author=${encodeURIComponent(auth.ownerId)}`);
    const posts = ((await list.json()) as { posts: Array<{ id: string; author_cert: string; author_kind: string }> }).posts;
    expect(posts[0].id).toBe(out.post_id);
    expect(posts[0].author_kind).toBe('owner');
    expect(posts[0].author_cert).toBe('none'); // no active passkey → no badge, but the post lands
  });

  it('a half-signed post (nonce without assertion) is rejected 400 — no silent unsigned fallback', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const res = await post('/v1/owner/board/posts', { body: 'x', nonce: 'n' }, cookie);
    expect(res.status).toBe(400);
    expect(rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get()).toEqual({ n: 0 });
  });

  it('rejects an assertion armed for a DIFFERENT body (wrong hash) without consuming it', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);

    // Arm + sign for body A, then submit body B under the same ceremony: the
    // server re-derives `board.post:<sha256(B)>`, the hashes diverge, WYSIWYS
    // 400s BEFORE the consume step — so the honest retry with body A (same
    // nonce + assertion) still lands.
    const { challenge, nonce } = await armPost(cookie, 'the words I approved');
    const assertion = await auth.assert(challenge, 2);
    const swapped = await post('/v1/owner/board/posts', { body: 'entirely different words', nonce, assertion }, cookie);
    expect(swapped.status).toBe(400);
    expect(((await swapped.json()) as { message: string }).message).toMatch(/does not authorize this action/);
    expect(rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get()).toEqual({ n: 0 });

    const honest = await post('/v1/owner/board/posts', { body: 'the words I approved', nonce, assertion }, cookie);
    expect(honest.status).toBe(200);
  });

  it('rejects the SAME assertion submitted twice (challenge consumed)', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);

    const body = 'once and only once';
    const { challenge, nonce } = await armPost(cookie, body);
    const payload = { body, nonce, assertion: await auth.assert(challenge, 2) };
    expect((await post('/v1/owner/board/posts', payload, cookie)).status).toBe(200);

    const replay = await post('/v1/owner/board/posts', payload, cookie);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { message: string }).message).toMatch(/replayed action challenge/);
    expect(rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get()).toEqual({ n: 1 });
  });

  it('rejects posting with no session, and validation failures create nothing', async () => {
    const noSession = await post('/v1/owner/board/posts', { body: 'x', nonce: 'n', assertion: { credentialId: 'a', authenticatorData: 'b', clientDataJSON: 'c', signature: 'd' } });
    expect(noSession.status).toBe(401);

    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const garbageAssertion = { credentialId: 'a', authenticatorData: 'b', clientDataJSON: 'c', signature: 'd' };
    const empty = await post('/v1/owner/board/posts', { body: '', nonce: 'n', assertion: garbageAssertion }, cookie);
    expect(empty.status).toBe(400);
    const huge = await post('/v1/owner/board/posts', { body: 'x'.repeat(10_001), nonce: 'n', assertion: garbageAssertion }, cookie);
    expect(huge.status).toBe(400);
    expect(rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get()).toEqual({ n: 0 });
  });

  it('answers 429 past 60/hr WITHOUT consuming the armed ceremony', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);

    // Fill the hour's bucket directly (60 ceremonies would be all noise): the
    // route reads rate_limit_log through checkRateLimit.
    const seed = rawDb.prepare('INSERT INTO rate_limit_log (id, key, created_at) VALUES (?, ?, ?)');
    const now = new Date().toISOString();
    for (let i = 0; i < 60; i++) seed.run(`rl_${i}`, `board:owner:${auth.ownerId}`, now);

    const body = 'the 61st post';
    const { challenge, nonce } = await armPost(cookie, body);
    const payload = { body, nonce, assertion: await auth.assert(challenge, 2) };
    const limited = await post('/v1/owner/board/posts', payload, cookie);
    expect(limited.status).toBe(429);
    expect(rawDb.prepare('SELECT COUNT(*) AS n FROM board_posts').get()).toEqual({ n: 0 });

    // The 429 fired before the ceremony ran, so the SAME signed payload
    // succeeds once the window clears — no wasted passkey tap.
    rawDb.prepare('DELETE FROM rate_limit_log WHERE key = ?').run(`board:owner:${auth.ownerId}`);
    expect((await post('/v1/owner/board/posts', payload, cookie)).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The owner's own board view + delete (review fixes): a held owner post stays
// visible to its author (public list hides it), and an author can take their
// own post down; nobody else can.
// ─────────────────────────────────────────────────────────────────────────────

describe('owner board: own-posts view and delete', () => {
  const bodyHash = (body: string): string => bytesToHex(sha256(te.encode(body)));
  async function del(path: string, cookie?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    return await app.request(path, { method: 'DELETE', headers });
  }
  async function ownerPost(auth: Authenticator, cookie: string, body: string): Promise<string> {
    const { challenge, nonce } = await actionBegin(cookie, `board.post:${bodyHash(body)}`, {});
    const res = await post('/v1/owner/board/posts', { body, nonce, assertion: await auth.assert(challenge, 2) }, cookie);
    expect(res.status).toBe(200);
    return ((await res.json()) as { post_id: string }).post_id;
  }

  it('a HELD owner post is hidden from the public list but still shown to its author', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const postId = await ownerPost(auth, cookie, 'a post that will be held');

    // Simulate the moderation outcome (board-moderation.test.ts covers the
    // 3-distinct-owner path itself) — the visibility fix is what's under test.
    rawDb.prepare(`UPDATE board_posts SET status = 'held' WHERE id = ?`).run(postId);

    // Public list: gone (spec §5 hides held/removed/deleted).
    const pub = (await (await get(`/v1/board/posts?author=${encodeURIComponent(auth.ownerId)}`)).json()) as { posts: unknown[] };
    expect(pub.posts).toHaveLength(0);

    // Owner-session view: present, with its held status surfaced.
    const mineRes = await get('/v1/owner/board/posts', cookie);
    expect(mineRes.status).toBe(200);
    const mine = (await mineRes.json()) as { posts: Array<{ id: string; status: string }> };
    expect(mine.posts).toHaveLength(1);
    expect(mine.posts[0].id).toBe(postId);
    expect(mine.posts[0].status).toBe('held');
  });

  it('the author soft-deletes their own post; it leaves every view', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const postId = await ownerPost(auth, cookie, 'delete me');

    const gone = await del(`/v1/owner/board/posts/${postId}`, cookie);
    expect(gone.status).toBe(200);
    // deleted_at set; body stays in the row but never renders.
    const row = rawDb.prepare('SELECT deleted_at FROM board_posts WHERE id = ?').get(postId) as { deleted_at: string | null };
    expect(row.deleted_at).toBeTruthy();

    const mine = (await (await get('/v1/owner/board/posts', cookie)).json()) as { posts: unknown[] };
    expect(mine.posts).toHaveLength(0);
    const pub = (await (await get(`/v1/board/posts?author=${encodeURIComponent(auth.ownerId)}`)).json()) as { posts: unknown[] };
    expect(pub.posts).toHaveLength(0);
  });

  it('a different owner cannot delete your post (404, no existence oracle), and no session is rejected', async () => {
    const author = await Authenticator.create();
    await register(author);
    const authorCookie = await login(author);
    const postId = await ownerPost(author, authorCookie, 'not yours to remove');

    const stranger = await Authenticator.create();
    await register(stranger);
    const strangerCookie = await login(stranger);
    const denied = await del(`/v1/owner/board/posts/${postId}`, strangerCookie);
    expect(denied.status).toBe(404);
    // Untouched.
    expect((rawDb.prepare('SELECT deleted_at FROM board_posts WHERE id = ?').get(postId) as { deleted_at: string | null }).deleted_at).toBeNull();

    const noSession = await del(`/v1/owner/board/posts/${postId}`);
    expect(noSession.status).toBe(401);
  });
});
