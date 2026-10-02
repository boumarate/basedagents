/**
 * Agent Testing — shared test harness. Not shipped: only *.test.ts files
 * import this module (payments/test-fixtures.ts precedent).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * Provides: a full-migration in-memory DB, the composed app (owner control
 * plane + ladder + tasks + testing routes + webhook), a software passkey
 * authenticator (adapted from billing.test.ts), a recording email sender, a
 * scripted in-memory Stripe double, signed webhook delivery, AgentSig worker
 * helpers, and end-to-end flow drivers (buyer signup → intake → quote →
 * checkout → paid; operator ceremonies).
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import * as ed from '@noble/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { bytesToHex as nobleBytesToHex } from '@noble/hashes/utils';

import { SQLiteAdapter } from '../../db/sqlite-adapter.js';
import { runnerMigrationFiles, RUNNER_LOCAL_STATEMENTS } from '../../db/migration-list.js';
import type { AppEnv } from '../../types/index.js';
import { base58Encode, sha256, bytesToHex } from '../../crypto/index.js';
import { base64urlEncode, base64urlDecode } from '../webauthn.js';
import { ownerIdFromVaultPubkey } from '../identity.js';
import type { EmailSender, EmailMessage } from '../email.js';
import ownerRoutes from '../routes.js';
import ladderRoutes from '../ladder.js';
import ownerTaskRoutes from '../tasks.js';
import { stripeWebhookRoutes } from '../billing.js';
import taskRoutes from '../../routes/tasks.js';
import { testingPublicRoutes, testingCustomerRoutes } from './routes.js';
import { testingAdminRoutes } from './admin.js';
import type {
  TestingStripe, TestingCheckoutSession, TestingPaymentIntent, TestingCharge, TestingPrice, TestingRefund,
} from './checkout.js';
import { runTestingJobs } from './jobs.js';
import { resetClaimAllowlistProbeForTests } from '../../tasks/service.js';
import { enablePaymentsForTests, resetPaymentsForTests, type FakeFacilitator } from '../../payments/test-fixtures.js';
import { setHouseWalletForTests, houseWalletFromPrivateKey, parseHousePrivateKey } from '../../payments/house-wallet.js';
import { setTestingTreasuryForTests } from './treasury.js';
import { QuoteScopeSchema, scopeHash as computeScopeHash, type Intake } from './schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'migrations');

const te = new TextEncoder();

/** Minimal assertion so this module works outside vitest (screenshot/demo drivers). */
function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`harness: ${message}`);
}
export const RP_ID = 'basedagents.ai';
export const ORIGIN = 'https://app.basedagents.ai';
export const WEBHOOK_SECRET = 'whsec_test_secret';
export const TEST_PRICE_ID = 'price_testing_audit';

// Distinct fixed keys: escrow custody wallet vs the platform testing treasury.
const HOUSE_KEY = '11'.repeat(32);
const TREASURY_KEY = '22'.repeat(32);

export function sha256hexStr(input: string): string {
  return bytesToHex(sha256(te.encode(input)));
}

// ─── database: the full migration chain, like src/node.ts ───

export function setupFullDb(): SQLiteAdapter {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const file of runnerMigrationFiles(MIGRATIONS_DIR)) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    try {
      raw.exec(sql);
    } catch (e) {
      if (!String((e as Error).message).includes('duplicate column name')) throw e;
    }
  }
  for (const stmt of RUNNER_LOCAL_STATEMENTS) {
    try { raw.exec(stmt); } catch { /* present */ }
  }
  resetClaimAllowlistProbeForTests();
  return new SQLiteAdapter(raw);
}

// ─── software passkey authenticator (billing.test.ts pattern) ───

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

export class Passkey {
  private constructor(
    private privateKey: CryptoKey,
    readonly cose: Uint8Array,
    readonly credentialId: string,
    readonly vaultB58: string,
    readonly ownerId: string,
  ) {}

