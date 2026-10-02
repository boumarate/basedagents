/**
 * Owner console HTTP routes for the Keyring control plane.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * This is the security-critical COMPOSITION of the already-built primitives
 * (ControlStore, identity, webauthn) into the authority model of CONTROL_PLANE.md:
 *
 *   §3  "sessions to look, signatures to act": passkey login mints a read-only
 *       httpOnly SameSite=Strict session cookie ({@link ownerSession}); every
 *       MUTATING action additionally requires a FRESH WebAuthn assertion whose
 *       signed challenge is the hash of the exact action ({@link verifyAndRecordAction}).
 *   §4  atomicity: single-use challenge consume + monotonic counter bump are the
 *       store's atomic conditional writes; the routes only sequence them.
 *   §5  every mutating row references the hash-chained action assertion that
 *       authorized it.
 *   §7  RP ID / origin allow-list from {@link rpConfig}.
 *
 * Mounted by the coordinator at /v1/owner.
 */
import { isAdminOwner } from './admin-ids.js';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';
import { ControlStore } from './store.js';
import type { ActionAssertionRow } from './store.js';
import { rpConfig } from './config.js';
import { ownerIdFromVaultPubkey } from './identity.js';
import {
  actionChallenge,
  verifyRegistration,
  verifyAssertion,
  base64urlEncode,
  base64urlDecode,
} from './webauthn.js';
import { insertOwnerBoardPost, OWNER_BOARD_HOURLY } from '../mcp/board-post.js';
import { authorSqlParts, mapPost, type PostRow } from '../routes/board.js';
import { base58Encode, base58Decode, sha256, bytesToHex, canonicalJsonStringify } from '../crypto/index.js';

// ─── small helpers ───

const SESSION_COOKIE = 'ba_owner_session';
// Look-session lifetime — generous BECAUSE the ladder splits authority
// ("sessions to look, signatures to act", §3): a session only reads; every
// mutation takes a fresh passkey ceremony, and recovery revokes all sessions
// server-side. SESSION_TTL_DAYS (integer, 1–365) overrides per deployment.
const SESSION_TTL_DAYS_DEFAULT = 14;

function sessionTtlSeconds(env: unknown): number {
  const raw = ((env ?? {}) as Record<string, string | undefined>).SESSION_TTL_DAYS;
  const days = parseInt(raw ?? '', 10);
  return (Number.isFinite(days) && days >= 1 && days <= 365 ? days : SESSION_TTL_DAYS_DEFAULT) * 86_400;
}
const CHALLENGE_TTL_SECONDS = 300; // 5m

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** sha256 hex of a utf-8 string (session token hashing, etc.). */
function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getStore(c: Context<AppEnv>): ControlStore {
  return new ControlStore(c.get('db'));
}

// ownerId is a control-plane-only context var. We keep it OUT of the shared
// AppEnv Variables (src/types) and stash/read it with a cast (CONTROL_PLANE
// scope stays local to this file).
function setOwnerId(c: Context<AppEnv>, ownerId: string): void {
  (c.set as (k: string, v: unknown) => void)('ownerId', ownerId);
}
function getOwnerId(c: Context<AppEnv>): string {
  return (c.get as (k: string) => string)('ownerId');
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { message?: unknown; code?: unknown };
  const msg = typeof err?.message === 'string' ? err.message : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  return msg.includes('UNIQUE constraint failed') || code.includes('SQLITE_CONSTRAINT');
}

/** base64url of the utf-8 bytes of a string (WebAuthn user.id). */
function base64urlUtf8(s: string): string {
  return base64urlEncode(textEncoder.encode(s));
}

/**
 * Pull the `challenge` field out of a base64url clientDataJSON. Returns null on
 * any decode/parse error or when `challenge` is not a string.
 */
