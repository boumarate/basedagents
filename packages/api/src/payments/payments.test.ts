import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupTestDb, createTestApp, createTestAgent, signRequest, walletBindBody, TEST_WALLET_KEYS } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';
import { encryptPaymentSignature, decryptPaymentSignature } from './crypto.js';
import {
  enablePaymentsForTests, disablePaymentsForTests, resetPaymentsForTests, paymentHeaderFor, paymentPayloadFor,
  TEST_WALLET, TEST_TX, type FakeFacilitator,
} from './test-fixtures.js';
import { encodeB64Json, type PaymentRequirementsV2 } from './x402.js';
import { drainOutbox } from '../events/service.js';

// Mock twitter
vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

// Mock skills resolver
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

// Test encryption key (64 hex chars = 32 bytes)
const TEST_ENC_KEY = 'a'.repeat(64);

describe('x402 Payment Integration (sign-at-accept)', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let creator: TestKeypair & { name: string };
  let claimer: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    // Production default: payments are OFF until the founder flips the switch.
    disablePaymentsForTests();

    creator = await createTestAgent(db, { status: 'active', capabilities: ['research', 'code'] });
    claimer = await createTestAgent(db, { status: 'active', capabilities: ['code', 'data'] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPaymentsForTests();
  });

  // ─── Helpers ───

  async function signedPost(agent: TestKeypair, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signRequest(agent, 'POST', path, text);
    return app.request(path, {
      method: 'POST',
      headers: { ...(text ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders, ...headers },
      body: text,
    });
  }

  async function createBountyTask(amount = '5000000', extra: Record<string, unknown> = {}): Promise<{ res: Response; task_id: string }> {
    const res = await signedPost(creator, '/v1/tasks', {
      title: 'Paid Research Task',
      description: 'Research AI safety for 5 USDC',
      category: 'research',
      bounty: { amount, token: 'USDC', network: 'eip155:8453' },
      ...extra,
    });
    const data = await res.clone().json() as { task_id: string };
    return { res, task_id: data.task_id };
  }

  /**
   * The deliverer's payout wallet, as a verified bind would leave it. These
   * tests are about payments; binding (the proof of control) is covered in
   * routes/agents.test.ts and the Wallet Identity block below.
   */
  async function setWallet(agent: TestKeypair, address = TEST_WALLET): Promise<void> {
    await db.run(
      "UPDATE agents SET wallet_address = ?, wallet_network = 'eip155:8453', wallet_verified_at = ? WHERE id = ?",
      address, new Date().toISOString(), agent.agentId,
    );
  }

  async function claimAndDeliver(taskId: string): Promise<void> {
    const claim = await signedPost(claimer, `/v1/tasks/${taskId}/claim`);
    expect(claim.status).toBe(200);
    const deliver = await signedPost(claimer, `/v1/tasks/${taskId}/deliver`, {
      summary: 'All done', submission_type: 'json', submission_content: '{"result":"done"}',
    });
    expect(deliver.status).toBe(200);
  }

  async function requirementsFor(taskId: string): Promise<PaymentRequirementsV2> {
    const res = await app.request(`/v1/tasks/${taskId}/payment`);
    const data = await res.json() as { requirements: PaymentRequirementsV2 | null };
    expect(data.requirements).not.toBeNull();
    return data.requirements!;
  }

  /** A paid task, claimed by a wallet-bearing agent and delivered — ready to accept. */
  async function deliveredPaidTask(): Promise<{ taskId: string; requirements: PaymentRequirementsV2 }> {
    const { res, task_id } = await createBountyTask();
    expect(res.status).toBe(200);
    await setWallet(claimer);
    await claimAndDeliver(task_id);
    return { taskId: task_id, requirements: await requirementsFor(task_id) };
  }

  async function accept(taskId: string, header?: string, body?: unknown): Promise<Response> {
    return signedPost(creator, `/v1/tasks/${taskId}/accept`, body, header ? { 'PAYMENT-SIGNATURE': header } : {});
  }

  async function taskRow(taskId: string): Promise<Record<string, unknown>> {
    return (await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE task_id = ?', taskId))!;
  }

  async function eventTypes(taskId: string): Promise<string[]> {
    const rows = await db.all<{ event_type: string }>('SELECT event_type FROM payment_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', taskId);
    return rows.map((r) => r.event_type);
  }

  function webhookEvents(): Array<{ url: string; type: string; body: Record<string, unknown> }> {
    return mockFetch.mock.calls
      .filter((call: unknown[]) => typeof call[0] === 'string' && (call[1] as { body?: string } | undefined)?.body)
      .map((call: unknown[]) => {
        const body = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
        return { url: call[0] as string, type: String(body.type), body };
      });
  }

  // ─── Encryption Tests ───

  describe('AES-256-GCM encryption', () => {
    it('encrypts and decrypts a payment signature', async () => {
      const original = 'x402-signed-payment-authorization-data-base64';
      const encrypted = await encryptPaymentSignature(original, TEST_ENC_KEY);
      expect(encrypted).not.toBe(original);

      const decrypted = await decryptPaymentSignature(encrypted, TEST_ENC_KEY);
      expect(decrypted).toBe(original);
    });

    it('produces different ciphertexts for same plaintext (random IV)', async () => {
      const original = 'same-payment-signature';
      const enc1 = await encryptPaymentSignature(original, TEST_ENC_KEY);
      const enc2 = await encryptPaymentSignature(original, TEST_ENC_KEY);
      expect(enc1).not.toBe(enc2);

      // But both decrypt to the same thing
      expect(await decryptPaymentSignature(enc1, TEST_ENC_KEY)).toBe(original);
      expect(await decryptPaymentSignature(enc2, TEST_ENC_KEY)).toBe(original);
    });

    it('fails to decrypt with wrong key', async () => {
      const original = 'secret-payment';
      const encrypted = await encryptPaymentSignature(original, TEST_ENC_KEY);
      const wrongKey = 'b'.repeat(64);

      await expect(decryptPaymentSignature(encrypted, wrongKey)).rejects.toThrow();
    });
  });

  // ─── Wallet Endpoints ───

  describe('Wallet Identity', () => {
    it('GET /v1/agents/:id/wallet returns null wallet by default', async () => {
      const res = await app.request(`/v1/agents/${creator.agentId}/wallet`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.agent_id).toBe(creator.agentId);
      expect(data.wallet_address).toBeNull();
      expect(data.wallet_network).toBe('eip155:8453');
    });

    it('PATCH /v1/agents/:id/wallet binds a wallet proven by its signature (D8)', async () => {
      const body = JSON.stringify(walletBindBody(creator.agentId, TEST_WALLET_KEYS.a));
      const headers = await signRequest(creator, 'PATCH', `/v1/agents/${creator.agentId}/wallet`, body);

      const res = await app.request(`/v1/agents/${creator.agentId}/wallet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.wallet_address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
      expect(data.wallet_verified).toBe(true);
    });

    it('PATCH /v1/agents/:id/wallet rejects invalid address', async () => {
      const body = JSON.stringify({ wallet_address: 'not-an-address' });
      const headers = await signRequest(creator, 'PATCH', `/v1/agents/${creator.agentId}/wallet`, body);

      const res = await app.request(`/v1/agents/${creator.agentId}/wallet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('PATCH /v1/agents/:id/wallet rejects other agent → 403', async () => {
      const body = JSON.stringify({
        wallet_address: '0x1234567890abcdef1234567890abcdef12345678',
      });
      const headers = await signRequest(claimer, 'PATCH', `/v1/agents/${creator.agentId}/wallet`, body);

      const res = await app.request(`/v1/agents/${creator.agentId}/wallet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(403);
    });

    it('wallet_address shows in agent profile', async () => {
      await db.run(
        'UPDATE agents SET wallet_address = ? WHERE id = ?',
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', creator.agentId
      );

      const res = await app.request(`/v1/agents/${creator.agentId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.wallet_address).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    });
  });

  // ─── Fail closed ───

  describe('Payments disabled (production default)', () => {
    it('a bounty task cannot be created → 503 and nothing is written', async () => {
      const { res } = await createBountyTask();
      expect(res.status).toBe(503);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe('payments_unavailable');
      const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks');
      expect(count!.n).toBe(0);
    });

    it('a free task still works and reports payment_status none', async () => {
      const res = await signedPost(creator, '/v1/tasks', { title: 'Free Task', description: 'No bounty' });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.payment_status).toBe('none');
      expect(data.bounty).toBeUndefined();
    });

    it('accepting an existing bounty task without a header → 503', async () => {
      // Row created while payments were on; the switch was then flipped off.
      const f = enablePaymentsForTests();
      const { taskId } = await deliveredPaidTask();
      disablePaymentsForTests();
      const res = await accept(taskId);
      expect(res.status).toBe(503);
      expect(f.verifyCalls.length).toBe(0);
    });
  });

  // ─── Bounty declaration ───

  describe('Declaring a bounty (payments enabled)', () => {
    let facilitator: FakeFacilitator;
    beforeEach(() => { facilitator = enablePaymentsForTests(); });

    it('creates a pending bounty task with no payment header', async () => {
      const { res, task_id } = await createBountyTask();
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.payment_status).toBe('pending');
      expect(data.bounty).toEqual({ amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' });

      const row = await taskRow(task_id);
      expect(row.bounty_amount).toBe('5000000');
      expect(row.payment_status).toBe('pending');
      expect(row.payment_verified).toBe(0);
      expect(row.payment_signature).toBeNull();
      expect(await eventTypes(task_id)).toEqual(['bounty_declared']);
      expect(facilitator.verifyCalls.length).toBe(0);
    });

    it('rejects a display amount → 400 (atomic units only)', async () => {
      const { res } = await createBountyTask('$5.00');
      expect(res.status).toBe(400);
    });

    it('rejects a bounty above 1,000 USDC → 400', async () => {
      const { res } = await createBountyTask('1000000001');
      expect(res.status).toBe(400);
    });

    it('rejects a payment header at creation → 400 payment_not_expected', async () => {
      const res = await signedPost(creator, '/v1/tasks', {
        title: 'Paid', description: 'x', bounty: { amount: '5000000', token: 'USDC', network: 'eip155:8453' },
      }, { 'PAYMENT-SIGNATURE': 'anything' });
      expect(res.status).toBe(400);
      expect((await res.json() as Record<string, unknown>).error).toBe('payment_not_expected');
    });

    it('also rejects the legacy X-PAYMENT-SIGNATURE header at creation', async () => {
      const res = await signedPost(creator, '/v1/tasks', {
        title: 'Paid', description: 'x', bounty: { amount: '5000000', token: 'USDC', network: 'eip155:8453' },
      }, { 'X-PAYMENT-SIGNATURE': 'anything' });
      expect(res.status).toBe(400);
    });

    it('public reads show the bounty view and never the payment internals', async () => {
      const { task_id } = await createBountyTask();
      const list = await (await app.request('/v1/tasks?status=open')).json() as { tasks: Array<Record<string, unknown>> };
      const t = list.tasks.find((x) => x.task_id === task_id)!;
      expect(t.bounty).toEqual({ amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' });
      expect(t.payment_status).toBe('pending');
      expect(t.payment_due).toBe(false);
      expect(t).not.toHaveProperty('payment_signature');
      expect(t).not.toHaveProperty('payment_requirements');
      expect(t).not.toHaveProperty('payment_payer');
      expect(t).not.toHaveProperty('settle_attempts');
      expect(t.creator).toMatchObject({ kind: 'agent', id: creator.agentId, cert: 'none' });
    });
  });

  // ─── GET /v1/tasks/:id/payment ───

  describe('GET /v1/tasks/:id/payment', () => {
    beforeEach(() => { enablePaymentsForTests(); });

    it('has no requirements until the task is claimed', async () => {
      const { task_id } = await createBountyTask();
      const data = await (await app.request(`/v1/tasks/${task_id}/payment`)).json() as Record<string, unknown>;
      expect(data.requirements).toBeNull();
      expect(data.requirements_unavailable_reason).toBe('not_claimed');
      expect((data.payment as Record<string, unknown>).status).toBe('pending');
      expect(data.payment_header).toBe('PAYMENT-SIGNATURE');
    });

    it('serves the exact requirements once claimed by a wallet-bearing agent', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      expect(requirements.scheme).toBe('exact');
      expect(requirements.network).toBe('eip155:8453');
      expect(requirements.amount).toBe('5000000');
      expect(requirements.payTo).toBe(TEST_WALLET);
      expect(requirements.maxTimeoutSeconds).toBe(3600);
      expect(requirements.extra).toMatchObject({ name: 'USD Coin', version: '2' });
      const data = await (await app.request(`/v1/tasks/${taskId}/payment`)).json() as Record<string, unknown>;
      expect((data.payment_required as { accepts: unknown[] }).accepts).toHaveLength(1);
      expect((data.payment as Record<string, unknown>).pay_to).toBe(TEST_WALLET);
      expect(data.accept_endpoint).toBe(`POST /v1/tasks/${taskId}/accept`);
    });

    it('returns payment_status=none for a free task', async () => {
      const res = await signedPost(creator, '/v1/tasks', { title: 'Free', description: 'Free task' });
      const { task_id } = await res.json() as { task_id: string };
      const data = await (await app.request(`/v1/tasks/${task_id}/payment`)).json() as Record<string, unknown>;
      expect((data.payment as Record<string, unknown>).status).toBe('none');
      expect((data.payment as Record<string, unknown>).bounty).toBeNull();
      expect(data.requirements_unavailable_reason).toBe('no_bounty');
    });
  });

  // ─── Claiming a bounty task ───

  describe('Claiming a bounty task', () => {
    beforeEach(() => { enablePaymentsForTests(); });

    it('requires the claimer to have a wallet → 409 wallet_required', async () => {
      const { task_id } = await createBountyTask();
      const res = await signedPost(claimer, `/v1/tasks/${task_id}/claim`);
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('wallet_required');
    });
  });

  // ─── Accept: the 402 challenge ───

  describe('Accepting a paid deliverable', () => {
    let facilitator: FakeFacilitator;
    beforeEach(() => { facilitator = enablePaymentsForTests(); });

    it('without a header → 402 with PAYMENT-REQUIRED and no state change', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      const res = await accept(taskId);
      expect(res.status).toBe(402);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe('payment_required');
      expect(data.x402Version).toBe(2);
      expect((data.accepts as PaymentRequirementsV2[])[0]).toEqual(requirements);
      const header = res.headers.get('PAYMENT-REQUIRED')!;
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { accepts: PaymentRequirementsV2[] };
      expect(decoded.accepts[0].payTo).toBe(TEST_WALLET);

      const row = await taskRow(taskId);
      expect(row.status).toBe('submitted');
      expect(row.payment_status).toBe('pending');
      expect(facilitator.verifyCalls.length).toBe(0);
    });

    it('with a valid header → verified + settled in one call, with chain entries, events and webhooks', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      const res = await accept(taskId, paymentHeaderFor(requirements), { note: 'Great work' });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.status).toBe('verified');
      expect(data.accepted_by).toBe('creator');
      expect(data.payment_status).toBe('settled');
      expect(data.payment_tx_hash).toBe(TEST_TX);
      expect(data.chain_sequence).toBeTypeOf('number');
      expect(res.headers.get('PAYMENT-RESPONSE')).not.toBeNull();

      const row = await taskRow(taskId);
      expect(row.status).toBe('verified');
      expect(row.review_note).toBe('Great work');
      expect(row.payment_status).toBe('settled');
      expect(row.payment_settled).toBe(1);
      expect(row.payment_tx_hash).toBe(TEST_TX);
      expect(row.settle_broadcast).toBe(1);
      expect(row.settle_attempts).toBe(1);
      expect(row.payment_nonce).toMatch(/^0x[0-9a-f]{64}$/);
      expect(row.payment_payer).toBeTruthy();
      expect(row.settled_at).not.toBeNull();
      expect(row.auto_release_at).toBeNull();

      // The stored payload is the raw header, encrypted, and the requirements are the ones we served.
      const stored = await decryptPaymentSignature(row.payment_signature as string, TEST_ENC_KEY);
      expect(JSON.parse(Buffer.from(stored, 'base64').toString('utf8')).x402Version).toBe(2);
      expect(JSON.parse(row.payment_requirements as string)).toEqual(requirements);

      expect(facilitator.verifyCalls.length).toBe(1);
      expect(facilitator.settleCalls.length).toBe(1);
      expect(facilitator.settleCalls[0].requirements).toEqual(requirements);

      expect(await eventTypes(taskId)).toEqual(['bounty_declared', 'authorized', 'settled']);
      const chain = await db.all<{ entry_type: string }>(`SELECT entry_type FROM chain WHERE entry_type LIKE 'task_%' ORDER BY sequence`);
      expect(chain.map((c) => c.entry_type)).toEqual(['task_delivered', 'task_verified', 'task_payment_settled']);
    });

    it('rejects a payload signed to the wrong recipient before calling the facilitator → 402', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      const header = paymentHeaderFor(requirements, undefined, { authorization: { to: '0x' + '9'.repeat(40) } });
      const res = await accept(taskId, header);
      expect(res.status).toBe(402);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe('payment_invalid');
      expect(data.reason).toBe('recipient_mismatch');
      expect(facilitator.verifyCalls.length).toBe(0);
      expect((await taskRow(taskId)).payment_status).toBe('pending');
    });

    it('rejects a wrong amount → 402 amount_mismatch', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      const header = paymentHeaderFor(requirements, undefined, { authorization: { value: '4999999' } });
      const res = await accept(taskId, header);
      expect(res.status).toBe(402);
      expect((await res.json() as Record<string, unknown>).reason).toBe('amount_mismatch');
    });

    it('rejects an authorization that expires too soon → 402 valid_before_out_of_range', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      const now = Math.floor(Date.now() / 1000);
      const header = paymentHeaderFor(requirements, now, { authorization: { validBefore: String(now + 30) } });
      const res = await accept(taskId, header);
      expect(res.status).toBe(402);
      expect((await res.json() as Record<string, unknown>).reason).toBe('valid_before_out_of_range');
    });

    it('rejects a malformed header → 400 payment_malformed', async () => {
      const { taskId } = await deliveredPaidTask();
      const res = await accept(taskId, 'not-a-payload');
      expect(res.status).toBe(400);
      expect((await res.json() as Record<string, unknown>).error).toBe('payment_malformed');
    });

    it('rejects a v1 payload → 400', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      const v1 = { x402Version: 1, scheme: 'exact', network: 'base', payload: paymentPayloadFor(requirements).payload };
      const res = await accept(taskId, encodeB64Json(v1));
      expect(res.status).toBe(400);
    });

    it('facilitator says invalid → 402 and nothing is written', async () => {
      facilitator.verifyOutcomes.push({ kind: 'invalid', reason: 'insufficient_funds', message: 'Insufficient funds', http: 200 });
      const { taskId, requirements } = await deliveredPaidTask();
      const res = await accept(taskId, paymentHeaderFor(requirements));
      expect(res.status).toBe(402);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe('insufficient_funds');
      const row = await taskRow(taskId);
      expect(row.status).toBe('submitted');
      expect(row.payment_status).toBe('pending');
      expect(row.payment_signature).toBeNull();
      expect(facilitator.settleCalls.length).toBe(0);
    });

    it('facilitator unavailable at verify → 503 and nothing is written', async () => {
      facilitator.verifyOutcomes.push({ kind: 'unavailable', cause: 'network', detail: 'timeout' });
      const { taskId, requirements } = await deliveredPaidTask();
      const res = await accept(taskId, paymentHeaderFor(requirements));
      expect(res.status).toBe(503);
      expect((await res.json() as Record<string, unknown>).error).toBe('facilitator_unavailable');
      expect((await taskRow(taskId)).status).toBe('submitted');
    });

    it('accepts the deprecated X-PAYMENT-SIGNATURE header name', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      const res = await signedPost(creator, `/v1/tasks/${taskId}/verify`, undefined, { 'X-PAYMENT-SIGNATURE': paymentHeaderFor(requirements) });
      expect(res.status).toBe(200);
      expect(res.headers.get('Deprecation')).toBe('true');
      expect((await res.json() as Record<string, unknown>).payment_status).toBe('settled');
    });

    it('is idempotent once settled: a second accept never re-settles', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      expect((await accept(taskId, paymentHeaderFor(requirements))).status).toBe(200);
      const again = await accept(taskId);
      expect(again.status).toBe(200);
      const data = await again.json() as Record<string, unknown>;
      expect(data.payment_status).toBe('settled');
      expect(data.payment_tx_hash).toBe(TEST_TX);
      expect(facilitator.settleCalls.length).toBe(1);
    });

    it('a nonce already used on another task → 409 authorization_reused', async () => {
      const first = await deliveredPaidTask();
      const payload = paymentPayloadFor(first.requirements);
      expect((await accept(first.taskId, encodeB64Json(payload))).status).toBe(200);

      const { res, task_id } = await createBountyTask();
      expect(res.status).toBe(200);
      await claimAndDeliver(task_id);
      const requirements = await requirementsFor(task_id);
      const reused = paymentPayloadFor(requirements, undefined, { authorization: { nonce: payload.payload.authorization.nonce } });
      const second = await accept(task_id, encodeB64Json(reused));
      expect(second.status).toBe(409);
      expect((await second.json() as Record<string, unknown>).error).toBe('authorization_reused');
      expect((await taskRow(task_id)).status).toBe('submitted');
    });

    it('deliverer without a wallet at accept time → 409 payee_wallet_missing', async () => {
      const { taskId } = await deliveredPaidTask();
      await db.run('UPDATE agents SET wallet_address = NULL WHERE id = ?', claimer.agentId);
      const res = await accept(taskId);
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('payee_wallet_missing');
    });
  });

  // ─── Acceptance is not settlement ───

  describe('Settlement outcomes after acceptance', () => {
    let facilitator: FakeFacilitator;
    beforeEach(() => { facilitator = enablePaymentsForTests(); });

    it('transient settle failure → task stays verified, payment failed with a retry, re-auth refused', async () => {
      facilitator.settleOutcomes.push({ kind: 'rejected', reason: 'settle_exact_evm_transaction_confirmation_timed_out', http: 400 });
      const { taskId, requirements } = await deliveredPaidTask();
      const res = await accept(taskId, paymentHeaderFor(requirements));
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.status).toBe('verified');
      expect(data.payment_status).toBe('failed');
      expect(data.settle_error).toBe('settle_exact_evm_transaction_confirmation_timed_out');
      expect(data.payment_tx_hash).toBeUndefined();

      const row = await taskRow(taskId);
      expect(row.status).toBe('verified');
      expect(row.payment_status).toBe('failed');
      expect(row.payment_settled).toBe(0);
      expect(row.settle_next_at).not.toBeNull();
      expect(row.settle_broadcast).toBe(1);
      expect(await eventTypes(taskId)).toEqual(['bounty_declared', 'authorized', 'settle_failed']);

      // The payload may have reached the chain: a fresh signature is refused.
      const again = await accept(taskId, paymentHeaderFor(requirements));
      expect(again.status).toBe(409);
      expect((await again.json() as Record<string, unknown>).error).toBe('settlement_in_progress');
    });

    it('terminal settle failure → payment failed with no retry; the buyer may re-sign', async () => {
      facilitator.settleOutcomes.push({ kind: 'rejected', reason: 'invalid_exact_evm_payload_signature', http: 400 });
      const { taskId, requirements } = await deliveredPaidTask();
      expect((await accept(taskId, paymentHeaderFor(requirements))).status).toBe(200);
      let row = await taskRow(taskId);
      expect(row.payment_status).toBe('failed');
      expect(row.settle_next_at).toBeNull();
      expect(row.last_settle_error).toBe('invalid_exact_evm_payload_signature');

      facilitator.settleOutcomes.length = 0;
      const again = await accept(taskId, paymentHeaderFor(requirements));
      expect(again.status).toBe(200);
      expect((await again.json() as Record<string, unknown>).payment_status).toBe('settled');
      row = await taskRow(taskId);
      expect(row.settle_attempts).toBe(1);
      expect(row.accepted_by).toBe('creator');
      expect(facilitator.settleCalls.length).toBe(2);
    });

    it('settlement_pending → settling with the tx recorded and a retry scheduled', async () => {
      facilitator.settleOutcomes.push({ kind: 'pending', transaction: TEST_TX });
      const { taskId, requirements } = await deliveredPaidTask();
      const res = await accept(taskId, paymentHeaderFor(requirements));
      expect(res.status).toBe(200);
      expect((await res.json() as Record<string, unknown>).payment_status).toBe('settling');
      const row = await taskRow(taskId);
      expect(row.payment_status).toBe('settling');
      expect(row.payment_tx_hash).toBe(TEST_TX);
      expect(row.settle_next_at).not.toBeNull();
      expect(await eventTypes(taskId)).toContain('settle_pending');
    });

    it('a settle response with success:false is never recorded as settled', async () => {
      facilitator.settleOutcomes.push({ kind: 'rejected', reason: 'settle_exact_failed_onchain', http: 200 });
      const { taskId, requirements } = await deliveredPaidTask();
      await accept(taskId, paymentHeaderFor(requirements));
      const row = await taskRow(taskId);
      expect(row.payment_status).toBe('failed');
      expect(row.payment_settled).toBe(0);
      expect(row.payment_tx_hash).toBeNull();
    });

    it('re-signing is refused after a transient outcome whose free text contains validation keywords (review finding)', async () => {
      // After our broadcast the facilitator answered with transport text that happens to
      // contain words like "signature"/"blocked"/"mismatch". Only the STRUCTURED class may
      // unlock a second signature — never the error string.
      facilitator.settleOutcomes.push({ kind: 'unavailable', cause: 'server', http: 503, detail: 'HTTP 503: upstream request blocked (signature mismatch)' });
      const { taskId, requirements } = await deliveredPaidTask();
      expect((await accept(taskId, paymentHeaderFor(requirements))).status).toBe(200);
      const row = await taskRow(taskId);
      expect(row.payment_status).toBe('failed');
      expect(row.last_settle_class).toBe('transient');
      expect(row.settle_broadcast).toBe(1);

      facilitator.settleOutcomes.length = 0;
      const again = await accept(taskId, paymentHeaderFor(requirements));
      expect(again.status).toBe(409);
      expect((await again.json() as Record<string, unknown>).error).toBe('settlement_in_progress');
      expect(facilitator.settleCalls.length).toBe(1);
      expect((await taskRow(taskId)).payment_nonce).toBe(row.payment_nonce);
    });

    it('an unreadable stored payload after our broadcast is handed to a human, not re-signed', async () => {
      facilitator.settleOutcomes.push({ kind: 'rejected', reason: 'settle_exact_evm_transaction_confirmation_timed_out', http: 400 });
      const { taskId, requirements } = await deliveredPaidTask();
      expect((await accept(taskId, paymentHeaderFor(requirements))).status).toBe(200);
      // Simulate a key rotation: the ciphertext can no longer be decrypted on retry.
      await db.run(`UPDATE tasks SET payment_signature = 'garbage', settle_next_at = ? WHERE task_id = ?`, new Date().toISOString(), taskId);
      const { settleTask } = await import('./settle.js');
      const r = await settleTask(db, { PAYMENT_ENCRYPTION_KEY: TEST_ENC_KEY } as never, taskId, 'cron');
      expect(r).toMatchObject({ skipped: false, error: 'stored_payload_unreadable_after_broadcast' });
      const row = await taskRow(taskId);
      expect(row.last_settle_class).toBe('unknown');
      expect(row.settle_next_at).toBeNull();
      const again = await accept(taskId, paymentHeaderFor(requirements));
      expect(again.status).toBe(409);
    });

    it('authorizing a task the timer already accepted keeps accepted_by=auto and adds no second acceptance entry', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      // The cron accepted it first (T5); the buyer then pays.
      await db.run(`UPDATE tasks SET status = 'verified', accepted_by = 'auto', verified_at = ?, auto_release_at = NULL WHERE task_id = ?`, new Date().toISOString(), taskId);
      const res = await accept(taskId, paymentHeaderFor(requirements));
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.accepted_by).toBe('auto');
      expect(data.payment_status).toBe('settled');
      expect(data.chain_sequence).toBeNull();
      const chain = await db.all<{ entry_type: string }>(`SELECT entry_type FROM chain WHERE entry_type = 'task_verified'`);
      expect(chain.length).toBe(0);
      const funnel = await db.all<{ event: string; provider: string | null }>(`SELECT event, provider FROM funnel_events WHERE funnel_id = ? AND event = 'task_accepted'`, taskId);
      expect(funnel.length).toBe(0);
    });

    it('PAYMENT-RESPONSE carries the x402 SettleResponse wire shape', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      const res = await accept(taskId, paymentHeaderFor(requirements));
      const decoded = JSON.parse(Buffer.from(res.headers.get('PAYMENT-RESPONSE')!, 'base64').toString('utf8')) as Record<string, unknown>;
      expect(decoded.success).toBe(true);
      expect(decoded.transaction).toBe(TEST_TX);
      expect(decoded.network).toBe('eip155:8453');
      expect(decoded).not.toHaveProperty('kind');
    });

    it('a legacy bounty on an unsupported network cannot be paid and does not crash', async () => {
      const { taskId } = await deliveredPaidTask();
      await db.run(`UPDATE tasks SET bounty_network = 'base' WHERE task_id = ?`, taskId);
      const payment = await app.request(`/v1/tasks/${taskId}/payment`);
      expect(payment.status).toBe(200);
      expect((await payment.json() as Record<string, unknown>).requirements_unavailable_reason).toBe('unsupported_network');
      const res = await accept(taskId);
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('bounty_unsupported_network');
    });

    it('notifies the deliverer of acceptance and of settlement separately', async () => {
      await db.run('UPDATE agents SET webhook_url = ? WHERE id = ?', 'https://deliverer.example.com/hook', claimer.agentId);
      const { taskId, requirements } = await deliveredPaidTask();
      await accept(taskId, paymentHeaderFor(requirements));
      // task.verified + task.payment_settled are written to the inbox outbox;
      // drain so the cron's webhook push reaches the fetch mock.
      await drainOutbox(db, new Date().toISOString());
      await new Promise((r) => setTimeout(r, 10));
      const events = webhookEvents().filter((e) => e.url === 'https://deliverer.example.com/hook').map((e) => e.type);
      expect(events).toContain('task.verified');
      expect(events).toContain('task.payment_settled');
      const verified = webhookEvents().find((e) => e.type === 'task.verified')!;
      expect(verified.body.payment_settled).toBe(false);
      expect(verified.body.payment_status).toBe('authorized');
      expect(verified.body.accepted_by).toBe('creator');
    });
  });

  // ─── Dispute Flow ───

  describe('POST /v1/tasks/:id/dispute', () => {
    beforeEach(() => { enablePaymentsForTests(); });

    it('flags a submitted task as disputed without touching payment_status', async () => {
      const { taskId } = await deliveredPaidTask();
      const res = await signedPost(creator, `/v1/tasks/${taskId}/dispute`, { reason: 'Work was incomplete' });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.status).toBe('submitted');
      expect(data.review_state).toBe('disputed');
      expect(data.payment_status).toBe('pending');

      const row = await taskRow(taskId);
      expect(row.status).toBe('submitted');
      expect(row.disputed_at).not.toBeNull();
      expect(row.review_note).toBe('Work was incomplete');
      expect(row.auto_release_at).toBeNull();
      expect(row.payment_status).toBe('pending');
      expect(await eventTypes(taskId)).toContain('disputed');

      const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as { task: Record<string, unknown> };
      expect(detail.task.review_state).toBe('disputed');
    });

    it('requires a reason → 400', async () => {
      const { taskId } = await deliveredPaidTask();
      const res = await signedPost(creator, `/v1/tasks/${taskId}/dispute`, {});
      expect(res.status).toBe(400);
    });

    it('cannot be disputed twice → 409 already_disputed', async () => {
      const { taskId } = await deliveredPaidTask();
      expect((await signedPost(creator, `/v1/tasks/${taskId}/dispute`, { reason: 'a' })).status).toBe(200);
      const res = await signedPost(creator, `/v1/tasks/${taskId}/dispute`, { reason: 'b' });
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('already_disputed');
    });

    it('only creator can dispute → 403', async () => {
      const { taskId } = await deliveredPaidTask();
      const res = await signedPost(claimer, `/v1/tasks/${taskId}/dispute`, { reason: 'nope' });
      expect(res.status).toBe(403);
    });

    it('cannot dispute a non-submitted task → 409', async () => {
      const { task_id } = await createBountyTask();
      const res = await signedPost(creator, `/v1/tasks/${task_id}/dispute`, { reason: 'x' });
      expect(res.status).toBe(409);
    });

    it('a disputed task can still be accepted (and paid)', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      await signedPost(creator, `/v1/tasks/${taskId}/dispute`, { reason: 'let me look again' });
      const res = await accept(taskId, paymentHeaderFor(requirements));
      expect(res.status).toBe(200);
      expect((await res.json() as Record<string, unknown>).payment_status).toBe('settled');
    });
  });

  // ─── Cancel with Payment ───

  describe('Cancel with payment', () => {
    beforeEach(() => { enablePaymentsForTests(); });

    it('voids a pending bounty when an open task is cancelled', async () => {
      const { task_id } = await createBountyTask();
      const res = await signedPost(creator, `/v1/tasks/${task_id}/cancel`);
      expect(res.status).toBe(200);
      expect((await res.json() as Record<string, unknown>).payment_status).toBe('expired');
      const row = await taskRow(task_id);
      expect(row.status).toBe('cancelled');
      expect(row.payment_status).toBe('expired');
      expect(row.cancelled_at).not.toBeNull();
      expect(await eventTypes(task_id)).toContain('expired');
    });

    it('refuses to cancel once the bounty is settled → 409 already_accepted', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      await accept(taskId, paymentHeaderFor(requirements));
      const res = await signedPost(creator, `/v1/tasks/${taskId}/cancel`);
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('already_accepted');
    });
  });

  // ─── Task detail strips payment internals ───

  describe('Task detail security', () => {
    beforeEach(() => { enablePaymentsForTests(); });

    it('GET /v1/tasks/:id never exposes the encrypted payload, requirements or payer', async () => {
      const { taskId, requirements } = await deliveredPaidTask();
      await accept(taskId, paymentHeaderFor(requirements));
      const res = await app.request(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { task: Record<string, unknown>; payment: Record<string, unknown> };
      expect(data.task).not.toHaveProperty('payment_signature');
      expect(data.task).not.toHaveProperty('payment_requirements');
      expect(data.task).not.toHaveProperty('payment_payer');
      expect(data.task).not.toHaveProperty('payment_nonce');
      expect(data.task.payment_status).toBe('settled');
      expect(data.payment.tx_hash).toBe(TEST_TX);
      expect(data.payment.payment_due).toBe(false);
    });
  });

  // ─── Auto-accept timer ───

  describe('Auto-accept timer', () => {
    it('arms auto_release_at ~7 days out on delivery, for free tasks too', async () => {
      const res = await signedPost(creator, '/v1/tasks', { title: 'Free', description: 'Free task' });
      const { task_id } = await res.json() as { task_id: string };
      await claimAndDeliver(task_id);
      const row = await taskRow(task_id);
      expect(row.auto_release_at).not.toBeNull();
      const releaseDate = new Date(row.auto_release_at as string);
      const expectedMin = new Date(Date.now() + 6.9 * 24 * 60 * 60 * 1000);
      const expectedMax = new Date(Date.now() + 7.1 * 24 * 60 * 60 * 1000);
      expect(releaseDate.getTime()).toBeGreaterThan(expectedMin.getTime());
      expect(releaseDate.getTime()).toBeLessThan(expectedMax.getTime());
    });
  });
});
