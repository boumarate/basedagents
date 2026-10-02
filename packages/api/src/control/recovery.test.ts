/**
 * Recovery-flow tests (CONTROL_PLANE.md §6): magic link + recovery code →
 * passkey rotation. PROPRIETARY control-plane code — see ./LICENSE.
 *
 * The properties under test:
 *   - issuing a recovery code is itself a passkey ACTION (fresh assertion);
 *   - recovery needs BOTH factors — token alone or code alone gets a uniform 401;
 *   - a completed recovery enrolls the new passkey and revokes every other
 *     passkey AND every live session (the old passkey can neither log in nor
 *     sign actions afterwards);
 *   - both factors and the WebAuthn challenge are single-use (atomic consume);
 *   - /recover/begin never reveals whether an email exists;
 *   - regenerating a code supersedes the old one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import * as ed from '@noble/ed25519';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { AppEnv } from '../types/index.js';
import { sha256, base58Encode, bytesToHex } from '../crypto/index.js';
import { base64urlEncode, base64urlDecode } from './webauthn.js';
import { ownerIdFromVaultPubkey } from './identity.js';
import { ControlStore } from './store.js';
import type { EmailMessage } from './email.js';
import ownerRoutes from './routes.js';
import recoveryRoutes from './recovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
const SQL_0023 = readFileSync(join(MIGRATIONS, '0023_owner_accounts.sql'), 'utf-8');
const SQL_0025 = readFileSync(join(MIGRATIONS, '0025_owner_recovery.sql'), 'utf-8');
const SQL_0026 = readFileSync(join(MIGRATIONS, '0026_owner_billing.sql'), 'utf-8');
const SQL_0027 = readFileSync(join(MIGRATIONS, '0027_authority_ladder.sql'), 'utf-8');
const SQL_0032 = readFileSync(join(MIGRATIONS, '0032_daemon_kill_confirm.sql'), 'utf-8');
const SQL_0048 = readFileSync(join(MIGRATIONS, '0048_retire_keyring.sql'), 'utf-8');

const te = new TextEncoder();
const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';

// ─── byte helpers (mirrors approvals.test.ts) ───

type CborType = Parameters<typeof isoCBOR.encode>[0];

function concat(...arrs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function u32be(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const enc = (part: Uint8Array): number[] => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    const body = part[i] & 0x80 ? [0, ...Array.from(part.slice(i))] : Array.from(part.slice(i));
    return [0x02, body.length, ...body];
  };
  const r = enc(raw.slice(0, 32));
  const s = enc(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function signDer(privateKey: CryptoKey, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message);
  return rawToDer(new Uint8Array(raw));
}

// ─── simulated ES256 authenticator ───

class Authenticator {
  private constructor(
    private privateKey: CryptoKey,
    readonly cose: Uint8Array,
    readonly credentialId: string,
    readonly vaultB58: string,
    readonly ownerId: string,
  ) {}

  static async create(existing?: { vaultB58: string; ownerId: string }): Promise<Authenticator> {
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

    // `existing` = a NEW authenticator for the SAME owner (the recovery device).
    let vaultB58: string, ownerId: string;
    if (existing) {
      ({ vaultB58, ownerId } = existing);
    } else {
      const vaultPriv = ed.utils.randomPrivateKey();
      const vaultPub = await ed.getPublicKeyAsync(vaultPriv);
      vaultB58 = base58Encode(vaultPub);
      ownerId = ownerIdFromVaultPubkey(vaultPub);
    }
    return new Authenticator(kp.privateKey, cose, base64urlEncode(rawId), vaultB58, ownerId);
  }

  registration(challenge: string, origin: string = ORIGIN): { attestationObject: string; clientDataJSON: string } {
    const rpIdHash = sha256(te.encode(RP_ID));
    const credIdBytes = base64urlDecode(this.credentialId);
    const credIdLen = new Uint8Array([(credIdBytes.length >> 8) & 0xff, credIdBytes.length & 0xff]);
    const attested = concat(new Uint8Array(16), credIdLen, credIdBytes, this.cose);
    const authData = concat(rpIdHash, new Uint8Array([0x5d]), u32be(0), attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, CborType>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, CborType>()],
        ['authData', authData],
      ]) as CborType,
    );
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false });
    return {
      attestationObject: base64urlEncode(attestationObject),
      clientDataJSON: base64urlEncode(te.encode(clientDataJSON)),
    };
  }

  async assert(challenge: string, counter: number) {
    const rpIdHash = sha256(te.encode(RP_ID));
    const authData = concat(rpIdHash, new Uint8Array([0x05]), u32be(counter));
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

// ─── app + db harness (with a recording email sink) ───

let rawDb: Database.Database;
let db: SQLiteAdapter;
let app: Hono<AppEnv>;
let store: ControlStore;
let sentEmails: EmailMessage[];

function buildApp(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', db);
    // Injected recording sender — recovery routes prefer this over env.
    (c.set as (k: string, v: unknown) => void)('emailSender', {
      send: async (m: EmailMessage) => {
        sentEmails.push(m);
      },
    });
    await next();
  });
  a.route('/v1/owner', ownerRoutes);
  a.route('/v1/owner', recoveryRoutes);
  return a;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie) headers.Cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  return app.request(path, { method: 'GET', headers });
}

function sessionCookie(res: Response): string {
  const setC = res.headers.get('set-cookie');
  if (!setC) throw new Error('no Set-Cookie header');
  const m = /ba_owner_session=([^;]+)/.exec(setC);
  if (!m) throw new Error('session cookie not found');
  return `ba_owner_session=${m[1]}`;
}

async function register(auth: Authenticator, email?: string): Promise<void> {
  const beginRes = await post('/v1/owner/register/begin', { vault_public_key: auth.vaultB58, email });
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

async function login(auth: Authenticator, counter: number): Promise<{ res: Response; cookie?: string }> {
  const beginRes = await post('/v1/owner/login/begin', { owner_id: auth.ownerId });
  if (beginRes.status !== 200) return { res: beginRes };
  const begin = (await beginRes.json()) as { challenge: string };
  const assertion = await auth.assert(begin.challenge, counter);
  const res = await post('/v1/owner/login/finish', assertion);
  return { res, cookie: res.status === 200 ? sessionCookie(res) : undefined };
}

/** Issue a recovery code via the full generate_recovery_code ceremony. */
async function generateCode(auth: Authenticator, cookie: string, counter: number): Promise<string> {
  const beginRes = await post('/v1/owner/action/begin', { action_type: 'generate_recovery_code', params: {} }, cookie);
  expect(beginRes.status).toBe(200);
  const begin = (await beginRes.json()) as { challenge: string; nonce: string };
  const assertion = await auth.assert(begin.challenge, counter);
  const res = await post('/v1/owner/recovery-code', { nonce: begin.nonce, assertion }, cookie);
  expect(res.status).toBe(200);
  const out = (await res.json()) as { recovery_code: string };
  expect(out.recovery_code).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
  return out.recovery_code;
}