function extractChallenge(clientDataJSONb64u: string): string | null {
  try {
    const obj = JSON.parse(textDecoder.decode(base64urlDecode(clientDataJSONb64u))) as {
      challenge?: unknown;
    };
    return typeof obj.challenge === 'string' ? obj.challenge : null;
  } catch {
    return null;
  }
}

function err(c: Context<AppEnv>, status: 400 | 401 | 404 | 409, error: string, message: string) {
  return c.json({ error, message }, status);
}

async function parseJson(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json();
}

// ─── validation schemas ───

// Exported so sibling control-plane sub-apps (e.g. ./approvals.ts) validate the
// owner assertion identically instead of redeclaring the shape.
export const AssertionSchema = z.object({
  credentialId: z.string().min(1),
  authenticatorData: z.string().min(1),
  clientDataJSON: z.string().min(1),
  signature: z.string().min(1),
});
export type Assertion = z.infer<typeof AssertionSchema>;

const RegisterBeginSchema = z.object({
  vault_public_key: z.string().min(1),
  email: z.string().email().optional(),
});

const RegisterFinishSchema = z.object({
  vault_public_key: z.string().min(1),
  attestationObject: z.string().min(1),
  clientDataJSON: z.string().min(1),
  transports: z.array(z.string()).optional(),
});

const LoginBeginSchema = z
  .object({ owner_id: z.string().min(1).optional(), email: z.string().email().optional() })
  .refine((v) => !!v.owner_id || !!v.email, { message: 'owner_id or email required' });

const LoginFinishSchema = z.object({
  credentialId: z.string().min(1),
  authenticatorData: z.string().min(1),
  clientDataJSON: z.string().min(1),
  signature: z.string().min(1),
});