  static async create(): Promise<Passkey> {
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, base64urlDecode(jwk.x!)], [-3, base64urlDecode(jwk.y!)]]) as CborType,
    );
    const rawId = new Uint8Array(16);
    globalThis.crypto.getRandomValues(rawId);
    const vaultPriv = ed.utils.randomPrivateKey();
    const vaultPub = await ed.getPublicKeyAsync(vaultPriv);
    return new Passkey(kp.privateKey, cose, base64urlEncode(rawId), base58Encode(vaultPub), ownerIdFromVaultPubkey(vaultPub));
  }

  registration(challenge: string): { attestationObject: string; clientDataJSON: string } {
    const rpIdHash = sha256(te.encode(RP_ID));
    const credIdBytes = base64urlDecode(this.credentialId);
    const credIdLen = new Uint8Array([(credIdBytes.length >> 8) & 0xff, credIdBytes.length & 0xff]);
    const attested = concat(new Uint8Array(16), credIdLen, credIdBytes, this.cose);
    const authData = concat(rpIdHash, new Uint8Array([0x5d]), u32be(0), attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, CborType>([['fmt', 'none'], ['attStmt', new Map<string, CborType>()], ['authData', authData]]) as CborType,
    );
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false });
    return { attestationObject: base64urlEncode(attestationObject), clientDataJSON: base64urlEncode(te.encode(clientDataJSON)) };
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

// ─── recording email sender ───

export class RecordingEmail implements EmailSender {
  messages: EmailMessage[] = [];
  failNext = 0;
  async send(message: EmailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated email failure');
    }
    this.messages.push(message);
  }
  /** The most recent message to `to` whose text matches `re`; throws if none. */
  latest(to: string, re: RegExp): EmailMessage {
    const found = [...this.messages].reverse().find((m) => m.to === to && re.test(m.text));
    if (!found) throw new Error(`no email to ${to} matching ${re}`);
    return found;
  }
}

// ─── scripted Stripe double ───

export class MockStripe implements TestingStripe {
  prices = new Map<string, TestingPrice>();
  sessions = new Map<string, TestingCheckoutSession>();
  intents = new Map<string, TestingPaymentIntent>();
  charges = new Map<string, TestingCharge>();
  refunds: Array<TestingRefund & { idempotencyKey: string }> = [];
  sessionByIdemKey = new Map<string, string>();
  customerCount = 0;
  sessionCount = 0;
  /** When set, the next createCheckoutSession throws AFTER creating the session (lost response). */
  loseNextSessionResponse = false;
  /** When set, the next refund reports this status instead of 'pending'. */
  nextRefundStatus: string | null = null;

  constructor() {
    this.prices.set(TEST_PRICE_ID, { id: TEST_PRICE_ID, active: true, currency: 'usd', unit_amount: 20000, type: 'one_time', livemode: false });
  }

  async retrievePrice(priceId: string): Promise<TestingPrice> {
    const p = this.prices.get(priceId);
    if (!p) throw new Error(`no such price ${priceId}`);
    return p;
  }

  async createCustomer(_input: { email?: string; ownerId: string }, idempotencyKey: string): Promise<{ id: string }> {
    return { id: `cus_${idempotencyKey.slice(-8)}_${++this.customerCount}` };
  }

