/**
 * ControlStore — the data layer for the Keyring control plane.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Runs on Cloudflare Workers + D1 (and better-sqlite3 in tests) over the
 * `DBAdapter` interface, which exposes only get/all/run/exec — NO transactions.
 * Every security-critical state change is therefore a SINGLE atomic conditional
 * write verified by `.changes`, never a TOCTOU SELECT-then-INSERT/UPDATE
 * (CONTROL_PLANE.md §4). Owner authority events are hash-chained (§5).
 *
 * Ids/tokens use crypto.getRandomValues (Workers-safe; no node:crypto). Owner
 * ids are derived from the vault key (see ./identity.ts), everything else is a
 * prefixed random id. Times are stored as ISO-8601 strings.
 */
import type { DBAdapter } from '../db/adapter.js';
import type { GrantConstraints } from './grant-actions.js';
import {
  base58Encode,
  sha256,
  bytesToHex,
  canonicalJsonStringify,
  GENESIS_HASH,
} from '../crypto/index.js';

// ─── Row interfaces (match the 0023 schema columns) ───

export interface OwnerRow {
  id: string;
  email: string | null;
  email_verified: number;
  display_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  /** Billing (migration 0026): 'free' | 'pro' | 'team'. */
  plan: string;
  /** 'active' | 'past_due' | 'canceled'. */
  plan_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}

export interface CredentialRow {
  id: string;
  owner_id: string;
  credential_id: string;
  /** COSE public key bytes (BLOB), normalized to Uint8Array on read. */
  public_key: Uint8Array;
  signature_counter: number;
  /** Parsed from the stored JSON array; null when absent. */
  transports: string[] | null;
  aaguid: string | null;
  backed_up: number;
  nickname: string | null;
  created_at: string;
  last_used_at: string | null;
  /** 'active' | 'revoked' — revoked passkeys fail login and every action. */
  status: string;
  revoked_at: string | null;
}

export interface ChallengeRow {
  id: string;
  owner_id: string | null;
  challenge: string;
  purpose: string;
  action_type: string | null;
  action_hash: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface SessionRow {
  id: string;
  owner_id: string;
  token_hash: string;
  credential_id: string | null;
  /** 'passkey' | 'email' — the ladder rung that minted this session. */
  method: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  user_agent: string | null;
  ip_hash: string | null;
}

export interface ActionAssertionRow {
  id: string;
  owner_id: string;
  credential_id: string;
  action_type: string;
  action_hash: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
  sequence: number;
  prev_hash: string;
  entry_hash: string;
  created_at: string;
}

export interface VaultKeyRow {
  id: string;
  owner_id: string;
  vault_public_key: string;
  status: string;
  binding_assertion_id: string | null;
  bound_at: string;
  rotated_at: string | null;
}

export interface DelegationRow {
  id: string;
  owner_id: string;
  agent_id: string;
  label: string | null;
  status: string;
  /** 'assertion' (passkey ceremony) | 'claim' (ladder magic-link ratification). */
  authorized_via: string;
  authorizing_assertion_id: string | null;
  revoke_assertion_id: string | null;
  created_at: string;
  revoked_at: string | null;
  /** When the owner's machine confirmed it executed the local kill (0032). */
  daemon_confirmed_at: string | null;
  /** Counts-only JSON report from that kill — never values. */
  daemon_kill_report: string | null;
}

// ── Keyring approvals (migration 0024) ──

export interface KeyringRequestRow {
  id: string;
  owner_id: string;
  agent_id: string;
  credential_id: string;
  credential_label: string | null;
  provider: string | null;
  /** JSON text — the requested constraints (only the recognized keys). */
  constraints: string;
  note: string | null;
  status: string; // pending | approved | denied
  created_at: string;
  decided_at: string | null;
  decision_assertion_id: string | null;
  deny_reason: string | null;
}

export interface GrantApprovalRow {
  id: string;
  owner_id: string;
  request_id: string;
  agent_id: string;
  /** base58 Ed25519 — the pinned sealing target the owner signed. */
  agent_pubkey: string;
  credential_id: string;
  /** JSON text — the exact approved constraints. */
  constraints: string;
  nonce: string;
  action_hash: string;
  /** WebAuthn credential id of the passkey that signed the approval. */
  assertion_credential_id: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
  /** action_assertions.id of the hash-chained assertion that authorized this. */
  assertion_id: string;
  status: string; // pending_daemon | confirmed | failed
  created_at: string;
  confirmed_at: string | null;
  daemon_grant_id: string | null;
  failure_reason: string | null;
}

// ─── local helpers ───

function nowIsoString(): string {
  return new Date().toISOString();
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Prefixed random id, e.g. cred_<base58(16 random bytes)>. */
function randomId(prefix: string): string {
  return `${prefix}${base58Encode(randomBytes(16))}`;
}

/** URL-safe base64 without padding (WebAuthn/challenge encoding). */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}

/** Normalize a SQLite BLOB (Buffer / Uint8Array / number[]) to a plain Uint8Array copy. */
function toUint8Array(v: unknown): Uint8Array {
  if (v == null) throw new Error('Expected BLOB bytes, got null/undefined');
  // Buffer is a Uint8Array subclass; new Uint8Array(...) copies the byte values.
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('Unexpected type for BLOB bytes');
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { message?: unknown; code?: unknown };
  const msg = typeof err?.message === 'string' ? err.message : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  return msg.includes('UNIQUE constraint failed') || code.includes('SQLITE_CONSTRAINT');
}

type RawRow = Record<string, unknown>;
const asStr = (v: unknown): string => v as string;
const asNullableStr = (v: unknown): string | null => (v == null ? null : (v as string));

function mapOwnerRow(r: RawRow): OwnerRow {
  return {
    id: asStr(r.id),
    email: asNullableStr(r.email),
    email_verified: Number(r.email_verified),
    display_name: asNullableStr(r.display_name),
    status: asStr(r.status),
    created_at: asStr(r.created_at),
    updated_at: asStr(r.updated_at),
    plan: asStr(r.plan ?? 'free'),
    plan_status: asStr(r.plan_status ?? 'active'),
    stripe_customer_id: asNullableStr(r.stripe_customer_id),
    stripe_subscription_id: asNullableStr(r.stripe_subscription_id),
    current_period_end: asNullableStr(r.current_period_end),
  };
}

function mapCredentialRow(r: RawRow): CredentialRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    credential_id: asStr(r.credential_id),
    public_key: toUint8Array(r.public_key),
    signature_counter: Number(r.signature_counter),
    transports: r.transports == null ? null : (JSON.parse(r.transports as string) as string[]),
    aaguid: asNullableStr(r.aaguid),
    backed_up: Number(r.backed_up),
    nickname: asNullableStr(r.nickname),
    created_at: asStr(r.created_at),
    last_used_at: asNullableStr(r.last_used_at),
    status: asStr(r.status ?? 'active'),
    revoked_at: asNullableStr(r.revoked_at),
  };
}

function mapChallengeRow(r: RawRow): ChallengeRow {
  return {
    id: asStr(r.id),
    owner_id: asNullableStr(r.owner_id),
    challenge: asStr(r.challenge),
    purpose: asStr(r.purpose),
    action_type: asNullableStr(r.action_type),
    action_hash: asNullableStr(r.action_hash),
    created_at: asStr(r.created_at),
    expires_at: asStr(r.expires_at),
    consumed_at: asNullableStr(r.consumed_at),
  };
}

function mapSessionRow(r: RawRow): SessionRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    token_hash: asStr(r.token_hash),
    credential_id: asNullableStr(r.credential_id),
    method: asStr(r.method ?? 'passkey'),
    created_at: asStr(r.created_at),
    expires_at: asStr(r.expires_at),
    revoked_at: asNullableStr(r.revoked_at),
    last_seen_at: asNullableStr(r.last_seen_at),
    user_agent: asNullableStr(r.user_agent),
    ip_hash: asNullableStr(r.ip_hash),
  };
}

function mapActionAssertionRow(r: RawRow): ActionAssertionRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    credential_id: asStr(r.credential_id),
    action_type: asStr(r.action_type),
    action_hash: asStr(r.action_hash),
    authenticator_data: asStr(r.authenticator_data),
    client_data_json: asStr(r.client_data_json),
    signature: asStr(r.signature),
    sequence: Number(r.sequence),
    prev_hash: asStr(r.prev_hash),
    entry_hash: asStr(r.entry_hash),
    created_at: asStr(r.created_at),
  };
}

function mapVaultKeyRow(r: RawRow): VaultKeyRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    vault_public_key: asStr(r.vault_public_key),
    status: asStr(r.status),
    binding_assertion_id: asNullableStr(r.binding_assertion_id),
    bound_at: asStr(r.bound_at),
    rotated_at: asNullableStr(r.rotated_at),
  };
}

