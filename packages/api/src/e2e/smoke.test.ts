/**
 * E2E Smoke Test — Full agent lifecycle against the in-memory test app.
 *
 * Exercises the complete flow from registration through task delivery
 * in one orchestrated scenario. All requests use the same Hono test app
 * with an in-memory SQLite DB — no real network calls.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
  walletBindBody,
  TEST_WALLET_KEYS,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';

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

// Mock PoW so registration doesn't need to solve it
vi.mock('../crypto/index.js', async () => {
  const actual = await vi.importActual<typeof import('../crypto/index.js')>('../crypto/index.js');
  return {
    ...actual,
    verifyProofOfWork: vi.fn(() => true),
  };
});

// Payments: a scripted facilitator stands in for CDP (sign-at-accept flow).
import { enablePaymentsForTests, resetPaymentsForTests, paymentHeaderFor, TEST_TX } from '../payments/test-fixtures.js';
import type { PaymentRequirementsV2 } from '../payments/x402.js';

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

describe('E2E Smoke — Full Agent Lifecycle', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let alice: TestKeypair & { name: string };
  let bob: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    // Two active agents for the smoke test
    alice = await createTestAgent(db, {
      name: 'AliceSmoke',
      status: 'active',
      capabilities: ['research', 'code'],
    });
    bob = await createTestAgent(db, {
      name: 'BobSmoke',
      status: 'active',
      capabilities: ['code', 'data'],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('complete agent lifecycle: create task → claim → deliver → verify → reputation', async () => {
    // ── Step 1: Search agents ──────────────────────────────────────────
    const searchRes = await app.request('/v1/agents/search');
    expect(searchRes.status).toBe(200);
    const searchData = await searchRes.json() as { agents: Array<{ name: string }> };
    expect(searchData.agents.some(a => a.name === 'AliceSmoke')).toBe(true);
    expect(searchData.agents.some(a => a.name === 'BobSmoke')).toBe(true);

    // ── Step 2: Create task (Alice is creator) ──────────────────────────
    const createBody = JSON.stringify({
      title: 'Smoke Test Task',
      description: 'A task for the full E2E smoke test',
      category: 'code',
      required_capabilities: ['code'],
    });
    const createHeaders = await signRequest(alice, 'POST', '/v1/tasks', createBody);
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...createHeaders },
      body: createBody,
    });
    expect(createRes.status).toBe(200);
    const createData = await createRes.json() as { ok: boolean; task_id: string; status: string };
    expect(createData.ok).toBe(true);
    expect(createData.status).toBe('open');
    const taskId = createData.task_id;
    expect(taskId).toMatch(/^task_/);

    // ── Step 3: Task appears in public listing ──────────────────────────
    const listRes = await app.request('/v1/tasks');
    const listData = await listRes.json() as { tasks: Array<{ task_id: string }> };
    expect(listData.tasks.some(t => t.task_id === taskId)).toBe(true);

    // Task detail is accessible
    const detailRes = await app.request(`/v1/tasks/${taskId}`);
    expect(detailRes.status).toBe(200);
    const detailData = await detailRes.json() as { task: Record<string, unknown> };
    expect(detailData.task.task_id).toBe(taskId);
    expect(detailData.task.status).toBe('open');

    // ── Step 4: Claim task (Bob is claimer) ────────────────────────────
    const claimHeaders = await signRequest(bob, 'POST', `/v1/tasks/${taskId}/claim`);
    const claimRes = await app.request(`/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { ...claimHeaders },
    });
    expect(claimRes.status).toBe(200);
    const claimData = await claimRes.json() as { ok: boolean; status: string };
    expect(claimData.ok).toBe(true);
    expect(claimData.status).toBe('claimed');

    // Task should no longer appear in status=open listing
    const openListRes = await app.request('/v1/tasks?status=open');
    const openListData = await openListRes.json() as { tasks: Array<{ task_id: string }> };
    expect(openListData.tasks.some(t => t.task_id === taskId)).toBe(false);

    // ── Step 5: Submit deliverable ─────────────────────────────────────
    const submitBody = JSON.stringify({
      submission_type: 'json',
      content: '{"result": "smoke test complete", "coverage": 100}',
      summary: 'Smoke test deliverable',
    });
    const submitHeaders = await signRequest(bob, 'POST', `/v1/tasks/${taskId}/submit`, submitBody);
    const submitRes = await app.request(`/v1/tasks/${taskId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...submitHeaders },
      body: submitBody,
    });
    expect(submitRes.status).toBe(200);
    const submitData = await submitRes.json() as { ok: boolean; submission_id: string; status: string };
    expect(submitData.ok).toBe(true);
    expect(submitData.submission_id).toMatch(/^sub_/);
    expect(submitData.status).toBe('submitted');

    // Public task detail exposes that a submission exists, not its content.
    const afterSubmitDetail = await app.request(`/v1/tasks/${taskId}`);
    const afterSubmitData = await afterSubmitDetail.json() as {
      task: Record<string, unknown>;
      submission: unknown;
      has_submission: boolean;
    };
    expect(afterSubmitData.task.status).toBe('submitted');
    expect(afterSubmitData.submission).toBeNull();
    expect(afterSubmitData.has_submission).toBe(true);

    // ── Step 6: Verify deliverable (Alice verifies) ────────────────────
    const verifyHeaders = await signRequest(alice, 'POST', `/v1/tasks/${taskId}/verify`);
    const verifyRes = await app.request(`/v1/tasks/${taskId}/verify`, {
      method: 'POST',
      headers: { ...verifyHeaders },
    });
    expect(verifyRes.status).toBe(200);
    const verifyData = await verifyRes.json() as { ok: boolean; status: string };
    expect(verifyData.ok).toBe(true);
    expect(verifyData.status).toBe('verified');

    // Final task state
    const finalDetail = await app.request(`/v1/tasks/${taskId}`);
    const finalData = await finalDetail.json() as { task: Record<string, unknown> };
    expect(finalData.task.status).toBe('verified');
    expect(finalData.task.verified_at).toBeDefined();

    // ── Step 7: Reputation is accessible ──────────────────────────────
    const repRes = await app.request(`/v1/agents/${bob.agentId}/reputation`);
    expect(repRes.status).toBe(200);
    const repData = await repRes.json() as Record<string, unknown>;
    expect(repData.agent_id).toBe(bob.agentId);
    expect(typeof repData.reputation_score).toBe('number');
  });

  it('cancel flow: cancelled task hidden by default, visible with status=cancelled', async () => {
    // Create two tasks
    const createBody = (title: string) => JSON.stringify({ title, description: 'Test' });

    const h1 = await signRequest(alice, 'POST', '/v1/tasks', createBody('Keep Task'));
    const r1 = await app.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h1 }, body: createBody('Keep Task') });
    const keepTaskId = ((await r1.json()) as { task_id: string }).task_id;

    const h2 = await signRequest(alice, 'POST', '/v1/tasks', createBody('Cancel Task'));
    const r2 = await app.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h2 }, body: createBody('Cancel Task') });
    const cancelTaskId = ((await r2.json()) as { task_id: string }).task_id;

    // Cancel the second task
    const cancelHeaders = await signRequest(alice, 'POST', `/v1/tasks/${cancelTaskId}/cancel`);
    const cancelRes = await app.request(`/v1/tasks/${cancelTaskId}/cancel`, {
      method: 'POST',
      headers: { ...cancelHeaders },
    });
    expect(cancelRes.status).toBe(200);
    const cancelData = await cancelRes.json() as { status: string };
    expect(cancelData.status).toBe('cancelled');

    // Default listing hides cancelled
    const defaultList = await app.request('/v1/tasks');
    const defaultData = await defaultList.json() as { tasks: Array<{ task_id: string }> };
    expect(defaultData.tasks.some(t => t.task_id === keepTaskId)).toBe(true);
    expect(defaultData.tasks.some(t => t.task_id === cancelTaskId)).toBe(false);

    // status=cancelled shows the cancelled one
    const cancelledList = await app.request('/v1/tasks?status=cancelled');
    const cancelledData = await cancelledList.json() as { tasks: Array<{ task_id: string; status: string }> };
    expect(cancelledData.tasks.some(t => t.task_id === cancelTaskId)).toBe(true);
    expect(cancelledData.tasks.every(t => t.status === 'cancelled')).toBe(true);
  });

  it('wallet set and get flow', async () => {
    // Get wallet (initially null)
    const getRes = await app.request(`/v1/agents/${alice.agentId}/wallet`);
    expect(getRes.status).toBe(200);
    const getData = await getRes.json() as { agent_id: string; wallet_address: string | null; wallet_network: string };
    expect(getData.agent_id).toBe(alice.agentId);
    expect(getData.wallet_address).toBeNull();
    expect(getData.wallet_network).toBe('eip155:8453');

    // Set wallet: a signature from the wallet proves control (D8)
    const bind = walletBindBody(alice.agentId, TEST_WALLET_KEYS.a);
    const validAddress = bind.wallet_address;
    const patchBody = JSON.stringify(bind);
    const patchHeaders = await signRequest(alice, 'PATCH', `/v1/agents/${alice.agentId}/wallet`, patchBody);
    const patchRes = await app.request(`/v1/agents/${alice.agentId}/wallet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...patchHeaders },
      body: patchBody,
    });
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json() as { wallet_address: string; wallet_network: string };
    expect(patchData.wallet_address).toBe(validAddress);

    // Get wallet again — now populated
    const getRes2 = await app.request(`/v1/agents/${alice.agentId}/wallet`);
    expect(getRes2.status).toBe(200);
    const getData2 = await getRes2.json() as { wallet_address: string };
    expect(getData2.wallet_address).toBe(validAddress);

    // Wallet appears in agent profile
    const profileRes = await app.request(`/v1/agents/${alice.agentId}`);
    const profileData = await profileRes.json() as { wallet_address: string };
    expect(profileData.wallet_address).toBe(validAddress);
  });

  it('chain integrity: verified task creates chain entries with increasing sequence', async () => {
    // Create → Claim → Deliver → Verify
    const createBody = JSON.stringify({
      title: 'Chain Task',
      description: 'Testing chain integrity',
      category: 'code',
    });
    const createHeaders = await signRequest(alice, 'POST', '/v1/tasks', createBody);
    const createRes = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...createHeaders },
      body: createBody,
    });
    const { task_id: taskId } = await createRes.json() as { task_id: string };

    // Claim
    const claimH = await signRequest(bob, 'POST', `/v1/tasks/${taskId}/claim`);
    await app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST', headers: { ...claimH } });

    // Deliver (creates chain entry)
    const deliverBody = JSON.stringify({
      summary: 'Chain test delivery',
      submission_type: 'json',
      submission_content: '{"done": true}',
    });
    const deliverH = await signRequest(bob, 'POST', `/v1/tasks/${taskId}/deliver`, deliverBody);
    const deliverRes = await app.request(`/v1/tasks/${taskId}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deliverH },
      body: deliverBody,
    });
    expect(deliverRes.status).toBe(200);
    const deliverData = await deliverRes.json() as { chain_sequence: number; chain_entry_hash: string };
    expect(typeof deliverData.chain_sequence).toBe('number');
    expect(deliverData.chain_entry_hash).toHaveLength(64); // sha256 hex

    // Verify (creates another chain entry)
    const verifyH = await signRequest(alice, 'POST', `/v1/tasks/${taskId}/verify`);
    const verifyRes = await app.request(`/v1/tasks/${taskId}/verify`, {
      method: 'POST',
      headers: { ...verifyH },
    });
    expect(verifyRes.status).toBe(200);
    const verifyData = await verifyRes.json() as { chain_sequence: number; chain_entry_hash: string };
    expect(typeof verifyData.chain_sequence).toBe('number');
    expect(verifyData.chain_sequence).toBeGreaterThan(deliverData.chain_sequence);

    // Receipt is retrievable and verifiable
    const receiptRes = await app.request(`/v1/tasks/${taskId}/receipt`);
    expect(receiptRes.status).toBe(200);
    const receiptData = await receiptRes.json() as { ok: boolean; receipt: Record<string, unknown> };
    expect(receiptData.ok).toBe(true);
    expect(receiptData.receipt.agent_public_key).toBeDefined();
    expect(receiptData.receipt.signature).toBeDefined();
    expect(receiptData.receipt.chain_entry_hash).toBeDefined();
  });

  it('paid task full lifecycle: declare bounty → claim (wallet) → deliver → 402 → accept with signature (settles)', async () => {
    enablePaymentsForTests();
    try {
      const createBody = JSON.stringify({
        title: 'Paid Smoke Task',
        description: 'Bounty task for smoke test',
        category: 'research',
        bounty: { amount: '10000000', token: 'USDC', network: 'eip155:8453' },
      });
      const createHeaders = await signRequest(alice, 'POST', '/v1/tasks', createBody);
      const createRes = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...createHeaders },
        body: createBody,
      });
      expect(createRes.status).toBe(200);
      const createData = await createRes.json() as { task_id: string; payment_status: string; bounty: { amount_display: string } };
      expect(createData.payment_status).toBe('pending');
      expect(createData.bounty.amount_display).toBe('10.00');
      const taskId = createData.task_id;

      // Bob needs a wallet before he can claim a bounty task (bound with a proof of control)
      const bobBind = walletBindBody(bob.agentId, TEST_WALLET_KEYS.b);
      const walletBody = JSON.stringify(bobBind);
      const walletH = await signRequest(bob, 'PATCH', `/v1/agents/${bob.agentId}/wallet`, walletBody);
      const walletRes = await app.request(`/v1/agents/${bob.agentId}/wallet`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...walletH }, body: walletBody,
      });
      expect(walletRes.status).toBe(200);

      // Claim
      const claimH = await signRequest(bob, 'POST', `/v1/tasks/${taskId}/claim`);
      const claimRes = await app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST', headers: claimH });
      expect(claimRes.status).toBe(200);

      // Deliver
      const deliverBody = JSON.stringify({
        summary: 'Paid task complete',
        submission_type: 'json',
        submission_content: '{"research": "done"}',
      });
      const deliverH = await signRequest(bob, 'POST', `/v1/tasks/${taskId}/deliver`, deliverBody);
      const deliverRes = await app.request(`/v1/tasks/${taskId}/deliver`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...deliverH }, body: deliverBody,
      });
      expect(deliverRes.status).toBe(200);

      // Accept without a signature → 402 challenge with the requirements to sign
      const challengeH = await signRequest(alice, 'POST', `/v1/tasks/${taskId}/accept`);
      const challengeRes = await app.request(`/v1/tasks/${taskId}/accept`, { method: 'POST', headers: challengeH });
      expect(challengeRes.status).toBe(402);
      const challenge = await challengeRes.json() as { accepts: PaymentRequirementsV2[] };
      expect(challenge.accepts[0].payTo.toLowerCase()).toBe(bobBind.wallet_address.toLowerCase());
      expect(challenge.accepts[0].amount).toBe('10000000');
      expect(challengeRes.headers.get('PAYMENT-REQUIRED')).toBeTruthy();

      // Accept with the signed authorization → verified + settled
      const acceptH = await signRequest(alice, 'POST', `/v1/tasks/${taskId}/accept`);
      const acceptRes = await app.request(`/v1/tasks/${taskId}/accept`, {
        method: 'POST',
        headers: { ...acceptH, 'PAYMENT-SIGNATURE': paymentHeaderFor(challenge.accepts[0]) },
      });
      expect(acceptRes.status).toBe(200);
      const acceptData = await acceptRes.json() as { status: string; payment_status: string; payment_tx_hash: string; accepted_by: string };
      expect(acceptData.status).toBe('verified');
      expect(acceptData.accepted_by).toBe('creator');
      expect(acceptData.payment_status).toBe('settled');
      expect(acceptData.payment_tx_hash).toBe(TEST_TX);

      // Payment status endpoint
      const paymentRes = await app.request(`/v1/tasks/${taskId}/payment`);
      expect(paymentRes.status).toBe(200);
      const paymentData = await paymentRes.json() as { payment: { status: string; tx_hash: string; payment_due: boolean } };
      expect(paymentData.payment.status).toBe('settled');
      expect(paymentData.payment.tx_hash).toBe(TEST_TX);
      expect(paymentData.payment.payment_due).toBe(false);
    } finally {
      resetPaymentsForTests();
    }
  });
});