const ActionBeginSchema = z.object({
  action_type: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

// Finish requests echo the server-issued per-ceremony `nonce` from /action/begin.
// The nonce is folded into the signed canonical action so each ceremony's
// action_hash is unique — single-use consumption then defeats assertion replay
// even for authenticators that report a static signature counter of 0.

const CreateDelegationSchema = z.object({
  agent_id: z.string().min(1),
  label: z.string().optional(),
  nonce: z.string().min(1),
  assertion: AssertionSchema,
});

const RevokeSchema = z.object({ nonce: z.string().min(1), assertion: AssertionSchema });

const OwnerBoardPostSchema = z.object({
  // Same 1..10000 bound as agent board posts (BoardPostSchema) and DM bodies —
  // one mental model for "how much can I say" everywhere.
  body: z.string().min(1).max(10000),
  // A board post is speech, not an authority grant, so the passkey signature
  // is OPTIONAL here — the one place "signatures to act" is deliberately
  // relaxed (real authority actions — approving keys, the kill switch — still
  // demand it). A logged-in session is enough to post; when BOTH nonce and
  // assertion are present we still run the WYSIWYS ceremony and record the
  // assertion, so a passkey holder keeps the stronger provenance. Whether the
  // post shows the "Verified human" badge is decided independently at read
  // time by the live certification JOIN (does this owner hold an active
  // passkey?), NOT by whether this particular post was signed.
  nonce: z.string().min(1).optional(),
  assertion: AssertionSchema.optional(),
});

// ─── owner id derivation ───

/** Derive the owner id from a base58 Ed25519 vault pubkey; null on any error. */
function ownerIdFromVaultB58(vaultPublicKey: string): string | null {
  try {
    return ownerIdFromVaultPubkey(base58Decode(vaultPublicKey));
  } catch {
    return null;
  }
}

// ─── action-challenge arming (see note) ───
//
// NOTE / DELIBERATE DEVIATION: store.createChallenge() hardcodes a RANDOM
// challenge value and exposes no override. For the action ceremony the stored
// `challenge` column MUST equal the action_hash, because (a) that is the value
// the authenticator signs (CONTROL_PLANE.md §2/§3 + webauthn.ts:actionChallenge,
// "used as BOTH the WebAuthn challenge and webauthn_challenges.action_hash") and
// (b) verifyAndRecordAction consumes by action_hash. So for purpose='action' we
// insert the challenge row directly (challenge = action_hash), reusing the
// store's ATOMIC single-use consumeChallenge for the security-critical guard.
// register/login keep using store.createChallenge (random challenge is correct
// there). DELETE-then-INSERT makes /action/begin idempotently re-armable and
// sidesteps the UNIQUE(challenge) constraint on the deterministic action_hash.
export async function armActionChallenge(
  db: DBAdapter,
  ownerId: string,
  actionType: string,
  actionHash: string,
): Promise<void> {
  const id = 'chl_' + base58Encode(randomBytes(16));
  const created = new Date();
  const createdAt = created.toISOString();
  const expiresAt = new Date(created.getTime() + CHALLENGE_TTL_SECONDS * 1000).toISOString();
  await db.run('DELETE FROM webauthn_challenges WHERE challenge = ?', actionHash);
  await db.run(
    `INSERT INTO webauthn_challenges
       (id, owner_id, challenge, purpose, action_type, action_hash, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, 'action', ?, ?, ?, ?, NULL)`,
    id,
    ownerId,
    actionHash,
    actionType,
    actionHash,
    createdAt,
    expiresAt,
  );
}

// ─── session minting (shared by passkey login and the ladder's magic links) ───

/**
 * Mint a look-session for `ownerId` and set the httpOnly cookie. `method`
 * records the ladder rung ('passkey' | 'email') — both rungs LOOK identically;
 * every act still requires a fresh WebAuthn assertion regardless.
 */
export async function mintSession(
  c: Context<AppEnv>,
  ownerId: string,
  opts: { method: 'passkey' | 'email'; credentialId?: string },
): Promise<void> {
  const store = getStore(c);
  const ttlSeconds = sessionTtlSeconds(c.env);
  const token = base64urlEncode(randomBytes(32));
  await store.createSession({
    ownerId,
    tokenHash: sha256hex(token),
    credentialId: opts.credentialId,
    method: opts.method,
    ttlSeconds,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: ttlSeconds,
  });
}

// ─── ownerSession middleware ("sessions to look") ───

/**
 * Read the httpOnly session cookie, resolve a live (unrevoked, unexpired)
 * session, touch it, and stash the owner id for the handler. 401 otherwise.
 * This grants READ-ONLY authority only — every mutation additionally requires a
 * fresh action assertion (CONTROL_PLANE.md §3).
 */
export const ownerSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return err(c, 401, 'unauthorized', 'no session');
  const store = getStore(c);
  const session = await store.getSessionByTokenHash(sha256hex(token));
  if (!session) return err(c, 401, 'unauthorized', 'invalid or expired session');
  await store.touchSession(session.id, nowIso());
  setOwnerId(c, session.owner_id);
  (c.set as (k: string, v: unknown) => void)('sessionMethod', session.method);
  // Analytics identity — the stable owner id (never the email; PII stays out
  // of PostHog).
  c.set('posthogDistinctId', session.owner_id);
  await next();
};

// ─── the shared action ceremony ("signatures to act") ───

type ActionOutcome =
  | { ok: true; row: ActionAssertionRow }
  | { ok: false; res: Response };

/**
 * Verify a fresh WebAuthn assertion authorizes EXACTLY `canonical`, then record
 * it on the owner's hash chain. Ordering is security-critical:
 *
 *   1. action_hash = actionChallenge(canonical).
 *   2. the assertion's signed challenge MUST equal action_hash (WYSIWYS) — else
 *      400, WITHOUT consuming (a wrong-action assertion never burns the real
 *      action's challenge).
 *   3. CONSUME the single-use challenge FIRST (atomic) — a replay loses here.
 *   4. the signing credential must exist AND belong to this session's owner.
 *   5. verify the WebAuthn signature over action_hash (origin/rpId/UP/etc).
 *   6. bump the signature counter atomically — a clone (counter regression) fails.
 *   7. append the assertion to the owner's tamper-evident chain; return the row.
 */
export async function verifyAndRecordAction(
  c: Context<AppEnv>,
  ownerId: string,
  actionType: string,
  canonical: string,
  assertion: Assertion,
): Promise<ActionOutcome> {
  const store = getStore(c);
  const { rpId, origins } = rpConfig(c.env);
  const action_hash = actionChallenge(canonical);

  // 2. WYSIWYS: the thing they signed must be THIS action's hash.
  const signed = extractChallenge(assertion.clientDataJSON);
  if (signed !== action_hash) {
    return { ok: false, res: err(c, 400, 'bad_request', 'assertion does not authorize this action') };
  }

  // 3. Consume first (single-use, atomic) — replay-safe.
  const consumed = await store.consumeChallenge(action_hash, 'action', nowIso());
  if (!consumed) {
    return { ok: false, res: err(c, 401, 'unauthorized', 'unknown or replayed action challenge') };
  }

  // 4. Credential must exist and be owned by the session owner.
  const cred = await store.getCredentialByCredentialId(assertion.credentialId);
  if (!cred || cred.owner_id !== ownerId) {
    return { ok: false, res: err(c, 401, 'unauthorized', 'unknown credential for this owner') };
  }

  // 5. Verify the signature (throws on any mismatch).
  let verified;
  try {
    verified = await verifyAssertion({
      credentialId: assertion.credentialId,
      authenticatorData: assertion.authenticatorData,
      clientDataJSON: assertion.clientDataJSON,
      signature: assertion.signature,
      cosePublicKey: cred.public_key,
      expectedChallenge: action_hash,
      expectedOrigin: origins,
      expectedRPID: rpId,
    });
  } catch {
    return { ok: false, res: err(c, 401, 'unauthorized', 'assertion verification failed') };
  }

  // 6. Monotonic counter bump (atomic clone defense).
  const advanced = await store.advanceCounter(cred.id, verified.newCounter);
  if (!advanced) {
    return {
      ok: false,
      res: err(c, 401, 'unauthorized', 'counter regression (possible cloned authenticator)'),
    };
  }

  // 7. Record on the hash chain.
  const row = await store.appendActionAssertion({
    ownerId,
    credentialId: assertion.credentialId,
    actionType,
    actionHash: action_hash,
    authenticatorData: assertion.authenticatorData,
    clientDataJson: assertion.clientDataJSON,
    signature: assertion.signature,
  });
  return { ok: true, row };
}

// ─── the sub-app ───

const app = new Hono<AppEnv>();

// ── Registration ──

app.post('/register/begin', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = RegisterBeginSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const ownerId = ownerIdFromVaultB58(parsed.data.vault_public_key);
  if (!ownerId) return err(c, 400, 'bad_request', 'invalid vault_public_key');

  const store = getStore(c);
  let owner = await store.getOwner(ownerId);
  if (!owner) {
    try {
      owner = await store.createOwner({ ownerId, email: parsed.data.email });
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, 409, 'conflict', 'email already in use');
      throw e;
    }
  }

  // PROOF-OF-ABSENCE gate (the registration mirror of /link's
  // proof-of-possession): this endpoint is unauthenticated and the vault
  // public key is derivable from the PUBLIC owner id, so it may only mint an
  // account's FIRST passkey. Without this check, anyone who learned an owner
  // id could enroll their own passkey on the account and pass every ceremony.
  // Replacing a live passkey requires recovery (mailbox factor + offline
  // code), never a bare id. /register/finish re-enforces this atomically.
  const existing = await store.listCredentials(ownerId);
  if (existing.length > 0) {
    return err(c, 409, 'conflict', 'this account already has a passkey — sign in with it, or replace it through account recovery');
  }

  const { challenge } = await store.createChallenge({
    ownerId,
    purpose: 'register',
    ttlSeconds: CHALLENGE_TTL_SECONDS,
  });

  const name = parsed.data.email || ownerId;
  const { rpId, rpName } = rpConfig(c.env);

  return c.json({
    owner_id: ownerId,
    options: {
      rp: { id: rpId, name: rpName },
      user: { id: base64urlUtf8(ownerId), name, displayName: name },
      challenge,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none',
      excludeCredentials: existing.map((cr) => ({
        type: 'public-key',
        id: cr.credential_id,
        transports: cr.transports ?? undefined,
      })),
      timeout: 60_000,
    },
  });
});