function mapDelegationRow(r: RawRow): DelegationRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    agent_id: asStr(r.agent_id),
    label: asNullableStr(r.label),
    status: asStr(r.status),
    authorized_via: asStr(r.authorized_via ?? 'assertion'),
    authorizing_assertion_id: asNullableStr(r.authorizing_assertion_id),
    revoke_assertion_id: asNullableStr(r.revoke_assertion_id),
    created_at: asStr(r.created_at),
    revoked_at: asNullableStr(r.revoked_at),
    daemon_confirmed_at: asNullableStr(r.daemon_confirmed_at),
    daemon_kill_report: asNullableStr(r.daemon_kill_report),
  };
}

function mapKeyringRequestRow(r: RawRow): KeyringRequestRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    agent_id: asStr(r.agent_id),
    credential_id: asStr(r.credential_id),
    credential_label: asNullableStr(r.credential_label),
    provider: asNullableStr(r.provider),
    constraints: asStr(r.constraints),
    note: asNullableStr(r.note),
    status: asStr(r.status),
    created_at: asStr(r.created_at),
    decided_at: asNullableStr(r.decided_at),
    decision_assertion_id: asNullableStr(r.decision_assertion_id),
    deny_reason: asNullableStr(r.deny_reason),
  };
}

function mapGrantApprovalRow(r: RawRow): GrantApprovalRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    request_id: asStr(r.request_id),
    agent_id: asStr(r.agent_id),
    agent_pubkey: asStr(r.agent_pubkey),
    credential_id: asStr(r.credential_id),
    constraints: asStr(r.constraints),
    nonce: asStr(r.nonce),
    action_hash: asStr(r.action_hash),
    assertion_credential_id: asStr(r.assertion_credential_id),
    authenticator_data: asStr(r.authenticator_data),
    client_data_json: asStr(r.client_data_json),
    signature: asStr(r.signature),
    assertion_id: asStr(r.assertion_id),
    status: asStr(r.status),
    created_at: asStr(r.created_at),
    confirmed_at: asNullableStr(r.confirmed_at),
    daemon_grant_id: asNullableStr(r.daemon_grant_id),
    failure_reason: asNullableStr(r.failure_reason),
  };
}

/**
 * The canonical, hash-covered view of an action-assertion event: every stored
 * column EXCEPT entry_hash itself. entry_hash = sha256Hex(canonicalJson(this)).
 * canonicalJsonStringify sorts keys, so field order here is irrelevant.
 */
function actionAssertionEvent(row: Omit<ActionAssertionRow, 'entry_hash'>): Record<string, unknown> {
  return {
    id: row.id,
    owner_id: row.owner_id,
    credential_id: row.credential_id,
    action_type: row.action_type,
    action_hash: row.action_hash,
    authenticator_data: row.authenticator_data,
    client_data_json: row.client_data_json,
    signature: row.signature,
    sequence: row.sequence,
    prev_hash: row.prev_hash,
    created_at: row.created_at,
  };
}

// ─── input types ───

export interface CreateOwnerInput {
  ownerId: string;
  email?: string;
  displayName?: string;
}

export interface AddCredentialInput {
  ownerId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  aaguid?: string;
  backedUp: boolean;
  transports?: string[];
  nickname?: string;
}

export interface CreateChallengeInput {
  ownerId?: string;
  purpose: 'register' | 'login' | 'action' | 'recovery';
  actionType?: string;
  actionHash?: string;
  ttlSeconds: number;
}

export interface CreateSessionInput {
  ownerId: string;
  tokenHash: string;
  credentialId?: string;
  /** 'passkey' (default) | 'email' — which ladder rung minted the session. */
  method?: 'passkey' | 'email';
  ttlSeconds: number;
  userAgent?: string;
  ipHash?: string;
}

export interface AppendActionAssertionInput {
  ownerId: string;
  credentialId: string;
  actionType: string;
  actionHash: string;
  authenticatorData: string;
  clientDataJson: string;
  signature: string;
}

export interface CreateVaultBindingInput {
  ownerId: string;
  vaultPublicKey: string;
  /** Absent for ladder-claimed bindings (ratified by the magic-link claim). */
  bindingAssertionId?: string;
}

export interface CreateDelegationInput {
  ownerId: string;
  agentId: string;
  label?: string;
  /** Absent for ladder-claimed delegations (authorized_via = 'claim'). */
  authorizingAssertionId?: string;
  authorizedVia?: 'assertion' | 'claim';
}

export interface RevokeDelegationInput {
  delegationId: string;
  revokeAssertionId: string;
  nowIso: string;
}

export interface CreateKeyringRequestInput {
  ownerId: string;
  agentId: string;
  credentialId: string;
  credentialLabel?: string;
  provider?: string;
  /** Recognized constraint keys only — stored as JSON text. */
  constraints: GrantConstraints;
  note?: string;
}

export interface SetRequestDecisionInput {
  id: string;
  status: 'approved' | 'denied';
  assertionId?: string;
  denyReason?: string;
  nowIso: string;
}

export interface CreateGrantApprovalInput {
  ownerId: string;
  requestId: string;
  agentId: string;
  agentPubkey: string;
  credentialId: string;
  /** Recognized constraint keys only — stored as JSON text. */
  constraints: GrantConstraints;
  nonce: string;
  actionHash: string;
  assertionCredentialId: string;
  authenticatorData: string;
  clientDataJson: string;
  signature: string;
  assertionId: string;
}

// ─── ControlStore ───

export class ControlStore {
  constructor(private db: DBAdapter) {}

  // ── Owners ──

  async createOwner({ ownerId, email, displayName }: CreateOwnerInput): Promise<OwnerRow> {
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO owners (id, email, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      ownerId,
      email ?? null,
      displayName ?? null,
      now,
      now
    );
    const row = await this.getOwner(ownerId);
    if (!row) throw new Error(`createOwner: owner ${ownerId} not found after insert`);
    return row;
  }