  async createCheckoutSession(
    input: { priceId: string; customerId: string | null; successUrl: string; cancelUrl: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<TestingCheckoutSession> {
    const existing = this.sessionByIdemKey.get(idempotencyKey);
    if (existing) return this.sessions.get(existing)!;
    const price = await this.retrievePrice(input.priceId);
    const id = `cs_test_${++this.sessionCount}`;
    const session: TestingCheckoutSession = {
      id,
      url: `https://checkout.stripe.example/${id}`,
      mode: 'payment',
      status: 'open',
      payment_status: 'unpaid',
      currency: price.currency,
      amount_subtotal: price.unit_amount,
      amount_total: price.unit_amount,
      total_details: { amount_tax: 0 },
      payment_intent: null,
      livemode: false,
      metadata: input.metadata,
    };
    this.sessions.set(id, session);
    this.sessionByIdemKey.set(idempotencyKey, id);
    if (this.loseNextSessionResponse) {
      this.loseNextSessionResponse = false;
      throw new Error('network: response lost after session create');
    }
    return session;
  }

  async retrieveCheckoutSession(sessionId: string): Promise<TestingCheckoutSession> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no such session ${sessionId}`);
    return s;
  }

  async retrievePaymentIntent(id: string): Promise<TestingPaymentIntent> {
    const pi = this.intents.get(id);
    if (!pi) throw new Error(`no such payment intent ${id}`);
    return pi;
  }

  async retrieveCharge(id: string): Promise<TestingCharge> {
    const ch = this.charges.get(id);
    if (!ch) throw new Error(`no such charge ${id}`);
    return ch;
  }

  async createRefund(input: { paymentIntentId: string; amountCents: number }, idempotencyKey: string): Promise<TestingRefund> {
    const replay = this.refunds.find((r) => r.idempotencyKey === idempotencyKey);
    if (replay) return replay;
    const status = this.nextRefundStatus ?? 'pending';
    this.nextRefundStatus = null;
    const pi = this.intents.get(input.paymentIntentId);
    const chargeId = pi?.latest_charge ?? null;
    const refund: TestingRefund & { idempotencyKey: string } = {
      id: `re_${this.refunds.length + 1}`, status, amount: input.amountCents, charge: chargeId, idempotencyKey,
    };
    this.refunds.push(refund);
    if (status !== 'failed' && status !== 'canceled' && chargeId) {
      const charge = this.charges.get(chargeId)!;
      charge.amount_refunded += input.amountCents;
      charge.refunded = charge.amount_refunded >= charge.amount;
    }
    return refund;
  }

  /** Simulate the buyer completing hosted checkout: session paid + PI + charge exist. */
  completePayment(sessionId: string): TestingCheckoutSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no such session ${sessionId}`);
    const piId = `pi_${sessionId}`;
    const chargeId = `ch_${sessionId}`;
    s.payment_status = 'paid';
    s.status = 'complete';
    s.payment_intent = piId;
    this.intents.set(piId, {
      id: piId, status: 'succeeded', amount: s.amount_total ?? 0, currency: s.currency ?? 'usd',
      livemode: false, latest_charge: chargeId, metadata: s.metadata,
    });
    this.charges.set(chargeId, {
      id: chargeId, payment_intent: piId, amount: s.amount_total ?? 0, amount_refunded: 0,
      refunded: false, currency: s.currency ?? 'usd', livemode: false,
    });
    return s;
  }
}

// ─── the harness ───

export interface Harness {
  db: SQLiteAdapter;
  app: Hono<AppEnv>;
  env: Record<string, string>;
  email: RecordingEmail;
  stripe: MockStripe;
  facilitator: FakeFacilitator;
  ceremonies: { count: number };
  now(): string;
  request(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body: unknown, cookie?: string): Promise<Response>;
  get(path: string, cookie?: string): Promise<Response>;
  patch(path: string, body: unknown, cookie?: string): Promise<Response>;
  sendStripeEvent(event: Record<string, unknown>, opts?: { badSignature?: boolean }): Promise<Response>;
  runJobs(): Promise<Awaited<ReturnType<typeof runTestingJobs>>>;
  teardown(): void;
}