app.post('/register/finish', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = RegisterFinishSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const ownerId = ownerIdFromVaultB58(parsed.data.vault_public_key);
  if (!ownerId) return err(c, 400, 'bad_request', 'invalid vault_public_key');

  const challenge = extractChallenge(parsed.data.clientDataJSON);
  if (!challenge) return err(c, 400, 'bad_request', 'invalid clientDataJSON');

  const store = getStore(c);
  const consumed = await store.consumeChallenge(challenge, 'register', nowIso());
  if (!consumed) return err(c, 401, 'unauthorized', 'unknown or replayed challenge');

  const { rpId, origins } = rpConfig(c.env);
  let reg;
  try {
    reg = await verifyRegistration({
      attestationObject: parsed.data.attestationObject,
      clientDataJSON: parsed.data.clientDataJSON,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
    });
  } catch {
    return err(c, 401, 'unauthorized', 'registration verification failed');
  }

  // First-enrollment ONLY, enforced atomically (see /register/begin): the
  // guarded insert loses when an active credential exists, however the
  // challenge was armed. Recovery replaces a live passkey via its own
  // verified endpoints, never this one.
  let stored;
  try {
    stored = await store.addFirstCredential({
      ownerId,
      credentialId: reg.credentialId,
      publicKey: reg.cosePublicKey,
      counter: reg.counter,
      aaguid: reg.aaguid,
      backedUp: reg.backedUp,
      transports: parsed.data.transports ?? reg.transports,
    });
  } catch (e) {
    if (isUniqueViolation(e)) return err(c, 409, 'conflict', 'credential already registered');
    throw e;
  }
  if (!stored) {
    return err(c, 409, 'conflict', 'this account already has a passkey — replace it through account recovery');
  }

  return c.json({ owner_id: ownerId, credential_id: reg.credentialId });
});

