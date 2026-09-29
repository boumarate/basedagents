/**
 * Owner (human) task routes — compose, list, review (accept / changes /
 * dispute / cancel) over the shared task service, next to the AgentSig routes
 * so cross-family invariants (an agent cannot review a human's task; a human's
 * task is claimed and delivered by agents like any other) are asserted in one
 * place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { drainOutbox } from '../events/service.js';
import { setupTestDb, createTestAgent, signRequest, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { ControlStore } from './store.js';
import { resetCertificationProbeForTests } from './certification.js';
import {
  enablePaymentsForTests, disablePaymentsForTests, resetPaymentsForTests, paymentHeaderFor,
  TEST_WALLET, TEST_PAYER, TEST_TX, type FakeFacilitator,
} from '../payments/test-fixtures.js';
import type { PaymentRequirementsV2 } from '../payments/x402.js';
import { houseWalletFromPrivateKey, parseHousePrivateKey, recoverAuthorizationSigner, setHouseWalletForTests } from '../payments/house-wallet.js';
import { sha256, bytesToHex, canonicalJsonStringify } from '../crypto/index.js';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { base64urlEncode, base64urlDecode, actionChallenge } from './webauthn.js';
import { armActionChallenge } from './routes.js';
import ownerTaskRoutes from './tasks.js';
import taskRoutes from '../routes/tasks.js';
import agentRoutes from '../routes/agents.js';

vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const sha256hex = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s)));

// ─── minimal WebAuthn authenticator (mirrors ladder.test.ts) so we can forge
//     the passkey assertion that posting a task now requires ───
const te = new TextEncoder();
const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';
type CborType = Parameters<typeof isoCBOR.encode>[0];
function concat(...arrs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
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
class Authenticator {
  private counter = 0;
  private constructor(private privateKey: CryptoKey, readonly cose: Uint8Array, readonly credentialId: string) {}
  static async create(): Promise<Authenticator> {
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, base64urlDecode(jwk.x!)], [-3, base64urlDecode(jwk.y!)]]) as CborType,
    );
    const rawId = new Uint8Array(16);
    globalThis.crypto.getRandomValues(rawId);
    return new Authenticator(kp.privateKey, cose as Uint8Array, base64urlEncode(rawId));
  }
  async assert(challenge: string): Promise<{ credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }> {
    this.counter += 1;
    const rpIdHash = sha256(te.encode(RP_ID));
    const authData = concat(rpIdHash, new Uint8Array([0x05]), u32be(this.counter));
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

describe('Owner task routes', () => {
  let db: SQLiteAdapter;
  let app: Hono<AppEnv>;
  /** Extra bindings for one test (reset before each). */
  let extraEnv: Record<string, string> = {};
  let store: ControlStore;
  let agent: TestKeypair & { name: string };
  const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

  async function installControlTables(): Promise<void> {
    for (const f of ['0023_owner_accounts.sql', '0025_owner_recovery.sql', '0027_authority_ladder.sql']) {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
    }
    resetCertificationProbeForTests();
  }

  let ownerSeq = 0;
  // Per-cookie owner + registered passkey, so compose() can sign the create
  // ceremony that posting now requires. Reset each test in beforeEach.
  let sessions: Map<string, { ownerId: string; auth: Authenticator }>;
  /**
   * An active owner with an email-rung session AND a registered passkey (posting
   * a task requires a signature). Returns the Cookie header value.
   */
  async function ownerSession(displayName = 'Max'): Promise<{ ownerId: string; cookie: string }> {
    const ownerId = `ow_test${++ownerSeq}`;
    await db.run(`INSERT INTO owners (id, status, display_name) VALUES (?, 'active', ?)`, ownerId, displayName);
    const token = `tok_${ownerId}_${Math.random().toString(36).slice(2)}`;
    await store.createSession({ ownerId, tokenHash: sha256hex(token), method: 'email', ttlSeconds: 3600 });
    const auth = await Authenticator.create();
    await store.addCredential({ ownerId, credentialId: auth.credentialId, publicKey: auth.cose, counter: 0, backedUp: true });
    const cookie = `ba_owner_session=${token}`;
    sessions.set(cookie, { ownerId, auth });
    return { ownerId, cookie };
  }

  /** Run the create ceremony for `fields` as the cookie's owner → {nonce, assertion}. */
  async function signCreate(cookie: string, fields: Record<string, unknown>): Promise<{ nonce: string; assertion: unknown }> {
    const s = sessions.get(cookie);
    if (!s) throw new Error('no session for cookie');
    const nonce = base64urlEncode((() => { const b = new Uint8Array(16); crypto.getRandomValues(b); return b; })());
    const actionType = `task.create:${sha256hex(canonicalJsonStringify(fields))}`;
    const canonical = canonicalJsonStringify({ action_type: actionType, owner_id: s.ownerId, nonce });
    const actionHash = actionChallenge(canonical);
    await armActionChallenge(db, s.ownerId, actionType, actionHash);
    const assertion = await s.auth.assert(actionHash);
    return { nonce, assertion };
  }

  async function ownerPost(path: string, body: unknown, cookie?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      body: JSON.stringify(body),
    });
  }
  async function ownerGet(path: string, cookie?: string): Promise<Response> {
    return app.request(path, { headers: cookie ? { Cookie: cookie } : {} });
  }

  /** Sign `fields` as the cookie's owner and POST them; returns the raw Response. */
  async function composeRaw(cookie: string, fields: Record<string, unknown>): Promise<Response> {
    const signed = await signCreate(cookie, fields);
    return ownerPost('/v1/owner/tasks', { ...fields, ...signed }, cookie);
  }

  async function compose(cookie: string, overrides: Record<string, unknown> = {}): Promise<string> {
    // The signature is WYSIWYS over exactly these posted fields (the server
    // hashes the raw posted body, so no schema-default drift to match).
    const fields = {
      title: 'Reproduce the quickstart', description: 'Follow README on a clean machine and report where it breaks',
      category: 'code', required_capabilities: ['code'], output_format: 'json', ...overrides,
    };
    const res = await composeRaw(cookie, fields);
    expect(res.status).toBe(200);
    return ((await res.json()) as { task_id: string }).task_id;
  }

  async function agentPost(kp: TestKeypair, path: string, body?: unknown): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signRequest(kp, 'POST', path, text);
    return app.request(path, { method: 'POST', headers: { ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: text });
  }
  async function claimAndDeliver(taskId: string, summary = 'Done'): Promise<void> {
    expect((await agentPost(agent, `/v1/tasks/${taskId}/claim`)).status).toBe(200);
    expect((await agentPost(agent, `/v1/tasks/${taskId}/deliver`, { summary, submission_type: 'json', submission_content: '{}' })).status).toBe(200);
  }

  beforeEach(async () => {
    extraEnv = {};
    db = setupTestDb();
    await installControlTables();
    store = new ControlStore(db);
    ownerSeq = 0;
    sessions = new Map();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      (c.env as AppEnv['Bindings']) = { ...(c.env ?? {}), PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64), CLAIM_BOND_REQUIRED: '0', ...extraEnv } as AppEnv['Bindings'];
      await next();
    });
    app.route('/v1/owner', ownerTaskRoutes);
    app.route('/v1/tasks', taskRoutes);
    app.route('/v1/agents', agentRoutes);
    agent = await createTestAgent(db, { status: 'active', capabilities: ['code'] });
  });

  afterEach(() => { resetPaymentsForTests(); vi.unstubAllGlobals(); });

  it('requires a session → 401', async () => {
    expect((await ownerPost('/v1/owner/tasks', { title: 'x', description: 'y' })).status).toBe(401);
    expect((await ownerGet('/v1/owner/tasks')).status).toBe(401);
  });

  it('composes an unpaid task as the owner; public reads show a human creator and no owner id', async () => {
    const { ownerId, cookie } = await ownerSession('Max F');
    const taskId = await compose(cookie);
    const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', taskId);
    expect(row!.creator_kind).toBe('owner');
    expect(row!.creator_owner_id).toBe(ownerId);
    expect(row!.creator_agent_id).toBeNull();
    expect(row!.payment_status).toBe('none');

    const pub = (await (await app.request(`/v1/tasks/${taskId}`)).json()) as { task: Record<string, unknown> };
    // Posting now requires a passkey, so the poster reads as a certified human.
    expect(pub.task.creator).toEqual({ kind: 'owner', id: null, short_id: null, name: 'Max F', cert: 'certified_human' });
    expect(pub.task).not.toHaveProperty('creator_owner_id');
    expect(pub.task.creator_agent_id).toBeNull();
    const funnel = await db.all<{ event: string; provider: string }>('SELECT event, provider FROM funnel_events WHERE funnel_id = ?', taskId);
    expect(funnel).toEqual([{ event: 'task_posted', provider: 'human' }]);
  });

  it('rejects unknown fields at the schema (strict)', async () => {
    const { cookie } = await ownerSession();
    expect((await ownerPost('/v1/owner/tasks', { title: 'x', description: 'y', evil: 1 }, cookie)).status).toBe(400);
  });

  it('requires a passkey signature to post → 401 passkey_required (session alone is not enough)', async () => {
    const { cookie } = await ownerSession();
    const res = await ownerPost('/v1/owner/tasks', { title: 'x', description: 'y', output_format: 'json' }, cookie);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('passkey_required');
    // nothing was written
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks'))!.n).toBe(0);
  });

  it('a signed post records the creator assertion on the task', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    const row = await db.get<{ creator_assertion_id: string | null }>('SELECT creator_assertion_id FROM tasks WHERE task_id = ?', taskId);
    expect(row!.creator_assertion_id).toBeTruthy();
  });

  it('refuses a bounty when payments are not enabled → 503 payments_unavailable', async () => {
    disablePaymentsForTests();
    const { cookie } = await ownerSession();
    // Signed (posting requires a passkey); the 503 is returned before the ceremony runs.
    const res = await composeRaw(cookie, { title: 'x', description: 'y', output_format: 'json', bounty: { amount: '5000000' } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('payments_unavailable');
  });

  it('refuses a bounty under the minimum (D3) before the escrow challenge: no 402, nothing to sign', async () => {
    enablePaymentsForTests();
    const { cookie } = await ownerSession();
    for (const escrow of [undefined, false]) {
      const res = await ownerPost('/v1/owner/tasks', {
        title: 'Tiny', description: 'x', output_format: 'json', ...(escrow === undefined ? {} : { escrow }),
        bounty: { amount: '99999', token: 'USDC', network: 'eip155:8453' },
      }, cookie);
      expect(res.status).toBe(400);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(await res.json()).toMatchObject({ error: 'bounty_below_minimum', minimum_amount: '100000', minimum_usdc: '0.10' });
    }
    // MIN_BOUNTY_ATOMIC_HUMAN sets the console floor on its own.
    extraEnv = { MIN_BOUNTY_ATOMIC_HUMAN: '5000000' };
    const raised = await composeRaw(cookie, { title: 'x', description: 'y', output_format: 'json', escrow: false, bounty: { amount: '1000000' } });
    expect(raised.status).toBe(400);
    expect(await raised.json()).toMatchObject({ error: 'bounty_below_minimum', minimum_usdc: '5.00' });
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks'))!.n).toBe(0);
  });

  it('composes a bounty task when payments are enabled: stores the bounty, payment_status=pending, declares it', async () => {
    enablePaymentsForTests();
    const { cookie } = await ownerSession();
    const res = await composeRaw(cookie, {
      title: 'Paid task', description: 'do it', category: 'code', output_format: 'json',
      bounty: { amount: '100000', token: 'USDC', network: 'eip155:8453' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task_id: string; payment_status: string; bounty: { amount_atomic: string; amount_display: string } };
    expect(body.payment_status).toBe('pending');
    expect(body.bounty.amount_atomic).toBe('100000');
    expect(body.bounty.amount_display).toBe('0.10');

    const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', body.task_id);
    expect(row!.bounty_amount).toBe('100000');
    expect(row!.bounty_token).toBe('USDC');
    expect(row!.bounty_network).toBe('eip155:8453');
    expect(row!.payment_status).toBe('pending');
    const funnel = await db.all<{ event: string }>('SELECT event FROM funnel_events WHERE funnel_id = ?', body.task_id);
    expect(funnel.map((f) => f.event)).toEqual(['task_posted']);
    const pay = await db.all<{ event_type: string }>('SELECT event_type FROM payment_events WHERE task_id = ? ORDER BY created_at', body.task_id);
    expect(pay.map((p) => p.event_type)).toEqual(['bounty_declared']);
  });

  // ─── Escrow (Tasks P1): the human deposits at post, accepts without a wallet ───
  describe('escrow: deposit at post, release on accept, refund on cancel', () => {
    /** Hardhat account #0 — a public test key. */
    const house = houseWalletFromPrivateKey(parseHousePrivateKey('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'));
    const HOUSE_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const REFUND_TX = '0x' + 'ef'.repeat(32);
    let facilitator: FakeFacilitator;
    const FIELDS = {
      title: 'Escrowed', description: 'Deposit first', category: 'code', required_capabilities: ['code'], output_format: 'json',
      bounty: { amount: '100000', token: 'USDC', network: 'eip155:8453' },
    };

    beforeEach(async () => {
      facilitator = enablePaymentsForTests();
      setHouseWalletForTests(house);
      await db.run('UPDATE agents SET wallet_address = ?, wallet_network = ? WHERE id = ?', TEST_WALLET, 'eip155:8453', agent.agentId);
    });
    afterEach(() => { setHouseWalletForTests(undefined); });

    /** The console's sequence: POST → 402 → wallet signs the deposit → passkey signs the post → POST with both. */
    async function composeEscrow(cookie: string, fields: Record<string, unknown> = FIELDS): Promise<{ taskId: string; body: Record<string, unknown> }> {
      const challenge = await ownerPost('/v1/owner/tasks', fields, cookie);
      expect(challenge.status).toBe(402);
      const decoded = JSON.parse(Buffer.from(challenge.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8')) as { accepts: PaymentRequirementsV2[] };
      expect(decoded.accepts[0].payTo).toBe(HOUSE_ADDR);
      const signed = await signCreate(cookie, fields);
      const res = await ownerPost('/v1/owner/tasks', { ...fields, ...signed }, cookie, { 'PAYMENT-SIGNATURE': paymentHeaderFor(decoded.accepts[0]) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      return { taskId: body.task_id as string, body };
    }

    it('the 402 challenge consumes nothing: no task, no rate-limit slot, no passkey challenge', async () => {
      const { cookie } = await ownerSession();
      const res = await ownerPost('/v1/owner/tasks', FIELDS, cookie);
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string; escrow: { wallet: string }; accepts: PaymentRequirementsV2[] };
      expect(body.error).toBe('payment_required');
      expect(body.escrow.wallet).toBe(HOUSE_ADDR);
      expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 0 });
      expect(await db.get('SELECT count(*) AS n FROM rate_limit_log')).toEqual({ n: 0 });
      expect(facilitator.verifyCalls).toHaveLength(0);
    });

    it('composes a funded escrow task the passkey signed, owned by the human; a header without the passkey is still refused', async () => {
      const { cookie, ownerId } = await ownerSession();
      const { taskId, body } = await composeEscrow(cookie);
      expect(body.escrow).toMatchObject({ status: 'funded', wallet: HOUSE_ADDR, deposit_tx_hash: TEST_TX });
      expect(body.claimable).toBe(true);
      const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', taskId);
      expect(row!.creator_owner_id).toBe(ownerId);
      expect(row!.creator_kind).toBe('owner');
      expect(row!.creator_assertion_id).not.toBeNull();
      expect(row!.escrow).toBe(1);
      expect(row!.escrow_status).toBe('funded');
      expect(row!.escrow_deposit_payer).toBe(TEST_PAYER);
      // The detail read shows the custody record to the buyer.
      const detail = (await (await ownerGet(`/v1/owner/tasks/${taskId}`, cookie)).json()) as { task: { escrow: { status: string } }; payment: { escrow: { status: string } } };
      expect(detail.task.escrow.status).toBe('funded');
      expect(detail.payment.escrow.status).toBe('funded');

      // Passkey required even with a valid deposit: nothing is written.
      const challenge = await ownerPost('/v1/owner/tasks', FIELDS, cookie);
      const decoded = JSON.parse(Buffer.from(challenge.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8')) as { accepts: PaymentRequirementsV2[] };
      const noPasskey = await ownerPost('/v1/owner/tasks', FIELDS, cookie, { 'PAYMENT-SIGNATURE': paymentHeaderFor(decoded.accepts[0]) });
      expect(noPasskey.status).toBe(401);
      expect(await db.get('SELECT count(*) AS n FROM tasks')).toEqual({ n: 1 });
    });

    it('accepting releases the deposit to the deliverer with no wallet prompt; a payment header is refused', async () => {
      const { cookie } = await ownerSession();
      const { taskId } = await composeEscrow(cookie);
      await claimAndDeliver(taskId);
      const withHeader = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, {}, cookie, { 'PAYMENT-SIGNATURE': 'x' });
      expect(withHeader.status).toBe(400);
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { note: 'ship it' }, cookie);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; accepted_by: string; payment_status: string; payment_tx_hash: string; escrow: { status: string } };
      expect(data.status).toBe('verified');
      expect(data.accepted_by).toBe('creator');
      expect(data.payment_status).toBe('settled');
      expect(data.payment_tx_hash).toBe(TEST_TX);
      expect(data.escrow.status).toBe('released');
      const release = facilitator.settleCalls[1];
      expect(release.requirements.payTo).toBe(TEST_WALLET);
      expect(release.payload.payload.authorization.from).toBe(HOUSE_ADDR);
      expect(recoverAuthorizationSigner(release.payload)).toBe(HOUSE_ADDR);
      const row = await db.get<Record<string, unknown>>('SELECT review_note, escrow_status, escrow_release_tx_hash FROM tasks WHERE task_id = ?', taskId);
      expect(row).toEqual({ review_note: 'ship it', escrow_status: 'released', escrow_release_tx_hash: TEST_TX });
    });

    it('cancelling a funded task refunds the wallet that paid the deposit', async () => {
      const { cookie } = await ownerSession();
      const { taskId } = await composeEscrow(cookie);
      facilitator.settleOutcomes = [{ kind: 'settled', transaction: REFUND_TX, network: 'eip155:8453', payer: HOUSE_ADDR }];
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/cancel`, {}, cookie);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; payment_status: string; escrow: { status: string }; refund_tx_hash: string };
      expect(data.status).toBe('cancelled');
      expect(data.payment_status).toBe('refunded');
      expect(data.escrow.status).toBe('refunded');
      expect(data.refund_tx_hash).toBe(REFUND_TX);
      expect(facilitator.settleCalls[1].requirements.payTo).toBe(TEST_PAYER);
    });

    it('escrow: false keeps the pay-at-accept flow; an explicit escrow: true without a house wallet → 503', async () => {
      const { cookie } = await ownerSession();
      const res = await composeRaw(cookie, { ...FIELDS, escrow: false });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payment_status: string; escrow: null };
      expect(body.payment_status).toBe('pending');
      expect(body.escrow).toBeNull();
      setHouseWalletForTests(null);
      const explicit = await ownerPost('/v1/owner/tasks', { ...FIELDS, escrow: true }, cookie);
      expect(explicit.status).toBe(503);
      expect(((await explicit.json()) as { error: string }).error).toBe('escrow_unavailable');
      // Omitted escrow on a registry without a house wallet: the old flow, no 402.
      expect((await composeRaw(cookie, FIELDS)).status).toBe(200);
    });

    it('funds an unfunded task again via POST /v1/owner/tasks/:id/fund', async () => {
      const { cookie } = await ownerSession();
      facilitator.settleOutcomes = [{ kind: 'rejected', reason: 'invalid_exact_evm_payload_signature', http: 200 }];
      const { taskId, body } = await composeEscrow(cookie);
      expect((body.escrow as { status: string }).status).toBe('unfunded');
      facilitator.settleOutcomes = [];
      const challenge = await ownerPost(`/v1/owner/tasks/${taskId}/fund`, {}, cookie);
      expect(challenge.status).toBe(402);
      const decoded = JSON.parse(Buffer.from(challenge.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8')) as { accepts: PaymentRequirementsV2[] };
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/fund`, {}, cookie, { 'PAYMENT-SIGNATURE': paymentHeaderFor(decoded.accepts[0]) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { escrow: { status: string } }).escrow.status).toBe('funded');
      // Not mine → 404, never 403.
      const { cookie: other } = await ownerSession('Other');
      expect((await ownerPost(`/v1/owner/tasks/${taskId}/fund`, {}, other)).status).toBe(404);
    });
  });

  // ─── Owner accept-and-pay (x402, sign-at-accept) ───
  describe('accepting a delivered bounty and paying it', () => {
    let facilitator: FakeFacilitator;

    async function deliveredBounty(cookie: string): Promise<{ taskId: string; requirements: PaymentRequirementsV2 }> {
      // The deliverer needs a receiving wallet on file (the bounty's payTo).
      await db.run('UPDATE agents SET wallet_address = ?, wallet_network = ? WHERE id = ?', TEST_WALLET, 'eip155:8453', agent.agentId);
      const taskId = await compose(cookie, { bounty: { amount: '100000', token: 'USDC', network: 'eip155:8453' } });
      await claimAndDeliver(taskId);
      // Pull the x402 requirements from the 402 challenge (no header → challenge).
      const challenge = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { note: 'looks good' }, cookie);
      expect(challenge.status).toBe(402);
      const header = challenge.headers.get('PAYMENT-REQUIRED')!;
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts: PaymentRequirementsV2[] };
      expect(decoded.accepts[0].payTo).toBe(TEST_WALLET);
      return { taskId, requirements: decoded.accepts[0] };
    }

    beforeEach(() => { facilitator = enablePaymentsForTests(); });

    it('without a payment header → 402 challenge, task still submitted, facilitator untouched', async () => {
      const { cookie } = await ownerSession();
      await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', TEST_WALLET, agent.agentId);
      const taskId = await compose(cookie, { bounty: { amount: '100000' } });
      await claimAndDeliver(taskId);
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, {}, cookie);
      expect(res.status).toBe(402);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('payment_required');
      const row = await db.get<Record<string, unknown>>('SELECT status, payment_status FROM tasks WHERE task_id = ?', taskId);
      expect(row!.status).toBe('submitted');
      expect(row!.payment_status).toBe('pending');
      expect(facilitator.verifyCalls.length).toBe(0);
    });

    it('with a valid wallet signature → verified + settled in one call', async () => {
      const { cookie, ownerId } = await ownerSession();
      const { taskId, requirements } = await deliveredBounty(cookie);
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { note: 'ship it' }, cookie, {
        'PAYMENT-SIGNATURE': paymentHeaderFor(requirements),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; accepted_by: string; payment_status: string; payment_tx_hash: string };
      expect(data.status).toBe('verified');
      expect(data.accepted_by).toBe('creator');
      expect(data.payment_status).toBe('settled');
      expect(data.payment_tx_hash).toBe(TEST_TX);
      expect(res.headers.get('PAYMENT-RESPONSE')).not.toBeNull();

      const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', taskId);
      expect(row!.status).toBe('verified');
      expect(row!.review_note).toBe('ship it');
      expect(row!.payment_status).toBe('settled');
      expect(row!.payment_tx_hash).toBe(TEST_TX);
      expect(row!.creator_owner_id).toBe(ownerId);
      expect(facilitator.verifyCalls.length).toBe(1);
      expect(facilitator.settleCalls.length).toBe(1);
    });

    it('refuses to pay when the deliverer removed their wallet after claiming → 409 payee_wallet_missing', async () => {
      const { cookie } = await ownerSession();
      // Claim requires a wallet, so set one, then clear it before the owner pays.
      await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', TEST_WALLET, agent.agentId);
      const taskId = await compose(cookie, { bounty: { amount: '100000' } });
      await claimAndDeliver(taskId);
      await db.run('UPDATE agents SET wallet_address = NULL WHERE id = ?', agent.agentId);
      const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, {}, cookie);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('payee_wallet_missing');
    });
  });

  it('enforces the creator XOR at the schema level', async () => {
    await expect(db.run(
      `INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, creator_kind, title, description, status, created_at)
       VALUES ('task_xor', ?, 'ow_x', 'owner', 't', 'd', 'open', '2026-09-08T00:00:00Z')`, agent.agentId,
    )).rejects.toThrow();
  });

  it('lists only my tasks with the latest receipt and needs_review; 404 for another owner', async () => {
    const a = await ownerSession('A');
    const b = await ownerSession('B');
    const mine = await compose(a.cookie);
    await compose(b.cookie);
    await claimAndDeliver(mine, 'First cut');

    const list = (await (await ownerGet('/v1/owner/tasks', a.cookie)).json()) as { tasks: Array<Record<string, unknown>> };
    expect(list.tasks.map((t) => t.task_id)).toEqual([mine]);
    expect(list.tasks[0].needs_review).toBe(true);
    expect(list.tasks[0].claimer_name).toBe(agent.name);
    expect((list.tasks[0].latest_receipt as Record<string, unknown>).summary).toBe('First cut');
    expect(list.tasks[0]).not.toHaveProperty('creator_owner_id');

    expect((await ownerGet(`/v1/owner/tasks/${mine}`, b.cookie)).status).toBe(404);
    expect((await ownerPost(`/v1/owner/tasks/${mine}/accept`, {}, b.cookie)).status).toBe(404);
    const detail = (await (await ownerGet(`/v1/owner/tasks/${mine}`, a.cookie)).json()) as { task: Record<string, unknown>; receipts: unknown[]; delivery_receipt: Record<string, unknown> };
    expect(detail.receipts).toHaveLength(1);
    expect(detail.delivery_receipt.summary).toBe('First cut');
    expect(detail.task.review_state).toBeNull();
  });

  it('accept → verified, the deliverer gains reputation, and an agent cannot accept a human task', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId);
    await db.run('UPDATE agents SET reputation_score = 0 WHERE id = ?', agent.agentId);

    // The AgentSig route family refuses to review a human-posted task.
    const viaAgent = await agentPost(agent, `/v1/tasks/${taskId}/accept`);
    expect(viaAgent.status).toBe(403);

    const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { note: 'Nice' }, cookie);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status).toBe('verified');
    expect(data.accepted_by).toBe('creator');
    expect(data.chain_sequence).toBeTypeOf('number');
    const row = await db.get<{ status: string; review_note: string; accepted_by: string }>('SELECT status, review_note, accepted_by FROM tasks WHERE task_id = ?', taskId);
    expect(row).toEqual({ status: 'verified', review_note: 'Nice', accepted_by: 'creator' });
    const score = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', agent.agentId);
    expect(score!.reputation_score).toBeGreaterThan(0);
    // idempotent
    expect((await ownerPost(`/v1/owner/tasks/${taskId}/accept`, {}, cookie)).status).toBe(200);
  });

  it('accept and dispute take an optional rating (D11); unknown fields are still refused', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId);
    expect((await ownerPost(`/v1/owner/tasks/${taskId}/dispute`, { reason: 'Missing tests', rating: 9 }, cookie)).status).toBe(400);
    const disputed = await ownerPost(`/v1/owner/tasks/${taskId}/dispute`, { reason: 'Missing tests', rating: 2 }, cookie);
    expect(disputed.status).toBe(200);
    expect(((await disputed.json()) as Record<string, unknown>).rating).toBe(2);
    const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { note: 'Fine after all', rating: 4, rating_comment: 'Good once fixed' }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).rating).toBe(4);
    const row = await db.get<Record<string, unknown>>('SELECT rating, rating_comment, rating_context FROM tasks WHERE task_id = ?', taskId);
    expect(row).toEqual({ rating: 4, rating_comment: 'Good once fixed', rating_context: 'accept' });
    expect((await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { rating: 4, stars: 5 }, cookie)).status).toBe(400);
  });

  it('request changes → claimed + review_state; a second delivery adds a receipt; the 4th round is refused', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId, 'v1');
    expect((await ownerPost(`/v1/owner/tasks/${taskId}/revision`, {}, cookie)).status).toBe(400);
    const res = await ownerPost(`/v1/owner/tasks/${taskId}/revision`, { note: 'Add tests' }, cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).review_state).toBe('revision_requested');

    expect((await agentPost(agent, `/v1/tasks/${taskId}/deliver`, { summary: 'v2', submission_type: 'json', submission_content: '{}' })).status).toBe(200);
    const detail = (await (await ownerGet(`/v1/owner/tasks/${taskId}`, cookie)).json()) as { receipts: Array<{ summary: string }>; task: Record<string, unknown> };
    expect(detail.receipts.map((r) => r.summary)).toEqual(['v2', 'v1']);
    expect(detail.task.revision_count).toBe(1);

    for (let i = 0; i < 2; i++) {
      expect((await ownerPost(`/v1/owner/tasks/${taskId}/revision`, { note: `round ${i + 2}` }, cookie)).status).toBe(200);
      expect((await agentPost(agent, `/v1/tasks/${taskId}/deliver`, { summary: `v${i + 3}`, submission_type: 'json', submission_content: '{}' })).status).toBe(200);
    }
    const fourth = await ownerPost(`/v1/owner/tasks/${taskId}/revision`, { note: 'again' }, cookie);
    expect(fourth.status).toBe(409);
    expect(((await fourth.json()) as { error: string }).error).toBe('max_revisions');
  });

  it('dispute freezes auto-accept; cancel needs a dispute first; dispute→cancel counts against the deliverer', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId);
    const early = await ownerPost(`/v1/owner/tasks/${taskId}/cancel`, {}, cookie);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toBe('dispute_first');

    expect((await ownerPost(`/v1/owner/tasks/${taskId}/dispute`, {}, cookie)).status).toBe(400);
    const dispute = await ownerPost(`/v1/owner/tasks/${taskId}/dispute`, { reason: 'Not what I asked' }, cookie);
    expect(dispute.status).toBe(200);
    expect(((await dispute.json()) as Record<string, unknown>).review_state).toBe('disputed');
    const row = await db.get<{ disputed_at: string | null; auto_release_at: string | null }>('SELECT disputed_at, auto_release_at FROM tasks WHERE task_id = ?', taskId);
    expect(row!.disputed_at).not.toBeNull();
    expect(row!.auto_release_at).toBeNull();

    const { runTaskCron } = await import('../cron/tasks.js');
    await runTaskCron(db, { PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64) } as never, new Date(Date.now() + 8 * 24 * 3600_000).toISOString());
    expect((await db.get<{ status: string }>('SELECT status FROM tasks WHERE task_id = ?', taskId))!.status).toBe('submitted');

    const cancel = await ownerPost(`/v1/owner/tasks/${taskId}/cancel`, {}, cookie);
    expect(cancel.status).toBe(200);
    const rep = (await (await app.request(`/v1/agents/${agent.agentId}/reputation`)).json()) as { tasks_failed: number };
    expect(rep.tasks_failed).toBeGreaterThan(0);
  });

  it('the buyer publishes the delivery as a public sample, then makes it private again', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId, 'the delivered sample');

    // Private by default on the public detail.
    let pub = await (await app.request(`/v1/tasks/${taskId}`)).json() as { submission: Record<string, unknown> | null; submission_public: boolean };
    expect(pub.submission_public).toBe(false);
    expect(pub.submission).toBeNull();

    // Publish → the content is public.
    const on = await ownerPost(`/v1/owner/tasks/${taskId}/publish`, { publish: true }, cookie);
    expect(on.status).toBe(200);
    expect(((await on.json()) as { submission_public: boolean }).submission_public).toBe(true);
    pub = await (await app.request(`/v1/tasks/${taskId}`)).json() as typeof pub;
    expect(pub.submission_public).toBe(true);
    expect(pub.submission?.summary).toBe('the delivered sample');

    // Unpublish → private again.
    const off = await ownerPost(`/v1/owner/tasks/${taskId}/publish`, { publish: false }, cookie);
    expect(off.status).toBe(200);
    pub = await (await app.request(`/v1/tasks/${taskId}`)).json() as typeof pub;
    expect(pub.submission_public).toBe(false);
    expect(pub.submission).toBeNull();
  });

  it("publish on someone else's task → 404 (not mine)", async () => {
    const a = await ownerSession('A');
    const b = await ownerSession('B');
    const taskId = await compose(a.cookie);
    await claimAndDeliver(taskId);
    const res = await ownerPost(`/v1/owner/tasks/${taskId}/publish`, { publish: true }, b.cookie);
    expect(res.status).toBe(404);
  });

  it('a half-signed ceremony is refused → 400', async () => {
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await claimAndDeliver(taskId);
    const res = await ownerPost(`/v1/owner/tasks/${taskId}/accept`, { nonce: 'n1' }, cookie);
    expect(res.status).toBe(400);
    expect((await db.get<{ status: string }>('SELECT status FROM tasks WHERE task_id = ?', taskId))!.status).toBe('submitted');
  });

  it('rate-limits composing to 20 per hour → 429', async () => {
    const { cookie } = await ownerSession();
    for (let i = 0; i < 20; i++) await compose(cookie, { title: `t${i}` });
    const res = await ownerPost('/v1/owner/tasks', { title: 'one more', description: 'd' }, cookie);
    expect(res.status).toBe(429);
  });

  it('notifies capability-matching agents when a human posts a task', async () => {
    const hooked = await createTestAgent(db, { status: 'active', capabilities: ['code'], webhookUrl: 'https://hooked.example.com/events' });
    void hooked;
    const { cookie } = await ownerSession();
    const taskId = await compose(cookie);
    await drainOutbox(db, new Date().toISOString());
    await new Promise((r) => setTimeout(r, 10));
    const calls = mockFetch.mock.calls.filter((call: unknown[]) => call[0] === 'https://hooked.example.com/events');
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as { body: string }).body) as { type: string; task: { task_id: string; bounty: unknown } };
    expect(body.type).toBe('task.available');
    expect(body.task.task_id).toBe(taskId);
    expect(body.task.bounty).toBeNull();
  });
});