export function makeHarness(envOverrides: Record<string, string> = {}): Harness {
  const db = setupFullDb();
  const email = new RecordingEmail();
  const stripe = new MockStripe();
  const facilitator = enablePaymentsForTests();
  setHouseWalletForTests(houseWalletFromPrivateKey(parseHousePrivateKey(HOUSE_KEY)));
  setTestingTreasuryForTests(undefined); // env-derived from TESTING_TREASURY_PRIVATE_KEY below

  const env: Record<string, string> = {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_TESTING_AUDIT: TEST_PRICE_ID,
    TESTING_PRODUCT_ENABLED: '1',
    TESTING_CHECKOUT_ENABLED: '1',
    TESTING_FULFILLMENT_ENABLED: '1',
    TESTING_TREASURY_PRIVATE_KEY: TREASURY_KEY,
    TESTING_OPERATOR_EMAIL: 'ops@example.com',
    PAYMENT_ENCRYPTION_KEY: 'a'.repeat(64),
    CLAIM_BOND_REQUIRED: '0', // fulfillment suites are not about claim bonds
    ...envOverrides,
  };

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    (c.set as (k: string, v: unknown) => void)('emailSender', email);
    (c.set as (k: string, v: unknown) => void)('testingStripe', stripe);
    await next();
  });
  app.route('/v1/owner', ownerRoutes);
  app.route('/v1/owner', ladderRoutes);
  app.route('/v1/owner', ownerTaskRoutes);
  app.route('/v1', stripeWebhookRoutes);
  app.route('/v1/tasks', taskRoutes);
  app.route('/v1/testing', testingPublicRoutes);
  app.route('/v1/owner/testing', testingCustomerRoutes);
  app.route('/v1/owner/admin/testing', testingAdminRoutes);

  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(path, init, env));
  const withBody = (method: string) => (path: string, body: unknown, cookie?: string) =>
    request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });

  return {
    db, app, env, email, stripe, facilitator,
    ceremonies: { count: 0 },
    now: () => new Date().toISOString(),
    request,
    post: withBody('POST'),
    patch: withBody('PATCH'),
    get: (path, cookie) => request(path, { headers: cookie ? { Cookie: cookie } : {} }),
    sendStripeEvent(event, opts = {}) {
      const payload = JSON.stringify(event);
      const t = Math.floor(Date.now() / 1000);
      const secret = opts.badSignature ? 'whsec_WRONG' : WEBHOOK_SECRET;
      const v1 = nobleBytesToHex(hmac(nobleSha256, te.encode(secret), te.encode(`${t}.${payload}`)));
      return request('/v1/stripe/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
        body: payload,
      });
    },
    runJobs: () => runTestingJobs(db, { stripe, emailSender: email, env }, new Date().toISOString()),
    teardown() {
      resetPaymentsForTests();
      setHouseWalletForTests(undefined);
      setTestingTreasuryForTests(undefined);
    },
  };
}

// ─── flow drivers ───

export function sessionCookieOf(res: Response): string {
  const m = /ba_owner_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no session cookie in response');
  return `ba_owner_session=${m[1]}`;
}

let buyerCount = 0;