// ── Login ("sessions to look") ──

app.post('/login/begin', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = LoginBeginSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'owner_id or email required');

  const store = getStore(c);
  const owner = parsed.data.owner_id
    ? await store.getOwner(parsed.data.owner_id)
    : await store.getOwnerByEmail(parsed.data.email!);
  if (!owner) return err(c, 404, 'not_found', 'owner not found');

  const { challenge } = await store.createChallenge({
    ownerId: owner.id,
    purpose: 'login',
    ttlSeconds: CHALLENGE_TTL_SECONDS,
  });
  const creds = await store.listCredentials(owner.id);
  const { rpId } = rpConfig(c.env);

  return c.json({
    challenge,
    rpId,
    allowCredentials: creds.map((cr) => ({
      type: 'public-key',
      id: cr.credential_id,
      transports: cr.transports ?? undefined,
    })),
    userVerification: 'preferred',
    timeout: 60_000,
  });
});

app.post('/login/finish', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = LoginFinishSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const challenge = extractChallenge(parsed.data.clientDataJSON);
  if (!challenge) return err(c, 400, 'bad_request', 'invalid clientDataJSON');

  const store = getStore(c);
  const consumed = await store.consumeChallenge(challenge, 'login', nowIso());
  if (!consumed) return err(c, 401, 'unauthorized', 'unknown or replayed challenge');

  const cred = await store.getCredentialByCredentialId(parsed.data.credentialId);
  if (!cred) return err(c, 401, 'unauthorized', 'unknown credential');

  const { rpId, origins } = rpConfig(c.env);
  let verified;
  try {
    verified = await verifyAssertion({
      credentialId: parsed.data.credentialId,
      authenticatorData: parsed.data.authenticatorData,
      clientDataJSON: parsed.data.clientDataJSON,
      signature: parsed.data.signature,
      cosePublicKey: cred.public_key,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
    });
  } catch {
    return err(c, 401, 'unauthorized', 'assertion verification failed');
  }

  const advanced = await store.advanceCounter(cred.id, verified.newCounter);
  if (!advanced) {
    return err(c, 401, 'unauthorized', 'counter regression (possible cloned authenticator)');
  }

  await mintSession(c, cred.owner_id, { method: 'passkey', credentialId: parsed.data.credentialId });

  return c.json({ owner_id: cred.owner_id });
});

