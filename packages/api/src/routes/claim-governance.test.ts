/**
 * Claim governance (migration 0044): global reputation-scaled budgets,
 * per-poster campaign caps, bounty-scaled claim windows, and refundable
 * claim bonds with slash-on-expiry and durable withdrawals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, createTestApp, createTestAgent, signRequest, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { claimGate, loadTask } from '../tasks/service.js';
import { claimBudget, claimWindowMsForBounty, creditBond, CLAIM_WINDOW_MICRO_MS, CLAIM_WINDOW_DEFAULT_MS } from '../tasks/governance.js';
import { requestBondWithdrawal, settleDueBondWithdrawals, depositClaimBond } from '../tasks/bonds.js';
import { runTaskCron } from '../cron/tasks.js';
import { enablePaymentsForTests, resetPaymentsForTests, TEST_TX } from '../payments/test-fixtures.js';
import { houseWalletFromPrivateKey, parseHousePrivateKey } from '../payments/house-wallet.js';
import { encodeB64Json, buildRequirements } from '../payments/x402.js';
import type { Bindings } from '../types/index.js';

vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

const HOUSE_KEY = '11'.repeat(32);
const PAYER_KEY = '22'.repeat(32);
const TIGHT_ENV = { CLAIM_BUDGET_BASE: '2', CLAIM_BUDGET_FLOOR: '1' };

describe('claim governance', () => {
  let db: SQLiteAdapter;
  let creator: TestKeypair & { name: string };
  let worker: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    creator = await createTestAgent(db, { status: 'active', capabilities: ['research'] });
    worker = await createTestAgent(db, { status: 'active', capabilities: ['research'] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPaymentsForTests();
  });

  function appWith(extraEnv: Record<string, string> = {}) {
    return createTestApp(db, extraEnv as never);
  }

  async function createFreeTask(app: ReturnType<typeof createTestApp>, agent: TestKeypair, overrides: Record<string, unknown> = {}): Promise<string> {
    const raw = JSON.stringify({ title: 'campaign micro task', description: 'do one small thing and report it', ...overrides });
    const headers = await signRequest(agent, 'POST', '/v1/tasks', raw);
    const res = await app.request('/v1/tasks', { method: 'POST', headers, body: raw });
    expect(res.status).toBe(200);
    return ((await res.json()) as { task_id: string }).task_id;
  }

  async function claim(app: ReturnType<typeof createTestApp>, agent: TestKeypair, taskId: string): Promise<Response> {
    const headers = await signRequest(agent, 'POST', `/v1/tasks/${taskId}/claim`, '');
    return app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST', headers });
  }

  it('bounds concurrent claims by the global budget, and human acceptance raises it while auto-acceptance does not', async () => {
    const app = appWith(TIGHT_ENV);
    const t1 = await createFreeTask(app, creator);
    const t2 = await createFreeTask(app, creator);
    const t3 = await createFreeTask(app, creator);

    expect((await claim(app, worker, t1)).status).toBe(200);
    expect((await claim(app, worker, t2)).status).toBe(200);

    const third = await claim(app, worker, t3);
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toBe('claim_budget_exhausted');

    // The gate is authoritative even when the advisory is bypassed.
    expect(await claimGate(db, t3, worker.agentId, null, new Date().toISOString(), undefined, TIGHT_ENV)).toBe(false);

    // A HUMAN-accepted delivery raises the budget…
    await db.run(`UPDATE tasks SET status = 'verified', accepted_by = 'creator' WHERE task_id = ?`, t1);
    const raised = await claimBudget(db, TIGHT_ENV, worker.agentId);
    expect(raised.accepted_deliveries).toBe(1);
    expect(raised.budget).toBeGreaterThan(2);
    expect((await claim(app, worker, t3)).status).toBe(200);

    // …while an AUTO-accepted one counts for nothing.
    await db.run(`UPDATE tasks SET status = 'verified', accepted_by = 'auto' WHERE task_id = ?`, t2);
    const after = await claimBudget(db, TIGHT_ENV, worker.agentId);
    expect(after.accepted_deliveries).toBe(1);
  });

  it('expired claims and disputes lower the budget to its floor, never below', async () => {
    await db.run(
      `INSERT INTO agent_events (id, agent_id, type, payload, created_at, webhook_state)
       VALUES ('evt_x1', ?, 'task.claim_expired', '{}', ?, 'skipped'), ('evt_x2', ?, 'task.claim_expired', '{}', ?, 'skipped')`,
      worker.agentId, new Date().toISOString(), worker.agentId, new Date().toISOString(),
    );
    const view = await claimBudget(db, TIGHT_ENV, worker.agentId);
    expect(view.expired_claims).toBe(2);
    expect(view.budget).toBe(1); // floor from TIGHT_ENV
  });

  it('enforces the per-poster campaign cap across claimed AND submitted, rejects out-of-range values', async () => {
    const app = appWith();
    const bad = JSON.stringify({ title: 'x', description: 'y', max_active_claims_per_agent: 1001 });
    const badHeaders = await signRequest(creator, 'POST', '/v1/tasks', bad);
    expect((await app.request('/v1/tasks', { method: 'POST', headers: badHeaders, body: bad })).status).toBe(400);

    const t1 = await createFreeTask(app, creator, { max_active_claims_per_agent: 1 });
    const t2 = await createFreeTask(app, creator, { max_active_claims_per_agent: 1 });

    expect((await claim(app, worker, t1)).status).toBe(200);
    const second = await claim(app, worker, t2);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('campaign_claim_cap');

    // Delivering does not free the campaign slot (submitted still counts)…
    const deliverBody = JSON.stringify({ summary: 'done', submission_type: 'json', submission_content: '{"ok":true}' });
    const dh = await signRequest(worker, 'POST', `/v1/tasks/${t1}/deliver`, deliverBody);
    expect((await app.request(`/v1/tasks/${t1}/deliver`, { method: 'POST', headers: dh, body: deliverBody })).status).toBe(200);
    expect((await claim(app, worker, t2)).status).toBe(409);

    // …acceptance does. And another agent was never capped.
    await db.run(`UPDATE tasks SET status = 'verified', accepted_by = 'creator' WHERE task_id = ?`, t1);
    expect((await claim(app, worker, t2)).status).toBe(200);
    const other = await createTestAgent(db, { status: 'active', capabilities: ['research'] });
    const t3 = await createFreeTask(app, creator, { max_active_claims_per_agent: 1 });
    expect((await claim(app, other, t3)).status).toBe(200);
  });

  it('scales the claim window with the bounty', async () => {
    expect(claimWindowMsForBounty(null)).toBe(CLAIM_WINDOW_DEFAULT_MS);
    expect(claimWindowMsForBounty('100000')).toBe(CLAIM_WINDOW_MICRO_MS); // $0.10
    expect(claimWindowMsForBounty('5000000')).toBe(48 * 3600 * 1000);
    expect(claimWindowMsForBounty('50000000')).toBe(CLAIM_WINDOW_DEFAULT_MS);

    enablePaymentsForTests();
    const app = appWith({ TASK_PAYMENTS_ENABLED: '1' });
    await db.run(`UPDATE agents SET wallet_address = ?, wallet_network = 'eip155:8453' WHERE id = ?`, '0x' + '3'.repeat(40), worker.agentId);
    const body = JSON.stringify({ title: 'micro', description: 'micro bounty task', bounty: { amount: '100000', token: 'USDC', network: 'eip155:8453' }, escrow: false });
    const h = await signRequest(creator, 'POST', '/v1/tasks', body);
    const created = await app.request('/v1/tasks', { method: 'POST', headers: h, body });
    expect(created.status).toBe(200);
    const taskId = ((await created.json()) as { task_id: string }).task_id;
    expect((await claim(app, worker, taskId)).status).toBe(200);
    const task = (await loadTask(db, taskId))!;
    const windowMs = Date.parse(task.claim_expires_at!) - Date.parse(task.claimed_at!);
    expect(windowMs).toBe(CLAIM_WINDOW_MICRO_MS);
  });

  it('bond slots raise the budget; an expired claim slashes the bond', async () => {
    const now = new Date().toISOString();
    await creditBond(db, worker.agentId, '2500000', 'deposit', 'test', now); // 2.5 USDC → 2 slots
    const view = await claimBudget(db, TIGHT_ENV, worker.agentId);
    expect(view.bond_slots).toBe(2);
    expect(view.budget).toBe(4); // base 2 + 2 slots

    // Claim, then let it expire: the cron reopens the task and slashes 1 USDC.
    const app = appWith(TIGHT_ENV);
    const t = await createFreeTask(app, creator);
    expect((await claim(app, worker, t)).status).toBe(200);
    await db.run(`UPDATE tasks SET claim_expires_at = ? WHERE task_id = ?`, new Date(Date.now() - 60_000).toISOString(), t);
    const summary = await runTaskCron(db, TIGHT_ENV as unknown as Bindings, new Date().toISOString());
    expect(summary.claims_expired).toBe(1);
    expect(summary.bonds_slashed).toBe(1);
    const after = await claimBudget(db, TIGHT_ENV, worker.agentId);
    expect(after.bond_balance_atomic).toBe('1500000');
    expect(after.expired_claims).toBe(1);
  });

  it('withdrawals debit up front, settle via the house wallet, and refund on terminal failure', async () => {
    const env = { ESCROW_WALLET_PRIVATE_KEY: HOUSE_KEY } as unknown as Bindings;
    const now = new Date().toISOString();
    await creditBond(db, worker.agentId, '3000000', 'deposit', 'test', now);

    // No wallet → refused; nothing debited.
    expect((await requestBondWithdrawal(db, env, worker.agentId, '1000000')).status).toBe(409);
    await db.run(`UPDATE agents SET wallet_address = ?, wallet_network = 'eip155:8453' WHERE id = ?`, '0x' + '4'.repeat(40), worker.agentId);

    // More than the balance → refused.
    expect((await requestBondWithdrawal(db, env, worker.agentId, '9000000')).status).toBe(409);

    enablePaymentsForTests({ settle: [{ kind: 'settled', transaction: TEST_TX }] });
    const ok = await requestBondWithdrawal(db, env, worker.agentId, '1000000');
    expect(ok.status).toBe(200);
    expect((await claimBudget(db, env, worker.agentId)).bond_balance_atomic).toBe('2000000');
    const settled = await settleDueBondWithdrawals(db, env, new Date().toISOString());
    expect(settled.settled).toBe(1);

    // A payout the facilitator permanently rejects re-credits the balance.
    enablePaymentsForTests({ settle: [{ kind: 'rejected', reason: 'blocked', http: 400 }] });
    expect((await requestBondWithdrawal(db, env, worker.agentId, '500000')).status).toBe(200);
    const refunded = await settleDueBondWithdrawals(db, env, new Date().toISOString());
    expect(refunded.refunded).toBe(1);
    expect((await claimBudget(db, env, worker.agentId)).bond_balance_atomic).toBe('2000000');
  });

  it('deposits ride the x402 dance: 402 challenge, then verify+settle credits the bond exactly once per authorization', async () => {
    const env = { ESCROW_WALLET_PRIVATE_KEY: HOUSE_KEY } as unknown as Bindings;
    enablePaymentsForTests({
      verify: [{ kind: 'valid' }, { kind: 'valid' }],
      settle: [{ kind: 'settled', transaction: TEST_TX }],
    });

    const challenge = await depositClaimBond(db, env, worker.agentId, 2, null);
    expect(challenge.status).toBe(402);
    expect(challenge.headers?.['PAYMENT-REQUIRED']).toBeTruthy();
    expect((challenge.body as { amount_atomic: string }).amount_atomic).toBe('2000000');

    const house = houseWalletFromPrivateKey(parseHousePrivateKey(HOUSE_KEY));
    const payer = houseWalletFromPrivateKey(parseHousePrivateKey(PAYER_KEY));
    const requirements = buildRequirements(
      { task_id: `claim-bond:${worker.agentId}`, bounty_amount: '2000000', bounty_network: 'eip155:8453' },
      house.address, env as never,
    );
    const payload = payer.signTransfer(requirements, Math.floor(Date.now() / 1000));
    const header = encodeB64Json(payload);

    const paid = await depositClaimBond(db, env, worker.agentId, 2, header);
    expect(paid.status).toBe(200);
    expect((paid.body as { credited_atomic: string }).credited_atomic).toBe('2000000');
    expect((await claimBudget(db, env, worker.agentId)).bond_slots).toBe(2);

    // The same authorization cannot credit twice.
    const replay = await depositClaimBond(db, env, worker.agentId, 2, header);
    expect(replay.status).toBe(409);
    expect((replay.body as { error: string }).error).toBe('authorization_reused');
  });

  it('exposes the budget view to the agent', async () => {
    const app = appWith();
    const headers = await signRequest(worker, 'GET', '/v1/agents/me/claim-budget', '');
    const res = await app.request('/v1/agents/me/claim-budget', { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { budget: number; active_claims: number; base: number };
    expect(body.base).toBe(10);
    expect(body.budget).toBe(10);
    expect(body.active_claims).toBe(0);
  });
});