/** New buyer through the real ladder: /start/email → magic link → /start/finish → /start/buyer. */
export async function signupBuyer(h: Harness, emailAddr = `buyer${++buyerCount}@example.com`): Promise<{ cookie: string; ownerId: string; email: string }> {
  check((await h.post('/v1/owner/start/email', { email: emailAddr })).status === 200, 'start/email failed');
  const mail = h.email.latest(emailAddr, /#t=/);
  const token = /#t=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
  const finish = await h.post('/v1/owner/start/finish', { token });
  check(finish.status === 200, 'start/finish failed');
  const finishBody = (await finish.json()) as { has_account: boolean; start_code?: string };
  if (finishBody.has_account) {
    const cookie = sessionCookieOf(finish);
    const me = (await (await h.get('/v1/owner/me', cookie)).json()) as { owner_id: string };
    return { cookie, ownerId: me.owner_id, email: emailAddr };
  }
  const buyer = await h.post('/v1/owner/start/buyer', { start_code: finishBody.start_code });
  check(buyer.status === 200, 'start/buyer failed');
  const body = (await buyer.json()) as { owner_id: string };
  return { cookie: sessionCookieOf(buyer), ownerId: body.owner_id, email: emailAddr };
}

/** Operator: passkey account + ADMIN_OWNER_IDS entry. */
export async function setupOperator(h: Harness): Promise<{ cookie: string; ownerId: string; passkey: Passkey }> {
  const passkey = await Passkey.create();
  const begin = (await (await h.post('/v1/owner/register/begin', { vault_public_key: passkey.vaultB58, email: `operator-${passkey.ownerId.slice(-6)}@example.com` })).json()) as { options: { challenge: string } };
  const reg = passkey.registration(begin.options.challenge);
  check((await h.post('/v1/owner/register/finish', { vault_public_key: passkey.vaultB58, attestationObject: reg.attestationObject, clientDataJSON: reg.clientDataJSON })).status === 200, 'register/finish failed');
  const loginBegin = (await (await h.post('/v1/owner/login/begin', { owner_id: passkey.ownerId })).json()) as { challenge: string };
  const login = await h.post('/v1/owner/login/finish', await passkey.assert(loginBegin.challenge, ++h.ceremonies.count));
  check(login.status === 200, 'login/finish failed');
  h.env.ADMIN_OWNER_IDS = h.env.ADMIN_OWNER_IDS ? `${h.env.ADMIN_OWNER_IDS},${passkey.ownerId}` : passkey.ownerId;
  return { cookie: sessionCookieOf(login), ownerId: passkey.ownerId, passkey };
}

/** Run the /action/begin ceremony and sign it (fresh, action-bound assertion). */
export async function operatorSign(
  h: Harness,
  op: { cookie: string; passkey: Passkey },
  actionType: string,
  params: Record<string, unknown>,
): Promise<{ nonce: string; assertion: Awaited<ReturnType<Passkey['assert']>> }> {
  const begin = await h.post('/v1/owner/action/begin', { action_type: actionType, params }, op.cookie);
  check(begin.status === 200, 'action/begin failed');
  const body = (await begin.json()) as { challenge: string; nonce: string };
  return { nonce: body.nonce, assertion: await op.passkey.assert(body.challenge, ++h.ceremonies.count) };
}

// ─── workers (AgentSig) ───

export interface Worker {
  agentId: string;
  publicKeyB58: string;
  privateKey: Uint8Array;
}

let workerCount = 0;

export async function registerWorkerAgent(h: Harness, name?: string): Promise<Worker> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyB58 = base58Encode(publicKey);
  const agentId = `ag_${publicKeyB58}`;
  await h.db.run(
    `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, registered_at, status, reputation_score, verification_count, wallet_address, wallet_network)
     VALUES (?, ?, ?, 'testing worker', ?, ?, ?, 'active', 0.5, 0, ?, 'eip155:8453')`,
    agentId, Buffer.from(publicKey), name ?? `worker-${++workerCount}`,
    JSON.stringify(['agent-compatibility-testing']), JSON.stringify(['http']),
    new Date().toISOString(), `0x${'3'.repeat(39)}${workerCount % 10}`,
  );
  return { agentId, publicKeyB58, privateKey };
}

export async function agentSigHeaders(worker: Worker, method: string, path: string, body = ''): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const bodyHash = bytesToHex(sha256(te.encode(body)));
  const message = `${method}:${path}:${timestamp}:${bodyHash}:${nonce}`;
  const sig = await ed.signAsync(te.encode(message), worker.privateKey);
  return {
    Authorization: `AgentSig ${worker.publicKeyB58}:${btoa(String.fromCharCode(...sig))}`,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
}

export async function workerRequest(h: Harness, worker: Worker, method: string, path: string, body?: unknown): Promise<Response> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = await agentSigHeaders(worker, method, path, text);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return h.request(path, { method, headers, body: body === undefined ? undefined : text });
}

// ─── canned inputs ───