app.post('/logout', ownerSession, async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const store = getStore(c);
    const session = await store.getSessionByTokenHash(sha256hex(token));
    if (session) await store.revokeSession(session.id, nowIso());
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ── Reads (session required) ──

app.get('/me', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  const owner = await store.getOwner(ownerId);
  const creds = await store.listCredentials(ownerId);
  const delegations = await store.listDelegationsByOwner(ownerId);
  // Metadata only (created_at) — the code itself was shown once and never stored.
  const recoveryCode = await store.getOpenRecoveryCode(ownerId);
  return c.json({
    owner_id: ownerId,
    email: owner?.email ?? null,
    credentials: creds.map((cr) => ({
      credential_id: cr.credential_id,
      nickname: cr.nickname,
      created_at: cr.created_at,
      last_used_at: cr.last_used_at,
      backed_up: cr.backed_up === 1,
    })),
    delegations,
    recovery_code: recoveryCode ? { created_at: recoveryCode.created_at } : null,
    // The ladder rung of THIS session + whether the first approval must mint
    // a passkey (credentials.length === 0 conveys it too; explicit is kinder).
    session_method: (c.get as (k: string) => string)('sessionMethod') ?? 'passkey',
    has_passkey: creds.length > 0,
    // Operator pages (feedback triage) — ADMIN_OWNER_IDS; drives the console nav only.
    is_admin: isAdminOwner(c.env, ownerId),
  });
});

app.get('/delegations', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  return c.json({ delegations: await store.listDelegationsByOwner(ownerId) });
});

// ── Action ceremony ("signatures to act") ──

app.post('/action/begin', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = ActionBeginSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  // Fresh per-ceremony nonce → unique action_hash per approval, so a captured
  // assertion cannot be replayed after the challenge is re-armed (defends the
  // §3 "a stolen look-session grants browsing, not authority" guarantee even on
  // static-counter authenticators). The client echoes this nonce to the finish
  // endpoint, which re-derives and re-checks the exact action.
  const nonce = base64urlEncode(randomBytes(16));
  const canonical = canonicalJsonStringify({
    action_type: parsed.data.action_type,
    owner_id: ownerId,
    nonce,
    ...parsed.data.params,
  });
  const action_hash = actionChallenge(canonical);

  await armActionChallenge(c.get('db'), ownerId, parsed.data.action_type, action_hash);

  const store = getStore(c);
  const creds = await store.listCredentials(ownerId);
  const { rpId } = rpConfig(c.env);

  return c.json({
    challenge: action_hash, // challenge IS the action hash — the authenticator signs the action.
    nonce,
    rpId,
    allowCredentials: creds.map((cr) => ({
      type: 'public-key',
      id: cr.credential_id,
      transports: cr.transports ?? undefined,
    })),
    action_canonical: canonical,
    timeout: 60_000,
  });
});