  async getOwner(ownerId: string): Promise<OwnerRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owners WHERE id = ?`, ownerId);
    return r ? mapOwnerRow(r) : null;
  }

  async getOwnerByEmail(email: string): Promise<OwnerRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owners WHERE email = ?`, email);
    return r ? mapOwnerRow(r) : null;
  }

  // ── WebAuthn credentials ──

  async addCredential(input: AddCredentialInput): Promise<CredentialRow> {
    const id = randomId('cred_');
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO owner_webauthn_credentials
         (id, owner_id, credential_id, public_key, signature_counter,
          transports, aaguid, backed_up, nickname, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.ownerId,
      input.credentialId,
      Buffer.from(input.publicKey),
      input.counter,
      input.transports ? JSON.stringify(input.transports) : null,
      input.aaguid ?? null,
      input.backedUp ? 1 : 0,
      input.nickname ?? null,
      now
    );
    const row = await this.getCredentialByRowId(id);
    if (!row) throw new Error(`addCredential: credential ${id} not found after insert`);
    return row;
  }

  /**
   * Enroll the account's FIRST passkey — refuses (returns null) when an
   * ACTIVE credential already exists. The self-serve /register endpoints are
   * unauthenticated and the vault public key is derivable from the PUBLIC
   * owner id, so without this gate anyone could add their own passkey to a
   * known account; replacing a live passkey goes through recovery instead.
   * Guarded INSERT…SELECT: the existence check and the insert are one
   * statement, so two racing registrations cannot both win.
   */
  async addFirstCredential(input: AddCredentialInput): Promise<CredentialRow | null> {
    const id = randomId('cred_');
    const now = nowIsoString();
    const res = await this.db.run(
      `INSERT INTO owner_webauthn_credentials
         (id, owner_id, credential_id, public_key, signature_counter,
          transports, aaguid, backed_up, nickname, created_at, last_used_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       WHERE NOT EXISTS (
         SELECT 1 FROM owner_webauthn_credentials
          WHERE owner_id = ? AND status = 'active'
       )`,
      id,
      input.ownerId,
      input.credentialId,
      Buffer.from(input.publicKey),
      input.counter,
      input.transports ? JSON.stringify(input.transports) : null,
      input.aaguid ?? null,
      input.backedUp ? 1 : 0,
      input.nickname ?? null,
      now,
      input.ownerId
    );
    if (res.changes !== 1) return null;
    return this.getCredentialByRowId(id);
  }

  private async getCredentialByRowId(id: string): Promise<CredentialRow | null> {
    const r = await this.db.get<RawRow>(
      `SELECT * FROM owner_webauthn_credentials WHERE id = ?`,
      id
    );
    return r ? mapCredentialRow(r) : null;
  }

  /**
   * ACTIVE credentials only — this getter is the authority lookup for login
   * and every action ceremony, so a passkey revoked by recovery rotation must
   * be invisible here (it would otherwise keep authorizing actions).
   */
  async getCredentialByCredentialId(credentialId: string): Promise<CredentialRow | null> {
    const r = await this.db.get<RawRow>(
      `SELECT * FROM owner_webauthn_credentials WHERE credential_id = ? AND status = 'active'`,
      credentialId
    );
    return r ? mapCredentialRow(r) : null;
  }

  /** Active credentials only (login/action allowCredentials, /me, daemon anchor list). */
  async listCredentials(ownerId: string): Promise<CredentialRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM owner_webauthn_credentials
       WHERE owner_id = ? AND status = 'active'
       ORDER BY created_at ASC, id ASC`,
      ownerId
    );
    return rows.map(mapCredentialRow);
  }

  /**
   * Recovery rotation: revoke every OTHER credential of this owner in one
   * conditional write. Returns how many were revoked.
   */
  async revokeOtherCredentials(ownerId: string, keepRowId: string, nowIso: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE owner_webauthn_credentials
       SET status = 'revoked', revoked_at = ?
       WHERE owner_id = ? AND id != ? AND status = 'active'`,
      nowIso,
      ownerId,
      keepRowId
    );
    return res.changes;
  }

  /**
   * ATOMIC monotonic signature-counter bump — the ONLY way the counter changes.
   * Defends against cloned/replayed authenticators (CONTROL_PLANE.md §4). Returns
   * true iff the counter advanced (or the no-counter 0→0 case).
   *
   *   UPDATE owner_webauthn_credentials SET signature_counter=?, last_used_at=?
   *     WHERE id=? AND signature_counter < ?   -> changes === 1
   *
   * Special case: an authenticator that does not implement a counter always
   * reports 0. When newCounter === 0 AND the stored counter is 0, we still allow
   * it (touching last_used_at) — but a stored counter > 0 that suddenly reports 0
   * is a clone and is rejected.
   */
  async advanceCounter(credentialRowId: string, newCounter: number): Promise<boolean> {
    const now = nowIsoString();
    const res = await this.db.run(
      `UPDATE owner_webauthn_credentials
         SET signature_counter = ?, last_used_at = ?
       WHERE id = ? AND signature_counter < ?`,
      newCounter,
      now,
      credentialRowId,
      newCounter
    );
    if (res.changes === 1) return true;

    // No-counter authenticator: allow only when the stored counter is also 0.
    if (newCounter === 0) {
      const res0 = await this.db.run(
        `UPDATE owner_webauthn_credentials
           SET last_used_at = ?
         WHERE id = ? AND signature_counter = 0`,
        now,
        credentialRowId
      );
      return res0.changes === 1;
    }
    return false;
  }

  // ── Challenges (single-use) ──

  async createChallenge(
    input: CreateChallengeInput
  ): Promise<{ id: string; challenge: string }> {
    const id = randomId('chl_');
    const challenge = base64urlEncode(randomBytes(32));
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    await this.db.run(
      `INSERT INTO webauthn_challenges
         (id, owner_id, challenge, purpose, action_type, action_hash,
          created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.ownerId ?? null,
      challenge,
      input.purpose,
      input.actionType ?? null,
      input.actionHash ?? null,
      createdAt,
      expiresAt
    );
    return { id, challenge };
  }

  /**
   * ATOMIC single-use consume. The guard is a single conditional UPDATE; only the
   * winner of a concurrent race sees changes === 1 (CONTROL_PLANE.md §4). Returns
   * the row iff it was unconsumed AND unexpired AND the purpose matches; else null.
   *
   *   UPDATE webauthn_challenges SET consumed_at=?
   *     WHERE challenge=? AND purpose=? AND consumed_at IS NULL AND expires_at > ?
   *
   * ISO-8601 UTC strings compare lexicographically, so `expires_at > nowIso` is a
   * valid freshness check.
   */
  async consumeChallenge(
    challenge: string,
    purpose: string,
    nowIso: string
  ): Promise<ChallengeRow | null> {
    const res = await this.db.run(
      `UPDATE webauthn_challenges
         SET consumed_at = ?
       WHERE challenge = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowIso,
      challenge,
      purpose,
      nowIso
    );
    if (res.changes !== 1) return null;
    const r = await this.db.get<RawRow>(
      `SELECT * FROM webauthn_challenges WHERE challenge = ?`,
      challenge
    );
    return r ? mapChallengeRow(r) : null;
  }

  // ── Sessions ("sessions to look") ──

  async createSession(input: CreateSessionInput): Promise<SessionRow> {
    const id = randomId('ses_');
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    await this.db.run(
      `INSERT INTO owner_sessions
         (id, owner_id, token_hash, credential_id, method, created_at, expires_at,
          revoked_at, last_seen_at, user_agent, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      id,
      input.ownerId,
      input.tokenHash,
      input.credentialId ?? null,
      input.method ?? 'passkey',
      createdAt,
      expiresAt,
      createdAt,
      input.userAgent ?? null,
      input.ipHash ?? null
    );
    const row = await this.getSessionByRowId(id);
    if (!row) throw new Error(`createSession: session ${id} not found after insert`);
    return row;
  }

  private async getSessionByRowId(id: string): Promise<SessionRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owner_sessions WHERE id = ?`, id);
    return r ? mapSessionRow(r) : null;
  }

  /** Returns the session iff it is neither revoked nor expired; otherwise null. */
  async getSessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const now = nowIsoString();
    const r = await this.db.get<RawRow>(
      `SELECT * FROM owner_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      tokenHash,
      now
    );
    return r ? mapSessionRow(r) : null;
  }

  async touchSession(id: string, nowIso: string): Promise<void> {
    await this.db.run(`UPDATE owner_sessions SET last_seen_at = ? WHERE id = ?`, nowIso, id);
  }

  async revokeSession(id: string, nowIso: string): Promise<void> {
    await this.db.run(`UPDATE owner_sessions SET revoked_at = ? WHERE id = ?`, nowIso, id);
  }

  /** Recovery rotation: kill every live look-session for this owner. */
  async revokeAllSessionsForOwner(ownerId: string, nowIso: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE owner_sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL`,
      nowIso,
      ownerId
    );
    return res.changes;
  }

  // ── Recovery (CONTROL_PLANE.md §6 — authority rotation, never secrets) ──

  /**
   * Store a new recovery code (sha256 hex of the normalized plaintext). Any
   * previously open code is superseded first, so at most one is redeemable.
   */
  async createRecoveryCode(ownerId: string, codeHash: string): Promise<{ id: string; created_at: string }> {
    const now = nowIsoString();
    await this.db.run(
      `UPDATE owner_recovery_codes SET superseded_at = ?
       WHERE owner_id = ? AND used_at IS NULL AND superseded_at IS NULL`,
      now,
      ownerId
    );
    const id = randomId('rc_');
    await this.db.run(
      `INSERT INTO owner_recovery_codes (id, owner_id, code_hash, created_at, used_at, superseded_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
      id,
      ownerId,
      codeHash,
      now
    );
    return { id, created_at: now };
  }

  /** The open (unused, unsuperseded) code's metadata — for /me status display. */
  async getOpenRecoveryCode(ownerId: string): Promise<{ id: string; created_at: string } | null> {
    const r = await this.db.get<RawRow>(
      `SELECT id, created_at FROM owner_recovery_codes
       WHERE owner_id = ? AND used_at IS NULL AND superseded_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      ownerId
    );
    return r ? { id: asStr(r.id), created_at: asStr(r.created_at) } : null;
  }

  /**
   * ATOMICALLY consume the recovery code (single-use, §4): the conditional
   * UPDATE only matches an open code with exactly this hash for this owner.
   */
  async consumeRecoveryCode(ownerId: string, codeHash: string, nowIso: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE owner_recovery_codes SET used_at = ?
       WHERE owner_id = ? AND code_hash = ? AND used_at IS NULL AND superseded_at IS NULL`,
      nowIso,
      ownerId,
      codeHash
    );
    return res.changes === 1;
  }

  /** True iff an open code with this hash exists (pre-check only — finish consumes). */
  async peekRecoveryCode(ownerId: string, codeHash: string): Promise<boolean> {
    const r = await this.db.get<RawRow>(
      `SELECT id FROM owner_recovery_codes
       WHERE owner_id = ? AND code_hash = ? AND used_at IS NULL AND superseded_at IS NULL`,
      ownerId,
      codeHash
    );
    return r != null;
  }

  async createRecoveryToken(ownerId: string, tokenHash: string, ttlSeconds: number): Promise<void> {
    const now = new Date();
    await this.db.run(
      `INSERT INTO owner_recovery_tokens (id, owner_id, token_hash, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      randomId('rt_'),
      ownerId,
      tokenHash,
      now.toISOString(),
      new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    );
  }

  /** The live (unconsumed, unexpired) token row, or null. Does NOT consume. */
  async getLiveRecoveryToken(tokenHash: string): Promise<{ owner_id: string } | null> {
    const r = await this.db.get<RawRow>(
      `SELECT owner_id FROM owner_recovery_tokens
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      tokenHash,
      nowIsoString()
    );
    return r ? { owner_id: asStr(r.owner_id) } : null;
  }

  /** ATOMICALLY consume the magic-link token (single-use, unexpired). */
  async consumeRecoveryToken(tokenHash: string, nowIso: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE owner_recovery_tokens SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowIso,
      tokenHash,
      nowIso
    );
    return res.changes === 1;
  }

  // ── Billing (migration 0026 — plan state; NEVER consulted on security paths) ──

  /** The agent is the unit of scale: how many ACTIVE delegations this owner holds. */
  async countActiveDelegations(ownerId: string): Promise<number> {
    const r = await this.db.get<RawRow>(
      `SELECT COUNT(*) AS n FROM delegations WHERE owner_id = ? AND status = 'active'`,
      ownerId
    );
    return Number(r?.n ?? 0);
  }

  async getOwnerByStripeCustomerId(customerId: string): Promise<OwnerRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owners WHERE stripe_customer_id = ?`, customerId);
    return r ? mapOwnerRow(r) : null;
  }

  async setStripeCustomerId(ownerId: string, customerId: string): Promise<void> {
    await this.db.run(
      `UPDATE owners SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`,
      customerId,
      nowIsoString(),
      ownerId
    );
  }

  async updateOwnerBilling(input: {
    ownerId: string;
    plan: 'free' | 'pro' | 'team';
    planStatus: 'active' | 'past_due' | 'canceled';
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: string | null;
  }): Promise<void> {
    await this.db.run(
      `UPDATE owners
       SET plan = ?, plan_status = ?, stripe_subscription_id = ?, current_period_end = ?, updated_at = ?
       WHERE id = ?`,
      input.plan,
      input.planStatus,
      input.stripeSubscriptionId ?? null,
      input.currentPeriodEnd ?? null,
      nowIsoString(),
      input.ownerId
    );
  }

  /**
   * ATOMIC idempotency claim for a Stripe webhook event: the INSERT succeeds
   * exactly once per event id; a replay hits the UNIQUE constraint and returns
   * false (§4 conditional-write discipline).
   */
  async claimStripeEvent(eventId: string, type: string): Promise<boolean> {
    try {
      await this.db.run(
        `INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)`,
        eventId,
        type,
        nowIsoString()
      );
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE') || msg.includes('SQLITE_CONSTRAINT')) return false;
      throw e;
    }
  }

  // ── Authority ladder (migration 0027): link codes, magic links, invites ──

  /**
   * Ensure a registry row exists for a keyring-first agent (created by
   * `keyring init`, claimed via email — the ladder's abuse brake replaces
   * proof-of-work for these). No-op when the agent is already registered.
   */
  async ensureAgent(agentId: string, publicKey: Uint8Array, name: string): Promise<void> {
    try {
      await this.db.run(
        `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, status)
         VALUES (?, ?, ?, 'Registered via Keyring link claim', '[]', '["mcp"]', 'active')`,
        agentId,
        publicKey,
        name
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }

  async createLinkCode(input: {
    vaultPublicKey: string;
    agentId: string;
    agentPublicKey: string;
    agentName?: string;
    ttlSeconds: number;
  }): Promise<{ id: string; code: string }> {
    const id = randomId('lnk_');
    // Short, URL-safe, unambiguous (no lookalike chars in base58).
    const code = base58Encode(randomBytes(8));
    const now = new Date();
    await this.db.run(
      `INSERT INTO link_codes
         (id, code, vault_public_key, agent_id, agent_public_key, agent_name,
          email, status, created_at, expires_at, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, NULL)`,
      id,
      code,
      input.vaultPublicKey,
      input.agentId,
      input.agentPublicKey,
      input.agentName ?? null,
      now.toISOString(),
      new Date(now.getTime() + input.ttlSeconds * 1000).toISOString()
    );
    return { id, code };
  }

  async getLinkCode(code: string): Promise<{
    id: string; code: string; vault_public_key: string; agent_id: string;
    agent_public_key: string; agent_name: string | null; email: string | null;
    status: string; expires_at: string;
  } | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM link_codes WHERE code = ?`, code);
    if (!r) return null;
    return {
      id: asStr(r.id), code: asStr(r.code),
      vault_public_key: asStr(r.vault_public_key),
      agent_id: asStr(r.agent_id), agent_public_key: asStr(r.agent_public_key),
      agent_name: asNullableStr(r.agent_name), email: asNullableStr(r.email),
      status: asStr(r.status), expires_at: asStr(r.expires_at),
    };
  }

  async getLinkCodeById(id: string): Promise<{
    id: string; code: string; vault_public_key: string; agent_id: string;
    agent_public_key: string; agent_name: string | null; email: string | null;
    status: string; expires_at: string;
  } | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM link_codes WHERE id = ?`, id);
    if (!r) return null;
    return {
      id: asStr(r.id), code: asStr(r.code),
      vault_public_key: asStr(r.vault_public_key),
      agent_id: asStr(r.agent_id), agent_public_key: asStr(r.agent_public_key),
      agent_name: asNullableStr(r.agent_name), email: asNullableStr(r.email),
      status: asStr(r.status), expires_at: asStr(r.expires_at),
    };
  }

  /** The claim click IS the email verification. */
  async setEmailVerified(ownerId: string): Promise<void> {
    await this.db.run(
      `UPDATE owners SET email_verified = 1, updated_at = ? WHERE id = ?`,
      nowIsoString(),
      ownerId
    );
  }

  /**
   * Attach a start-code-verified email to a still-pending link code (the
   * browser-door hand-off). Status stays 'pending' — nothing has been sent;
   * /link renders the masked address with a one-click send instead of an
   * empty email field. markLinkEmailSent overwrites on actual submission.
   */
  async attachLinkEmail(linkCodeId: string, email: string): Promise<void> {
    await this.db.run(
      `UPDATE link_codes SET email = ? WHERE id = ? AND status = 'pending'`,
      email,
      linkCodeId
    );
  }

  /** Record the claim email + move pending → email_sent (idempotent re-send allowed). */
  async markLinkEmailSent(linkCodeId: string, email: string): Promise<void> {
    await this.db.run(
      `UPDATE link_codes SET email = ?, status = 'email_sent'
       WHERE id = ? AND status IN ('pending','email_sent')`,
      email,
      linkCodeId
    );
  }

  /** ATOMICALLY claim a link code — single-use, unexpired (§4 discipline). */
  async claimLinkCode(linkCodeId: string, nowIso: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE link_codes SET status = 'claimed', claimed_at = ?
       WHERE id = ? AND status IN ('pending','email_sent') AND expires_at > ?`,
      nowIso,
      linkCodeId,
      nowIso
    );
    return res.changes === 1;
  }

  async createMagicLinkToken(input: {
    tokenHash: string;
    purpose: 'claim' | 'login' | 'start' | 'start_code';
    email: string;
    linkCodeId?: string;
    ownerId?: string;
    ttlSeconds: number;
  }): Promise<void> {
    const now = new Date();
    await this.db.run(
      `INSERT INTO magic_link_tokens
         (id, token_hash, purpose, email, link_code_id, owner_id, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      randomId('mlt_'),
      input.tokenHash,
      input.purpose,
      input.email,
      input.linkCodeId ?? null,
      input.ownerId ?? null,
      now.toISOString(),
      new Date(now.getTime() + input.ttlSeconds * 1000).toISOString()
    );
  }

  /** ATOMICALLY consume a magic-link token (single-use, unexpired). Returns the row or null. */
  async consumeMagicLinkToken(tokenHash: string, purpose: string, nowIso: string): Promise<{
    email: string; link_code_id: string | null; owner_id: string | null;
  } | null> {
    const r = await this.db.get<RawRow>(
      `SELECT email, link_code_id, owner_id FROM magic_link_tokens
       WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?`,
      tokenHash,
      purpose,
      nowIso
    );
    if (!r) return null;
    const res = await this.db.run(
      `UPDATE magic_link_tokens SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowIso,
      tokenHash,
      nowIso
    );
    if (res.changes !== 1) return null; // a concurrent consume won the race
    return {
      email: asStr(r.email),
      link_code_id: asNullableStr(r.link_code_id),
      owner_id: asNullableStr(r.owner_id),
    };
  }

  // ── Owner invites (agent-first entry; claim-pending = structurally nothing) ──

  async countRecentInvitesByAgent(agentId: string, sinceIso: string): Promise<number> {
    const r = await this.db.get<RawRow>(
      `SELECT COUNT(*) AS n FROM owner_invites WHERE agent_id = ? AND created_at > ?`,
      agentId,
      sinceIso
    );
    return Number(r?.n ?? 0);
  }

  async getOpenInvite(email: string, agentId: string): Promise<{
    id: string; invite_count: number; last_sent_at: string | null;
  } | null> {
    const r = await this.db.get<RawRow>(
      `SELECT id, invite_count, last_sent_at FROM owner_invites
       WHERE email = ? AND agent_id = ? AND status = 'pending' AND expires_at > ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      email,
      agentId,
      nowIsoString()
    );
    return r
      ? { id: asStr(r.id), invite_count: Number(r.invite_count), last_sent_at: asNullableStr(r.last_sent_at) }
      : null;
  }

  /**
   * Create a pending invite. Returns null if a concurrent racer already created
   * the open (email, agent) row — the partial unique index (0027) makes this
   * exactly-once, so callers treat null as "someone else just created it".
   */
  async createInvite(input: { email: string; agentId: string; agentName?: string; ttlSeconds: number }): Promise<string | null> {
    const id = randomId('inv_');
    const now = new Date();
    const res = await this.db.run(
      `INSERT INTO owner_invites
         (id, email, agent_id, agent_name, invite_count, status, created_at, last_sent_at, expires_at, claimed_at)
       VALUES (?, ?, ?, ?, 1, 'pending', ?, ?, ?, NULL)
       ON CONFLICT DO NOTHING`,
      id,
      input.email,
      input.agentId,
      input.agentName ?? null,
      now.toISOString(),
      now.toISOString(),
      new Date(now.getTime() + input.ttlSeconds * 1000).toISOString()
    );
    return res.changes === 1 ? id : null;
  }

  /** Bump the re-send counter (backoff bookkeeping for unresponsive emails). */
  async touchInvite(id: string, nowIso: string): Promise<void> {
    await this.db.run(
      `UPDATE owner_invites SET invite_count = invite_count + 1, last_sent_at = ? WHERE id = ?`,
      nowIso,
      id
    );
  }

  async markInviteClaimed(email: string, nowIso: string): Promise<void> {
    await this.db.run(
      `UPDATE owner_invites SET status = 'claimed', claimed_at = ?
       WHERE email = ? AND status = 'pending'`,
      nowIso,
      email
    );
  }

  // ── Pending connections (connect card: browser-sealed, daemon-resolved) ──

  async createPendingConnection(input: {
    ownerId: string;
    agentId: string;
    provider: string;
    label?: string;
    envVar?: string;
    /** '' for kinds 'provision'/'rotate'/'remove' — no secret is ever in flight for those rows. */
    sealedSecret: string;
    kind?: 'sealed' | 'provision' | 'rotate' | 'remove';
    /** kinds 'rotate'/'remove': the daemon credential to act on — set at BIRTH, not resolve. */
    daemonCredentialId?: string;
  }): Promise<string> {
    const id = randomId('pcx_');
    await this.db.run(
      `INSERT INTO pending_connections
         (id, owner_id, agent_id, provider, label, env_var, sealed_secret, kind, daemon_credential_id, status, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      id,
      input.ownerId,
      input.agentId,
      input.provider,
      input.label ?? null,
      input.envVar ?? null,
      input.sealedSecret,
      input.kind ?? 'sealed',
      input.daemonCredentialId ?? null,
      nowIsoString()
    );
    return id;
  }

  /**
   * The id of a live (pending/processing) row that already represents this
   * exact work, if any — the dedup key. Field-hit: clicking "Do it for me"
   * more than once queued a separate provision row each time, and a daemon
   * drained them one per round, re-opening the browser and (after the first
   * success) minting a redundant key per duplicate. Provision dedups on
   * (agent, provider); rotate on (agent, provider, target credential).
   */
  async findLivePendingConnection(input: {
    ownerId: string; agentId: string; provider: string; kind: string; target?: string | null;
  }): Promise<string | null> {
    const row = await this.db.get<RawRow>(
      `SELECT id FROM pending_connections
       WHERE owner_id = ? AND agent_id = ? AND provider = ? AND kind = ?
         AND status IN ('pending', 'processing')
         AND (? IS NULL OR daemon_credential_id = ?)
       ORDER BY created_at ASC LIMIT 1`,
      input.ownerId, input.agentId, input.provider, input.kind,
      input.target ?? null, input.target ?? null
    );
    return row ? asStr(row.id) : null;
  }

  /**
   * Once a PROVISION row stores, retire the OTHER live provision rows for the
   * same (agent, provider) — each surviving duplicate would mint a redundant
   * provider-side key. No-op unless the kept row is itself a stored provision.
   * Terminal 'revoked' status every reader's positive filter skips.
   */
  async cancelSiblingProvisions(ownerId: string, keptId: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE pending_connections
       SET status = 'revoked', resolved_at = ?, sealed_secret = ''
       WHERE owner_id = ? AND kind = 'provision' AND status IN ('pending', 'processing') AND id != ?
         AND (SELECT kind FROM pending_connections WHERE id = ?) = 'provision'
         AND agent_id = (SELECT agent_id FROM pending_connections WHERE id = ?)
         AND provider = (SELECT provider FROM pending_connections WHERE id = ?)`,
      nowIsoString(), ownerId, keptId, keptId, keptId, keptId
    );
    return res.changes;
  }

  /**
   * When a 'remove' operation resolves, retire the CHIP it removed: the
   * stored/live row for the same (agent, credential). This is what makes the
   * console chip disappear after a per-key Remove. No-op unless the kept row
   * is itself a 'remove' (so a normal resolve never retires a real holding).
   */
  async retireChipsForRemovedKey(ownerId: string, removeRowId: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE pending_connections
       SET status = 'revoked', resolved_at = ?, sealed_secret = ''
       WHERE owner_id = ? AND id != ? AND kind != 'remove'
         AND status IN ('stored', 'pending', 'processing')
         AND (SELECT kind FROM pending_connections WHERE id = ?) = 'remove'
         AND agent_id = (SELECT agent_id FROM pending_connections WHERE id = ?)
         AND daemon_credential_id = (SELECT daemon_credential_id FROM pending_connections WHERE id = ?)`,
      nowIsoString(), ownerId, removeRowId, removeRowId, removeRowId, removeRowId
    );
    return res.changes;
  }

  /**
   * Mirror the machine's real local grants into console-visible rows so the
   * console reflects terminal `keyring connect`/`grant`, not only
   * console-initiated connections (field-hit). Each entry becomes a 'stored'
   * row unless a LIVE row (stored/pending/processing) for that local
   * credential already exists — so this is idempotent across sync rounds and
   * never duplicates a console-initiated connection or a prior mirror. A
   * credential whose only prior row was retired (kill) gets a fresh stored row
   * if the grant is live again. Metadata only — sealed_secret is always ''.
   * Returns the number of new rows created.
   */
  async mirrorStoredConnections(
    ownerId: string,
    entries: Array<{ agentId: string; provider: string; label: string; daemonCredentialId: string }>,
  ): Promise<number> {
    const now = nowIsoString();
    let created = 0;
    for (const e of entries) {
      const existing = await this.db.get<RawRow>(
        `SELECT id FROM pending_connections
         WHERE owner_id = ? AND agent_id = ? AND daemon_credential_id = ?
           AND status IN ('stored', 'pending', 'processing')
         LIMIT 1`,
        ownerId, e.agentId, e.daemonCredentialId
      );
      if (existing) continue;
      await this.db.run(
        `INSERT INTO pending_connections
           (id, owner_id, agent_id, provider, label, env_var, sealed_secret, kind, daemon_credential_id, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, NULL, '', 'sealed', ?, 'stored', ?, ?)`,
        randomId('pcx_'), ownerId, e.agentId, e.provider, e.label, e.daemonCredentialId, now, now
      );
      created++;
    }
    return created;
  }

  async listPendingConnections(ownerId: string, status?: string): Promise<Array<{
    id: string; agent_id: string; provider: string; label: string | null;
    env_var: string | null; sealed_secret: string; kind: 'sealed' | 'provision' | 'rotate' | 'remove'; status: string;
    failure_reason: string | null; daemon_credential_id: string | null; created_at: string;
  }>> {
    const rows = status
      ? await this.db.all<RawRow>(
          `SELECT * FROM pending_connections WHERE owner_id = ? AND status = ? ORDER BY created_at ASC`,
          ownerId, status)
      : await this.db.all<RawRow>(
          `SELECT * FROM pending_connections WHERE owner_id = ? ORDER BY created_at ASC`,
          ownerId);
    return rows.map((r) => ({
      id: asStr(r.id), agent_id: asStr(r.agent_id), provider: asStr(r.provider),
      label: asNullableStr(r.label), env_var: asNullableStr(r.env_var),
      sealed_secret: asStr(r.sealed_secret),
      // Preserve every kind faithfully — collapsing an unknown kind to
      // 'sealed' would hand a secretless row to a daemon's sealed path.
      kind: (['provision', 'rotate', 'remove'].includes(asStr(r.kind)) ? asStr(r.kind) : 'sealed') as 'sealed' | 'provision' | 'rotate' | 'remove',
      status: asStr(r.status),
      failure_reason: asNullableStr(r.failure_reason),
      daemon_credential_id: asNullableStr(r.daemon_credential_id),
      created_at: asStr(r.created_at),
    }));
  }

  /**
   * ATOMICALLY claim a pending connection for processing (pending →
   * processing). Only the single winner gets `true`; a concurrent daemon (or
   * the same daemon on an overlapping poll) loses the race and must skip. This
   * is what makes connect-card storage exactly-once across processes.
   */
  async claimPendingConnection(id: string, ownerId: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE pending_connections SET status = 'processing', resolved_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'pending'`,
      nowIsoString(),
      id,
      ownerId
    );
    return res.changes === 1;
  }

  /**
   * Reap connection rows that will never resolve on their own — lazily, on the
   * read paths (console poll, daemon pull), no cron. Two stall shapes, each
   * with its own honest reason:
   *
   *  - 'processing' older than the window: a daemon CLAIMED it (claim stamps
   *    resolved_at) then went quiet — killed one-shot, crash, lost network.
   *  - 'pending' older than the window: NO daemon ever claimed it — the
   *    console's "Do it for me" / paste needs Keyring running on the machine
   *    and nothing is (field-hit: both provision cards span forever with no
   *    watcher). Reaped ONLY on the console path (`includePending`): a human is
   *    watching and wants an end state. The daemon path leaves pending rows
   *    alone so a freshly-started daemon can still service old work.
   *
   * A daemon that is merely SLOW keeps working locally; its late resolve finds
   * the row already failed and reports false — the honest outcome for work
   * nobody could observe for this long. Ciphertext is blanked on the way out.
   */
  async expireStaleConnections(
    ownerId: string,
    opts: { includePending?: boolean; olderThanMs?: number } = {}
  ): Promise<number> {
    const olderThanMs = opts.olderThanMs ?? 15 * 60 * 1000;
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const pendingClause = opts.includePending
      ? ` OR (status = 'pending' AND created_at < ?)`
      : '';
    const params: unknown[] = [nowIsoString(), ownerId, cutoff];
    if (opts.includePending) params.push(cutoff);
    const res = await this.db.run(
      `UPDATE pending_connections
       SET status = 'failed',
           failure_reason = CASE
             WHEN status = 'processing'
               THEN 'This started on your computer but never finished — it may have been interrupted. Try again.'
             ELSE 'This needs Keyring running on your computer. Run ` + '`npx basedagents keyring sync`' + ` there, then try again.'
           END,
           resolved_at = ?,
           sealed_secret = ''
       WHERE owner_id = ?
         AND ((status = 'processing' AND resolved_at < ?)${pendingClause})`,
      ...params
    );
    return res.changes;
  }

  /**
   * Daemon-reported credential facts (0031): metadata about machine-local
   * keys — currently just rotatability — so the console only offers actions
   * the machine can actually perform. Ids and booleans only, never values.
   */
  async upsertCredentialFacts(
    ownerId: string,
    facts: Array<{ credentialId: string; provider: string; rotatable: boolean }>,
  ): Promise<void> {
    const now = nowIsoString();
    for (const f of facts) {
      await this.db.run(
        `INSERT INTO credential_facts (owner_id, credential_id, provider, rotatable, reported_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, credential_id) DO UPDATE SET
           provider = excluded.provider, rotatable = excluded.rotatable, reported_at = excluded.reported_at`,
        ownerId,
        f.credentialId,
        f.provider,
        f.rotatable ? 1 : 0,
        now
      );
    }
  }

  async listCredentialFacts(ownerId: string): Promise<Array<{
    credential_id: string; provider: string; rotatable: boolean; reported_at: string;
  }>> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM credential_facts WHERE owner_id = ? ORDER BY credential_id ASC`,
      ownerId
    );
    return rows.map((r) => ({
      credential_id: asStr(r.credential_id),
      provider: asStr(r.provider),
      rotatable: Number(r.rotatable) === 1,
      reported_at: asStr(r.reported_at),
    }));
  }

  /** Daemon resolution — ATOMIC single transition out of pending/processing. */
  async resolvePendingConnection(input: {
    id: string;
    ownerId: string;
    outcome: 'stored' | 'failed';
    daemonCredentialId?: string;
    failureReason?: string;
  }): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE pending_connections
       SET status = ?, daemon_credential_id = COALESCE(?, daemon_credential_id), failure_reason = ?, resolved_at = ?,
           sealed_secret = CASE WHEN ? = 'stored' THEN '' ELSE sealed_secret END
       WHERE id = ? AND owner_id = ? AND status IN ('pending', 'processing')`,
      input.outcome,
      input.daemonCredentialId ?? null,
      input.failureReason ?? null,
      nowIsoString(),
      input.outcome,
      input.id,
      input.ownerId
    );
    return res.changes === 1;
  }

  // ── E2E test outbox (Task 2 — only ever written in E2E=1 environments) ──

  async appendTestOutbox(recipient: string, subject: string, body: string): Promise<void> {
    await this.db.run(
      `INSERT INTO test_outbox (recipient, subject, body) VALUES (?, ?, ?)`,
      recipient,
      subject,
      body
    );
  }

  async listTestOutbox(recipient?: string): Promise<Array<{ recipient: string; subject: string; body: string; created_at: string }>> {
    const rows = recipient
      ? await this.db.all<RawRow>(
          `SELECT recipient, subject, body, created_at FROM test_outbox WHERE recipient = ? ORDER BY id DESC`,
          recipient
        )
      : await this.db.all<RawRow>(`SELECT recipient, subject, body, created_at FROM test_outbox ORDER BY id DESC`);
    return rows.map((r) => ({
      recipient: asStr(r.recipient),
      subject: asStr(r.subject),
      body: asStr(r.body),
      created_at: asStr(r.created_at),
    }));
  }

  // ── Action assertions (hash-chained, CONTROL_PLANE.md §5) ──

  /**
   * Append an owner action to the per-owner hash chain.
   *   sequence  = prev.sequence + 1  (1 for the first)
   *   prev_hash = prev.entry_hash    (64 zeros genesis for the first)
   *   entry_hash = sha256Hex(canonicalJson(event-without-entry_hash))
   *
   * UNIQUE(owner_id, sequence) is the atomicity guard: a concurrent double-append
   * to the same sequence loses the INSERT race. On that uniqueness error we
   * re-read the head and retry ONCE; a persistent conflict surfaces a clear error.
   */
  async appendActionAssertion(
    input: AppendActionAssertionInput
  ): Promise<ActionAssertionRow> {
    let lastConflict: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = await this.getOwnerChainHead(input.ownerId);
      const sequence = head.sequence + 1;
      const prevHash = head.entry_hash;
      const id = randomId('aa_');
      const createdAt = nowIsoString();
      const base: Omit<ActionAssertionRow, 'entry_hash'> = {
        id,
        owner_id: input.ownerId,
        credential_id: input.credentialId,
        action_type: input.actionType,
        action_hash: input.actionHash,
        authenticator_data: input.authenticatorData,
        client_data_json: input.clientDataJson,
        signature: input.signature,
        sequence,
        prev_hash: prevHash,
        created_at: createdAt,
      };
      const entryHash = sha256Hex(canonicalJsonStringify(actionAssertionEvent(base)));
      try {
        await this.db.run(
          `INSERT INTO action_assertions
             (id, owner_id, credential_id, action_type, action_hash,
              authenticator_data, client_data_json, signature,
              sequence, prev_hash, entry_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          base.id,
          base.owner_id,
          base.credential_id,
          base.action_type,
          base.action_hash,
          base.authenticator_data,
          base.client_data_json,
          base.signature,
          base.sequence,
          base.prev_hash,
          entryHash,
          base.created_at
        );
        return { ...base, entry_hash: entryHash };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        lastConflict = e;
        // A concurrent append took this sequence — loop re-reads the head once.
      }
    }
    throw new Error(
      `appendActionAssertion: chain-append conflict for owner ${input.ownerId} ` +
        `(concurrent writer won the sequence twice)` +
        (lastConflict instanceof Error ? `: ${lastConflict.message}` : '')
    );
  }

  /** The current chain head; {0, 64-zeros genesis} when the owner has no events. */
  async getOwnerChainHead(
    ownerId: string
  ): Promise<{ sequence: number; entry_hash: string }> {
    const r = await this.db.get<RawRow>(
      `SELECT sequence, entry_hash FROM action_assertions
       WHERE owner_id = ? ORDER BY sequence DESC LIMIT 1`,
      ownerId
    );
    if (!r) return { sequence: 0, entry_hash: GENESIS_HASH };
    return { sequence: Number(r.sequence), entry_hash: asStr(r.entry_hash) };
  }

  /**
   * Verify the per-owner chain: sequences are 1..N contiguous, each prev_hash
   * links to the previous entry_hash, and every entry_hash recomputes from the
   * stored fields (so a tampered column is detected).
   */
  async verifyOwnerChain(ownerId: string): Promise<{ ok: boolean; errors: string[] }> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM action_assertions WHERE owner_id = ? ORDER BY sequence ASC`,
      ownerId
    );
    const errors: string[] = [];
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const raw of rows) {
      const row = mapActionAssertionRow(raw);
      if (row.sequence !== expectedSeq) {
        errors.push(
          `owner ${ownerId}: expected sequence ${expectedSeq}, got ${row.sequence}`
        );
      }
      if (row.prev_hash !== prev) {
        errors.push(
          `owner ${ownerId}: sequence ${row.sequence} prev_hash mismatch ` +
            `(expected ${prev}, got ${row.prev_hash})`
        );
      }
      const recomputed = sha256Hex(canonicalJsonStringify(actionAssertionEvent(row)));
      if (recomputed !== row.entry_hash) {
        errors.push(
          `owner ${ownerId}: sequence ${row.sequence} entry_hash mismatch ` +
            `(recomputed ${recomputed}, stored ${row.entry_hash}) — tampered`
        );
      }
      prev = row.entry_hash;
      expectedSeq = row.sequence + 1;
    }
    return { ok: errors.length === 0, errors };
  }

  // ── Vault-key binding ──

  async createVaultBinding(input: CreateVaultBindingInput): Promise<VaultKeyRow> {
    const id = randomId('vk_');
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO owner_vault_keys
         (id, owner_id, vault_public_key, status, binding_assertion_id, bound_at, rotated_at)
       VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
      id,
      input.ownerId,
      input.vaultPublicKey,
      input.bindingAssertionId ?? null,
      now
    );
    const row = await this.getVaultKeyByRowId(id);
    if (!row) throw new Error(`createVaultBinding: vault key ${id} not found after insert`);
    return row;
  }

  private async getVaultKeyByRowId(id: string): Promise<VaultKeyRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owner_vault_keys WHERE id = ?`, id);
    return r ? mapVaultKeyRow(r) : null;
  }

  async getActiveVaultKey(ownerId: string): Promise<VaultKeyRow | null> {
    const r = await this.db.get<RawRow>(
      `SELECT * FROM owner_vault_keys
       WHERE owner_id = ? AND status = 'active'
       ORDER BY bound_at DESC, id DESC LIMIT 1`,
      ownerId
    );
    return r ? mapVaultKeyRow(r) : null;
  }

  // ── Delegations (owner -> agent edge) ──

  async createDelegation(input: CreateDelegationInput): Promise<DelegationRow> {
    const id = randomId('del_');
    const now = nowIsoString();
    try {
      await this.db.run(
        `INSERT INTO delegations
           (id, owner_id, agent_id, label, status, authorized_via,
            authorizing_assertion_id, revoke_assertion_id, created_at, revoked_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, NULL)`,
        id,
        input.ownerId,
        input.agentId,
        input.label ?? null,
        input.authorizedVia ?? (input.authorizingAssertionId ? 'assertion' : 'claim'),
        input.authorizingAssertionId ?? null,
        now
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new Error(
          `already delegated: owner ${input.ownerId} already has a delegation for agent ${input.agentId}`
        );
      }
      throw e;
    }
    const row = await this.getDelegationByRowId(id);
    if (!row) throw new Error(`createDelegation: delegation ${id} not found after insert`);
    return row;
  }

  private async getDelegationByRowId(id: string): Promise<DelegationRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM delegations WHERE id = ?`, id);
    return r ? mapDelegationRow(r) : null;
  }

  /**
   * Reactivate the existing (revoked) delegation edge for (owner, agent) in
   * place — used by the claim flow when `init` is re-run for an agent whose
   * delegation was killed. Avoids the UNIQUE(owner_id, agent_id) collision a
   * fresh INSERT would hit. Idempotent.
   */
  async activateDelegation(ownerId: string, agentId: string, label?: string): Promise<DelegationRow> {
    await this.db.run(
      `UPDATE delegations
         SET status = 'active', authorized_via = 'claim', authorizing_assertion_id = NULL,
             revoke_assertion_id = NULL, revoked_at = NULL${label !== undefined ? ', label = ?' : ''}
       WHERE owner_id = ? AND agent_id = ?`,
      ...(label !== undefined ? [label, ownerId, agentId] : [ownerId, agentId]),
    );
    const row = await this.getDelegation(ownerId, agentId);
    if (!row) throw new Error(`activateDelegation: delegation ${ownerId}/${agentId} not found`);
    return row;
  }

  async getDelegation(ownerId: string, agentId: string): Promise<DelegationRow | null> {
    const r = await this.db.get<RawRow>(
      `SELECT * FROM delegations WHERE owner_id = ? AND agent_id = ?`,
      ownerId,
      agentId
    );
    return r ? mapDelegationRow(r) : null;
  }

  async listDelegationsByOwner(ownerId: string): Promise<DelegationRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM delegations WHERE owner_id = ? ORDER BY created_at ASC, id ASC`,
      ownerId
    );
    return rows.map(mapDelegationRow);
  }

  /**
   * Revocation orders awaiting the machine's local kill (0032): revoked
   * delegations no daemon has confirmed yet. The daemon runs the same local
   * kill as `based kill` and confirms back; until then the console shows
   * "cut off at the account" — never "your machine dropped it" on faith.
   */
  async listUnconfirmedRevocations(ownerId: string): Promise<DelegationRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM delegations
       WHERE owner_id = ? AND status = 'revoked' AND daemon_confirmed_at IS NULL
       ORDER BY revoked_at ASC, id ASC`,
      ownerId
    );
    return rows.map(mapDelegationRow);
  }

  /** One-shot confirm (idempotence guard: only an unconfirmed revocation flips). */
  async confirmDelegationKill(ownerId: string, delegationId: string, reportJson: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE delegations SET daemon_confirmed_at = ?, daemon_kill_report = ?
       WHERE id = ? AND owner_id = ? AND status = 'revoked' AND daemon_confirmed_at IS NULL`,
      nowIsoString(),
      reportJson,
      delegationId,
      ownerId
    );
    return res.changes === 1;
  }

  async listDelegationsByAgent(agentId: string): Promise<DelegationRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM delegations WHERE agent_id = ? ORDER BY created_at ASC, id ASC`,
      agentId
    );
    return rows.map(mapDelegationRow);
  }

  async revokeDelegation(input: RevokeDelegationInput): Promise<DelegationRow> {
    await this.db.run(
      `UPDATE delegations
         SET status = 'revoked', revoke_assertion_id = ?, revoked_at = ?
       WHERE id = ?`,
      input.revokeAssertionId,
      input.nowIso,
      input.delegationId
    );
    const row = await this.getDelegationByRowId(input.delegationId);
    if (!row) throw new Error(`revokeDelegation: delegation ${input.delegationId} not found`);
    // The kill must actually kill, server-side too (field-hit: a revived agent
    // showed "Can use: Vercel" chips fed by rows the kill never touched, and a
    // pre-kill approval would have been served to the daemon AFTER its local
    // kill ran — re-granting access to an agent the owner just cut off).
    // Retiring rides the revoke itself so no caller can forget it.
    await this.retireAgentWork(row.owner_id, row.agent_id);
    return row;
  }

  /**
   * Retire every server-side row that could keep a killed agent looking — or
   * becoming — connected: open/approved asks (fed the "Can use" chips),
   * daemon-bound approvals (would apply a grant after the kill), and
   * connect-card rows in any live state (fed the chips and the daemon queue).
   * Terminal statuses ('revoked' / 'cancelled') that every reader's positive
   * filter simply skips. A revived agent starts with an honest empty hand.
   */
  async retireAgentWork(ownerId: string, agentId: string): Promise<{ requests: number; approvals: number; connections: number }> {
    const now = nowIsoString();
    const requests = await this.db.run(
      `UPDATE keyring_requests SET status = 'revoked', decided_at = COALESCE(decided_at, ?)
       WHERE owner_id = ? AND agent_id = ? AND status IN ('pending', 'approved')`,
      now, ownerId, agentId
    );
    const approvals = await this.db.run(
      `UPDATE grant_approvals SET status = 'cancelled'
       WHERE owner_id = ? AND agent_id = ? AND status = 'pending_daemon'`,
      ownerId, agentId
    );
    const connections = await this.db.run(
      `UPDATE pending_connections
       SET status = 'revoked', resolved_at = ?, sealed_secret = ''
       WHERE owner_id = ? AND agent_id = ? AND status IN ('pending', 'processing', 'stored')`,
      now, ownerId, agentId
    );
    return { requests: requests.changes, approvals: approvals.changes, connections: connections.changes };
  }

  // ── Agents (open registry — read-only cross-reference) ──

  /**
   * The grantee's Ed25519 public key from the open `agents` table, or null if the
   * agent is unknown / has no key on file. Used to PIN the sealing target in the
   * grant-approval action (CONTROL_PLANE.md §2.1): the owner signs base58(this).
   */
  async getAgentPublicKey(agentId: string): Promise<Uint8Array | null> {
    const r = await this.db.get<RawRow>(
      `SELECT public_key FROM agents WHERE id = ?`,
      agentId
    );
    if (!r || r.public_key == null) return null;
    return toUint8Array(r.public_key);
  }

  // ── Keyring requests (approvals inbox, migration 0024) ──

  async createKeyringRequest(input: CreateKeyringRequestInput): Promise<KeyringRequestRow> {
    const id = randomId('req_');
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO keyring_requests
         (id, owner_id, agent_id, credential_id, credential_label, provider,
          constraints, note, status, created_at, decided_at, decision_assertion_id, deny_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL)`,
      id,
      input.ownerId,
      input.agentId,
      input.credentialId,
      input.credentialLabel ?? null,
      input.provider ?? null,
      JSON.stringify(input.constraints ?? {}),
      input.note ?? null,
      now
    );
    const row = await this.getKeyringRequest(id);
    if (!row) throw new Error(`createKeyringRequest: request ${id} not found after insert`);
    return row;
  }

  async getKeyringRequest(id: string): Promise<KeyringRequestRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM keyring_requests WHERE id = ?`, id);
    return r ? mapKeyringRequestRow(r) : null;
  }

  async listKeyringRequests(ownerId: string, status?: string): Promise<KeyringRequestRow[]> {
    const rows = status
      ? await this.db.all<RawRow>(
          `SELECT * FROM keyring_requests
           WHERE owner_id = ? AND status = ?
           ORDER BY created_at DESC, id DESC`,
          ownerId,
          status
        )
      : await this.db.all<RawRow>(
          `SELECT * FROM keyring_requests
           WHERE owner_id = ?
           ORDER BY created_at DESC, id DESC`,
          ownerId
        );
    return rows.map(mapKeyringRequestRow);
  }

  /** Record an owner's approve/deny decision. Idempotency is enforced by the
   * route (it only decides a request whose status is still 'pending'). */
  async setRequestDecision(input: SetRequestDecisionInput): Promise<KeyringRequestRow> {
    await this.db.run(
      `UPDATE keyring_requests
         SET status = ?, decided_at = ?, decision_assertion_id = ?, deny_reason = ?
       WHERE id = ?`,
      input.status,
      input.nowIso,
      input.assertionId ?? null,
      input.denyReason ?? null,
      input.id
    );
    const row = await this.getKeyringRequest(input.id);
    if (!row) throw new Error(`setRequestDecision: request ${input.id} not found`);
    return row;
  }

  // ── Grant approvals (ready for the daemon, migration 0024) ──

  async createGrantApproval(input: CreateGrantApprovalInput): Promise<GrantApprovalRow> {
    const id = randomId('gap_');
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO grant_approvals
         (id, owner_id, request_id, agent_id, agent_pubkey, credential_id, constraints,
          nonce, action_hash, assertion_credential_id, authenticator_data,
          client_data_json, signature, assertion_id, status, created_at,
          confirmed_at, daemon_grant_id, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_daemon', ?, NULL, NULL, NULL)`,
      id,
      input.ownerId,
      input.requestId,
      input.agentId,
      input.agentPubkey,
      input.credentialId,
      JSON.stringify(input.constraints ?? {}),
      input.nonce,
      input.actionHash,
      input.assertionCredentialId,
      input.authenticatorData,
      input.clientDataJson,
      input.signature,
      input.assertionId,
      now
    );
    const row = await this.getGrantApproval(id);
    if (!row) throw new Error(`createGrantApproval: approval ${id} not found after insert`);
    return row;
  }

  async getGrantApproval(id: string): Promise<GrantApprovalRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM grant_approvals WHERE id = ?`, id);
    return r ? mapGrantApprovalRow(r) : null;
  }

  /** The approvals the daemon still needs to apply for an owner. */
  async listPendingApprovals(ownerId: string): Promise<GrantApprovalRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM grant_approvals
       WHERE owner_id = ? AND status = 'pending_daemon'
       ORDER BY created_at ASC, id ASC`,
      ownerId
    );
    return rows.map(mapGrantApprovalRow);
  }

  /**
   * Mark an approval confirmed by the daemon — atomic conditional so a confirm
   * can only transition a pending_daemon row (never resurrect a failed one or
   * double-confirm). Returns the row iff it transitioned, else null.
   */
  async confirmGrantApproval(input: {
    id: string;
    daemonGrantId: string;
    nowIso: string;
  }): Promise<GrantApprovalRow | null> {
    const res = await this.db.run(
      `UPDATE grant_approvals
         SET status = 'confirmed', confirmed_at = ?, daemon_grant_id = ?
       WHERE id = ? AND status = 'pending_daemon'`,
      input.nowIso,
      input.daemonGrantId,
      input.id
    );
    if (res.changes !== 1) return null;
    return this.getGrantApproval(input.id);
  }

  /** Mark an approval failed (the daemon rejected/could not apply it). */
  async failGrantApproval(input: {
    id: string;
    reason: string;
    nowIso: string;
  }): Promise<GrantApprovalRow | null> {
    const res = await this.db.run(
      `UPDATE grant_approvals
         SET status = 'failed', confirmed_at = ?, failure_reason = ?
       WHERE id = ? AND status = 'pending_daemon'`,
      input.nowIso,
      input.reason,
      input.id
    );
    if (res.changes !== 1) return null;
    return this.getGrantApproval(input.id);
  }

  // ─── Cloud passport (SANDBOX_SPEC §4b): handoffs + the sealed-credential shelf ───

  async createPassportHandoff(ownerId: string, browserPublicKey: string): Promise<string> {
    const id = randomId('pph_');
    await this.db.run(
      `INSERT INTO passport_handoffs (id, owner_id, browser_public_key, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
      id, ownerId, browserPublicKey, nowIsoString(),
    );
    return id;
  }

  async listPendingPassportHandoffs(ownerId: string): Promise<Array<{ id: string; browser_public_key: string; created_at: string }>> {
    const rows = await this.db.all<RawRow>(
      `SELECT id, browser_public_key, created_at FROM passport_handoffs
       WHERE owner_id = ? AND status = 'pending' ORDER BY created_at ASC`, ownerId);
    return rows.map((r) => ({ id: asStr(r.id), browser_public_key: asStr(r.browser_public_key), created_at: asStr(r.created_at) }));
  }

  /** Daemon fulfilled the handoff with ciphertext sealed to the browser key. */
  async fulfillPassportHandoff(id: string, ownerId: string, sealedPassport: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE passport_handoffs SET sealed_passport = ?, status = 'fulfilled', fulfilled_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'pending'`,
      sealedPassport, nowIsoString(), id, ownerId,
    );
    return res.changes === 1;
  }

  /**
   * One-shot read: return the ciphertext exactly once, then BLANK it. The
   * control plane never keeps a fulfilled passport around, even sealed.
   */
  async consumePassportHandoff(id: string, ownerId: string): Promise<{ status: string; sealed_passport: string | null }> {
    const row = await this.db.get<RawRow>(
      `SELECT status, sealed_passport FROM passport_handoffs WHERE id = ? AND owner_id = ?`, id, ownerId);
    if (!row) return { status: 'not_found', sealed_passport: null };
    const status = asStr(row.status);
    if (status !== 'fulfilled') return { status, sealed_passport: null };
    const sealed = asNullableStr(row.sealed_passport);
    await this.db.run(
      `UPDATE passport_handoffs SET sealed_passport = '', status = 'consumed' WHERE id = ? AND owner_id = ? AND status = 'fulfilled'`,
      id, ownerId,
    );
    return { status: 'fulfilled', sealed_passport: sealed };
  }

  /** True once any handoff was ever fulfilled — the owner is cloud-enabled and daemons may deposit. */
  async hasFulfilledPassport(ownerId: string): Promise<boolean> {
    const row = await this.db.get<RawRow>(
      `SELECT COUNT(*) AS n FROM passport_handoffs WHERE owner_id = ? AND status IN ('fulfilled','consumed')`, ownerId);
    return Number(row?.n ?? 0) > 0;
  }

  /**
   * Whole-snapshot shelf deposit: upsert everything given, delete everything
   * absent — so local revocation/removal propagates to the shelf as absence.
   */
  async putShelfSnapshot(ownerId: string, rows: Array<{ credential_id: string; v: number; meta: string; sealed: string; grants: string }>): Promise<void> {
    const keep = new Set(rows.map((r) => r.credential_id));
    const existing = await this.db.all<RawRow>(
      `SELECT credential_id FROM sealed_credentials WHERE owner_id = ?`, ownerId);
    for (const r of existing) {
      const id = asStr(r.credential_id);
      if (!keep.has(id)) {
        await this.db.run(`DELETE FROM sealed_credentials WHERE owner_id = ? AND credential_id = ?`, ownerId, id);
      }
    }
    for (const r of rows) {
      await this.db.run(
        `INSERT INTO sealed_credentials (owner_id, credential_id, v, meta, sealed, grants, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, credential_id) DO UPDATE SET v=excluded.v, meta=excluded.meta, sealed=excluded.sealed, grants=excluded.grants, updated_at=excluded.updated_at`,
        ownerId, r.credential_id, r.v, r.meta, r.sealed, r.grants, nowIsoString(),
      );
    }
  }

  async listShelf(ownerId: string): Promise<Array<{ credential_id: string; v: number; meta: string; sealed: string; grants: string; updated_at: string }>> {
    const rows = await this.db.all<RawRow>(
      `SELECT credential_id, v, meta, sealed, grants, updated_at FROM sealed_credentials WHERE owner_id = ? ORDER BY credential_id ASC`, ownerId);
    return rows.map((r) => ({
      credential_id: asStr(r.credential_id), v: Number(r.v), meta: asStr(r.meta),
      sealed: asStr(r.sealed), grants: asStr(r.grants), updated_at: asStr(r.updated_at),
    }));
  }
}