export function sampleIntake(overrides: Partial<Intake> = {}): Intake {
  return {
    product_name: 'Acme Metrics API',
    product_category: 'api',
    product_url: 'https://sandbox.acme.example',
    documentation_url: 'https://docs.acme.example/quickstart',
    workflow_objective: 'Create an API key-less sandbox session, submit the sample metric payload, and read back the computed daily aggregate.',
    expected_result: 'GET /v1/aggregates/daily returns {"total": 42} for the fixture payload.',
    fixture: { classification: 'synthetic', inline: '{"metrics":[{"name":"a","value":40},{"name":"b","value":2}]}' },
    target_environment: 'https://sandbox.acme.example (public sandbox), release 2026-09',
    release_identifier: '2026-09',
    auth_mode: 'none',
    allowed_operations: { read_only: true, sandbox_write_steps: [] },
    coverage_preferences: ['claude-code/mcp', 'openhands/http'],
    known_constraints: 'Sandbox rate limit 60 rpm; resets nightly.',
    authority_declaration: true,
    worker_disclosure_acknowledged: true,
    suspected_failure: '',
    ...overrides,
  } as Intake;
}

export function sampleScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.0',
    workflow_objective: 'Create a sandbox session, submit the sample metric payload, read back the daily aggregate.',
    expected_result: 'GET /v1/aggregates/daily returns {"total": 42} for the fixture payload.',
    allowed_origins: ['https://sandbox.acme.example'],
    documentation_url: 'https://docs.acme.example/quickstart',
    release_identifier: '2026-09',
    auth_mode: 'none',
    read_only: true,
    sandbox_write_steps: [],
    fixture: { classification: 'synthetic', inline: '{"metrics":[{"name":"a","value":40},{"name":"b","value":2}]}' },
    environment_slots: [
      { client: 'claude-code', transport: 'mcp', native_execution_required: true, notes: '' },
      { client: 'openhands', transport: 'http', native_execution_required: true, notes: '' },
      { client: 'aider', transport: 'http', native_execution_required: true, notes: '' },
    ],
    max_requests: 100,
    max_execution_seconds: 1200,
    constraints_note: 'Sandbox rate limit 60 rpm.',
    ...overrides,
  };
}

/** A valid worker-result document for `brief`, hashing evidence contents properly. */
export function buildWorkerResult(brief: {
  assignment_id: string; scope_hash: string; environment_requirement: { client: string; transport: string };
}, opts: { outcome?: 'product_success' | 'product_failure' | 'inconclusive'; failureStage?: string; evidenceSalt?: string } = {}): Record<string, unknown> {
  const outcome = opts.outcome ?? 'product_success';
  const started = new Date(Date.now() - 10 * 60_000).toISOString();
  const finished = new Date(Date.now() - 60_000).toISOString();
  const content1 = `GET https://sandbox.acme.example/v1/aggregates/daily -> 200 {"total": 42} [${opts.evidenceSalt ?? brief.assignment_id}]`;
  const content2 = `docs quickstart followed; session created without credentials [${opts.evidenceSalt ?? brief.assignment_id}]`;
  return {
    schema_version: '1.0',
    assignment_id: brief.assignment_id,
    scope_hash: brief.scope_hash,
    started_at: started,
    finished_at: finished,
    outcome,
    environment: {
      client_name: brief.environment_requirement.client,
      client_version: '1.4.2',
      runtime: 'node 22.4',
      os: 'linux',
      architecture: 'x86_64',
      model_identifier: null,
      transport: brief.environment_requirement.transport,
      configuration_redacted: {},
    },
    steps: [
      { index: 1, action: 'read documentation', observed_at: started, result: 'quickstart located', evidence_ids: ['ev_2'] },
      { index: 2, action: 'execute workflow', observed_at: finished, result: outcome === 'product_success' ? 'aggregate returned 42' : 'workflow stopped', evidence_ids: ['ev_1'] },
    ],
    evidence: [
      { id: 'ev_1', kind: 'redacted_tool_output', content: content1, request_id: null, content_sha256: sha256hexStr(content1) },
      { id: 'ev_2', kind: 'observed_text', content: content2, request_id: null, content_sha256: sha256hexStr(content2) },
    ],
    output: outcome === 'product_success' ? { total: 42 } : {},
    expected_output_comparison: { matched: outcome === 'product_success', checks: [] },
    first_failure: outcome === 'product_failure'
      ? { stage: opts.failureStage ?? 'tool_schema discovery', description: 'The tool listing omits the aggregates endpoint, so the workflow cannot proceed past discovery.', evidence_ids: ['ev_1'] }
      : null,
    hypotheses: [],
    limitations: [],
    attestations: { actual_execution: true, authorized_materials_only: true, secrets_redacted: true },
  };
}