app.post('/delegations', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = CreateDelegationSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const label = parsed.data.label ?? null;
  const canonical = canonicalJsonStringify({
    action_type: 'create_delegation',
    owner_id: ownerId,
    nonce: parsed.data.nonce,
    agent_id: parsed.data.agent_id,
    label,
  });
  const outcome = await verifyAndRecordAction(c, ownerId, 'create_delegation', canonical, parsed.data.assertion);
  if (!outcome.ok) return outcome.res;

  const store = getStore(c);
  try {
    const delegation = await store.createDelegation({
      ownerId,
      agentId: parsed.data.agent_id,
      label: parsed.data.label,
      authorizingAssertionId: outcome.row.id,
    });
    return c.json(delegation);
  } catch (e) {
    if (e instanceof Error && e.message.includes('already delegated')) {
      return err(c, 409, 'conflict', 'delegation already exists for this agent');
    }
    // e.g. agent FK violation — the agent does not exist.
    return err(c, 400, 'bad_request', 'could not create delegation (unknown agent?)');
  }
});

app.post('/delegations/:id/revoke', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const delegationId = c.req.param('id');
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = RevokeSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  // Ownership check: only the owner's own delegations are listable this way.
  const owned = await store.listDelegationsByOwner(ownerId);
  const target = owned.find((d) => d.id === delegationId);
  if (!target) return err(c, 404, 'not_found', 'delegation not found');

  const canonical = canonicalJsonStringify({
    action_type: 'revoke_delegation',
    owner_id: ownerId,
    nonce: parsed.data.nonce,
    delegation_id: delegationId,
  });
  const outcome = await verifyAndRecordAction(c, ownerId, 'revoke_delegation', canonical, parsed.data.assertion);
  if (!outcome.ok) return outcome.res;

  const delegation = await store.revokeDelegation({
    delegationId,
    revokeAssertionId: outcome.row.id,
    nowIso: nowIso(),
  });
  return c.json(delegation);
});

// ── Public board posting (board spec §5/§8) ──
//
// The one control-plane write that lands OUTSIDE the control-plane tables:
// a human posting to the public board as themselves (author_kind='owner').
// Same ceremony as every other mutation, with the content hash folded into
// the ACTION STRING itself: the action type is `board.post:<sha256(body)>`
// (board spec §5), re-derived HERE from the POSTed body — never trusted from
// a client-supplied hash field — so the canonical the passkey signed names
// the exact bytes being published. A swapped body changes the action string,
// hence the action hash, and fails WYSIWYS before anything is consumed.