/** Extract the magic-link token from the last captured email. */
function tokenFromEmail(): string {
  const last = sentEmails[sentEmails.length - 1];
  expect(last).toBeTruthy();
  const m = /#t=([A-Za-z0-9_-]+)/.exec(last.text);
  expect(m).toBeTruthy();
  return m![1];
}

beforeEach(() => {
  rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  // Minimal agents table so the delegations FK (0023/0027 rebuild) resolves.
  rawDb.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY, public_key BLOB, name TEXT,
    status TEXT NOT NULL DEFAULT 'active', registered_at TEXT
  );`);
  rawDb.exec(SQL_0023);
  rawDb.exec(SQL_0025);
  rawDb.exec(SQL_0026);
  rawDb.exec(SQL_0027);
  rawDb.exec(SQL_0032);
  rawDb.exec(SQL_0048);
  db = new SQLiteAdapter(rawDb);
  store = new ControlStore(db);
  sentEmails = [];
  app = buildApp();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('recovery-code issuance (a passkey ACTION)', () => {
  it('issues a code via the ceremony, surfaces status in /me, supersedes on regenerate', async () => {
    const auth = await Authenticator.create();
    await register(auth, 'max@example.com');
    const { cookie } = await login(auth, 1);

    const code1 = await generateCode(auth, cookie!, 2);

    const me = (await (await get('/v1/owner/me', cookie)).json()) as { recovery_code: { created_at: string } | null };
    expect(me.recovery_code).not.toBeNull();

    // Regenerate → the first code is superseded and can no longer be consumed.
    const code2 = await generateCode(auth, cookie!, 3);
    expect(code2).not.toBe(code1);
    const norm = (s: string) => s.replace(/[\s-]/g, '').toLowerCase();
    const hex = (s: string) => bytesToHex(sha256(te.encode(s)));
    expect(await store.consumeRecoveryCode(auth.ownerId, hex(norm(code1)), new Date().toISOString())).toBe(false);
    expect(await store.peekRecoveryCode(auth.ownerId, hex(norm(code2)))).toBe(true);
  });

  it('rejects issuance without a session', async () => {
    const res = await post('/v1/owner/recovery-code', { nonce: 'n', assertion: { credentialId: 'x', authenticatorData: 'x', clientDataJSON: 'x', signature: 'x' } });
    expect(res.status).toBe(401);
  });
});

describe('the full recovery: magic link + code → rotation', () => {
  it('enrolls a new passkey, revokes the old one and all sessions', async () => {
    const oldDevice = await Authenticator.create();
    await register(oldDevice, 'max@example.com');
    const { cookie } = await login(oldDevice, 1);
    const code = await generateCode(oldDevice, cookie!, 2);

    // Begin: the email carries the link with the token.
    const beginRes = await post('/v1/owner/recover/begin', { email: 'max@example.com' });
    expect(beginRes.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('max@example.com');
    const token = tokenFromEmail();

    // Options: both factors validate → registration options for the NEW passkey.
    const optRes = await post('/v1/owner/recover/options', { token, recovery_code: code });
    expect(optRes.status).toBe(200);
    const opt = (await optRes.json()) as { owner_id: string; options: { challenge: string } };
    expect(opt.owner_id).toBe(oldDevice.ownerId);

    // Finish: a brand-new authenticator for the same owner.
    const newDevice = await Authenticator.create({ vaultB58: oldDevice.vaultB58, ownerId: oldDevice.ownerId });
    const reg = newDevice.registration(opt.options.challenge);
    const finRes = await post('/v1/owner/recover/finish', {
      token,
      recovery_code: code,
      attestationObject: reg.attestationObject,
      clientDataJSON: reg.clientDataJSON,
    });
    expect(finRes.status).toBe(200);
    const fin = (await finRes.json()) as { revoked_passkeys: number; credential_id: string };
    expect(fin.revoked_passkeys).toBe(1);

    // The old session is dead.
    expect((await get('/v1/owner/me', cookie)).status).toBe(401);

    // The old passkey can no longer log in (its credential is revoked)…
    const oldLogin = await login(oldDevice, 5);
    expect(oldLogin.res.status).toBe(401);

    // …but the new one can, and can sign actions.
    const newLogin = await login(newDevice, 1);
    expect(newLogin.res.status).toBe(200);
    const code2 = await generateCode(newDevice, newLogin.cookie!, 2);
    expect(code2).toMatch(/^[0-9a-f]{8}/);

    // Replayed finish: every factor is consumed → uniform 401.
    const replay = await post('/v1/owner/recover/finish', {
      token,
      recovery_code: code,
      attestationObject: reg.attestationObject,
      clientDataJSON: reg.clientDataJSON,
    });
    expect(replay.status).toBe(401);
  });
});

describe('adversarial: factor isolation and enumeration', () => {
  async function seed(): Promise<{ auth: Authenticator; code: string }> {
    const auth = await Authenticator.create();
    await register(auth, 'max@example.com');
    const { cookie } = await login(auth, 1);
    const code = await generateCode(auth, cookie!, 2);
    return { auth, code };
  }

  it('begin never reveals whether the email exists (and sends nothing for unknowns)', async () => {
    await seed();
    sentEmails = [];
    const res = await post('/v1/owner/recover/begin', { email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ ok: true });
    expect(sentEmails).toHaveLength(0);
  });

  it('the token alone is not enough (wrong code → 401, nothing consumed)', async () => {
    const { code } = await seed();
    await post('/v1/owner/recover/begin', { email: 'max@example.com' });
    const token = tokenFromEmail();

    const bad = await post('/v1/owner/recover/options', { token, recovery_code: '00000000-00000000-00000000-00000000' });
    expect(bad.status).toBe(401);

    // The real factors still work afterwards — the failed guess burned nothing.
    const ok = await post('/v1/owner/recover/options', { token, recovery_code: code });
    expect(ok.status).toBe(200);
  });

  it('the code alone is not enough (bad/expired token → 401)', async () => {
    const { code } = await seed();
    const bad = await post('/v1/owner/recover/options', { token: 'forged-token', recovery_code: code });
    expect(bad.status).toBe(401);

    // Expire the real token behind its back → 401 too.
    await post('/v1/owner/recover/begin', { email: 'max@example.com' });
    const token = tokenFromEmail();
    rawDb.prepare(`UPDATE owner_recovery_tokens SET expires_at = ?`).run(new Date(Date.now() - 1000).toISOString());
    const expired = await post('/v1/owner/recover/options', { token, recovery_code: code });
    expect(expired.status).toBe(401);
  });

  it('a code superseded by regeneration cannot recover', async () => {
    const { auth, code } = await seed();
    const { cookie } = await login(auth, 3);
    await generateCode(auth, cookie!, 4); // supersedes `code`

    await post('/v1/owner/recover/begin', { email: 'max@example.com' });
    const token = tokenFromEmail();
    const res = await post('/v1/owner/recover/options', { token, recovery_code: code });
    expect(res.status).toBe(401);
  });

  it('a failed crypto finish burns only the challenge, never the factors', async () => {
    const { auth, code } = await seed();
    await post('/v1/owner/recover/begin', { email: 'max@example.com' });
    const token = tokenFromEmail();

    const optRes = await post('/v1/owner/recover/options', { token, recovery_code: code });
    const opt = (await optRes.json()) as { options: { challenge: string } };

    // Correct challenge but a DISALLOWED ORIGIN → verifyRegistration throws
    // (attestation fmt 'none' carries no signature, so origin/rpId/challenge
    // are the registration's actual security checks). The single-use challenge
    // was consumed before the verify — that is the deliberate ordering.
    const phisher = await Authenticator.create({ vaultB58: auth.vaultB58, ownerId: auth.ownerId });
    const forged = phisher.registration(opt.options.challenge, 'https://evil.example.com');
    const failRes = await post('/v1/owner/recover/finish', {
      token,
      recovery_code: code,
      attestationObject: forged.attestationObject,
      clientDataJSON: forged.clientDataJSON,
    });
    expect(failRes.status).toBe(401);

    // Factors survive: a fresh options + honest finish still completes.
    const opt2Res = await post('/v1/owner/recover/options', { token, recovery_code: code });
    expect(opt2Res.status).toBe(200);
    const opt2 = (await opt2Res.json()) as { options: { challenge: string } };
    const newDevice = await Authenticator.create({ vaultB58: auth.vaultB58, ownerId: auth.ownerId });
    const reg = newDevice.registration(opt2.options.challenge);
    const finRes = await post('/v1/owner/recover/finish', {
      token,
      recovery_code: code,
      attestationObject: reg.attestationObject,
      clientDataJSON: reg.clientDataJSON,
    });
    expect(finRes.status).toBe(200);
  });
});