/** The exact server-derived params the approve-quote ceremony must cover. */
export function approveQuoteParams(requestId: string, requestVersion: number, scope: Record<string, unknown>, deliveryTargetAt: string): Record<string, unknown> {
  return {
    request_id: requestId,
    request_version: requestVersion,
    scope_hash: computeScopeHash(QuoteScopeSchema.parse(scope)),
    subtotal_cents: 20000,
    worker_cap_usdc_atomic: '30000000',
    delivery_target_at: deliveryTargetAt,
  };
}

/** Stripe event envelope helpers. */
let evtCount = 0;
export function stripeEvent(type: string, object: Record<string, unknown>, opts: { livemode?: boolean; id?: string } = {}): Record<string, unknown> {
  return {
    id: opts.id ?? `evt_t${++evtCount}`,
    object: 'event',
    type,
    livemode: opts.livemode ?? false,
    data: { object },
  };
}

/** The full paid-order pipeline: buyer → intake → submit → quote → checkout → pay webhook → plan. */
export async function paidOrder(h: Harness, op: { cookie: string; ownerId: string; passkey: Passkey }): Promise<{
  buyer: { cookie: string; ownerId: string; email: string };
  requestId: string;
  quoteId: string;
  orderId: string;
  scopeHash: string;
  sessionId: string;
}> {
  const buyer = await signupBuyer(h);
  const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
  check(created.status === 200, 'request create failed');
  const request = ((await created.json()) as { request: { id: string; version: number } }).request;
  check((await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: request.version }, buyer.cookie)).status === 200, 'submit failed');

  const scope = sampleScope();
  const deliveryTarget = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const signed = await operatorSign(h, op, 'testing.approve_quote', approveQuoteParams(request.id, 1, scope, deliveryTarget));
  const approved = await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
    request_version: 1, scope, delivery_target_at: deliveryTarget, checklist_confirmed: true, ...signed,
  }, op.cookie);
  check(approved.status === 200, 'approve-quote failed');
  const quote = ((await approved.json()) as { quote: { id: string; scope_hash: string; terms_version: string; disclosure_version: string } }).quote;

  const checkout = await h.post(`/v1/owner/testing/quotes/${quote.id}/checkout`, {
    quote_version: 1,
    scope_hash: quote.scope_hash,
    terms_version: quote.terms_version,
    disclosure_version: quote.disclosure_version,
    idempotency_key: `idem-${request.id}`,
  }, buyer.cookie);
  check(checkout.status === 200, 'checkout failed');
  const checkoutBody = (await checkout.json()) as { checkout_url: string; order_id: string };
  const sessionId = checkoutBody.checkout_url.split('/').pop()!;

  const session = h.stripe.completePayment(sessionId);
  check((await h.sendStripeEvent(stripeEvent('checkout.session.completed', { object: 'checkout.session', id: session.id, metadata: session.metadata }))).status === 200, 'webhook failed');
  await h.runJobs(); // create_plan operation

  return { buyer, requestId: request.id, quoteId: quote.id, orderId: checkoutBody.order_id, scopeHash: quote.scope_hash, sessionId };
}