app.post('/board/posts', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = OwnerBoardPostSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const db = c.get('db');
  // 60/hr per owner (board spec §9 — the passkey ceremony is its own
  // throttle; this is the backstop). The bucket is board:owner:, DISTINCT
  // from board:ow: (the certified AGENTS' pooled write tier), so console
  // posting never drains an owner's delegated agents' budget or vice versa.
  //
  // We PEEK the bucket here — a non-consuming COUNT, NOT a checkRateLimit call —
  // for the sole purpose of 429-ing BEFORE the ceremony, so a rate-limited
  // request neither consumes the armed single-use challenge nor appends a
  // never-executed assertion to the owner's chain (nor wastes a passkey tap).
  // The AUTHORITATIVE consume + the INSERT is insertOwnerBoardPost below (shared
  // verbatim with the MCP connector), so the hourly slot is spent exactly once,
  // by whichever transport lands the row — no double count, no split budget.
  const windowStart = new Date(Date.now() - OWNER_BOARD_HOURLY.windowMs).toISOString();
  const used = await db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM rate_limit_log WHERE key = ? AND created_at > ?',
    `board:owner:${ownerId}`,
    windowStart,
  );
  if ((used?.count ?? 0) >= OWNER_BOARD_HOURLY.max) {
    return c.json({ error: 'rate_limited', message: 'Board rate limit exceeded (60 per hour)' }, 429);
  }

  // Signed path (passkey holder) vs session-only path (email-login human with
  // no passkey yet). If a signature is offered we bind it to the exact bytes —
  // action string is `board.post:<sha256(body)>`, re-derived here, never
  // trusted from the client — and store the assertion id for provenance. With
  // no signature, the httpOnly SameSite=Strict session cookie authorizes the
  // post on its own (the deliberate board-post relaxation of "signatures to
  // act"); assertion_id stays null. Either way the "Verified human" badge is a
  // separate live JOIN at read time, so a session-only post from a passkey
  // holder still badges, and a post from a passkey-less human does not.
  let assertionId: string | null = null;
  if (parsed.data.assertion !== undefined || parsed.data.nonce !== undefined) {
    if (parsed.data.assertion === undefined || parsed.data.nonce === undefined) {
      return err(c, 400, 'bad_request', 'nonce and assertion must be provided together');
    }
    const bodySha = sha256hex(parsed.data.body);
    const actionType = `board.post:${bodySha}`;
    const canonical = canonicalJsonStringify({
      action_type: actionType,
      owner_id: ownerId,
      nonce: parsed.data.nonce,
    });
    const outcome = await verifyAndRecordAction(c, ownerId, actionType, canonical, parsed.data.assertion);
    if (!outcome.ok) return outcome.res;
    assertionId = outcome.row.id;
  }

  // The authoritative rate-limit consume + the INSERT, shared with the MCP
  // connector. Roots only, author_kind='owner', body hash re-derived inside —
  // see insertOwnerBoardPost. assertionId is null on the session-only path.
  const result = await insertOwnerBoardPost(db, ownerId, parsed.data.body, assertionId);
  if (!result.ok) {
    // The peek above passed but the slot was taken between then and now
    // (concurrent post): same 429 shape. The ceremony has run, but a losing
    // race on the last slot of the hour is the acceptable cost of not holding
    // a transaction D1 doesn't offer.
    return c.json({ error: 'rate_limited', message: 'Board rate limit exceeded (60 per hour)' }, 429);
  }
  return c.json({ ok: true, post_id: result.post_id, created_at: result.created_at });
});

// ── The owner's own board posts (board spec §9 — "held posts … visible to
// author") ──
//
// The public GET /v1/board/posts excludes held/removed rows, so a held
// owner post would vanish from the console with no way for its author to
// learn it was held. This owner-session view returns the account's own posts
// regardless of status (author-deleted rows excluded), so the console can
// show a held post to the human who wrote it — and gives the delete button
// below a list to act on.
app.get('/board/posts', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const parts = await authorSqlParts(db);
  const rows = await db.all<PostRow>(
    `SELECT ${parts.columns} FROM board_posts p ${parts.joins}
     WHERE p.author_owner_id = ? AND p.deleted_at IS NULL
     ORDER BY p.seq DESC LIMIT 100`,
    ownerId,
  );
  return c.json({ ok: true, posts: rows.map(mapPost) });
});

// ── Author-only soft delete of an owner's own post (board spec §5) ──
//
// The agent DELETE path (routes/board.ts) can't reach owner-authored posts
// (author_agent_id is NULL there), so this is the owner's delete. Session-only,
// no per-post ceremony — parity with the agent side, where deleting your own
// post is auth-gated but not signature-gated; removing your own words is
// self-service, not an authority grant.
app.delete('/board/posts/:id', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const postId = c.req.param('id');
  const post = await db.get<{ id: string; author_owner_id: string | null; deleted_at: string | null }>(
    'SELECT id, author_owner_id, deleted_at FROM board_posts WHERE id = ?',
    postId,
  );
  if (!post) return err(c, 404, 'not_found', 'post not found');
  if (post.author_owner_id !== ownerId) {
    return err(c, 404, 'not_found', 'post not found'); // not-yours == not-found: no existence oracle
  }
  if (!post.deleted_at) {
    await db.run('UPDATE board_posts SET deleted_at = ? WHERE id = ?', nowIso(), postId);
  }
  return c.json({ ok: true });
});

export default app;
