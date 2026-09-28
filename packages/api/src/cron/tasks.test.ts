/**
 * Tests for cron/tasks.ts — `runTaskCron(db, env, nowIso)` with an injected
 * clock and rows seeded straight into the in-memory DB (no HTTP).
 *
 *   1. auto-accept      2. settle retry      3. expiry sweep
 *   4. crash recovery   5. unknown-outcome cap   6. per-row isolation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, createTestAgent, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { Bindings } from '../types/index.js';
import { runTaskCron, type TaskCronSummary } from './tasks.js';
import { setPaymentProviderForTests } from '../payments/index.js';
import { encryptPaymentSignature } from '../payments/crypto.js';
import { buildRequirements } from '../payments/x402.js';
import { UNKNOWN_OUTCOME_MAX_MS } from '../payments/settle.js';
import {
  enablePaymentsForTests, resetPaymentsForTests, paymentHeaderFor, TEST_WALLET, TEST_PAYER, TEST_TX,
} from '../payments/test-fixtures.js';
import { generatePublicId } from '../lib/ids.js';
import { isoPlus, loadTask, REVIEW_WINDOW_MS, CLAIM_WINDOW_MS, type TaskRow } from '../tasks/service.js';

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
/** Injected clock. */
const NOW = '2026-09-08T12:00:00.000Z';
const env = { PAYMENT_ENCRYPTION_KEY: TEST_ENC_KEY } as Bindings;

const DELIVERER_HOOK = 'https://deliverer.example.com/hook';
const CREATOR_HOOK = 'https://creator.example.com/hook';

const EMPTY_SUMMARY: TaskCronSummary = {
  auto_accepted: 0, claims_expired: 0, settle_attempted: 0, settled: 0, expired: 0, recovered: 0, capped: 0, settle_skipped_reason: null,
  bonds_slashed: 0, bond_withdrawals_settled: 0, bond_withdrawals_refunded: 0,
  escrow_swept: 0, escrow_stuck: 0,
};

describe('cron/tasks.ts runTaskCron', () => {
  let db: SQLiteAdapter;
  let creator: TestKeypair & { name: string };
  let deliverer: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    // Production default: payments are OFF until the founder flips the switch.
    setPaymentProviderForTests(null);

    creator = await createTestAgent(db, { status: 'active', webhookUrl: CREATOR_HOOK });
    deliverer = await createTestAgent(db, { status: 'active', webhookUrl: DELIVERER_HOOK });
    await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', TEST_WALLET, deliverer.agentId);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPaymentsForTests();
  });

  // ─── Helpers ───

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * A delivered (`submitted`) free task whose review window has just elapsed.
   * `overrides` patch any column (e.g. status/payment columns for the
   * settle, sweep, recovery and cap cases).
   */
  async function seedTask(overrides: Partial<TaskRow> = {}): Promise<string> {
    const taskId = overrides.task_id ?? generatePublicId('task');
    const submittedAt = isoPlus(NOW, -REVIEW_WINDOW_MS - 60_000);
    const row: Record<string, unknown> = {
      task_id: taskId,
      creator_agent_id: creator.agentId,
      creator_owner_id: null,
      creator_kind: 'agent',
      creator_assertion_id: null,
      claimed_by_agent_id: deliverer.agentId,
      title: 'Cron task',
      description: 'Review me',
      category: 'research',
      required_capabilities: null,
      expected_output: null,
      output_format: 'json',
      status: 'submitted',
      created_at: isoPlus(submittedAt, -60 * 60_000),
      claimed_at: isoPlus(submittedAt, -30 * 60_000),
      submitted_at: submittedAt,
      verified_at: null,
      accepted_by: null,
      review_note: null,
      review_assertion_id: null,
      revision_count: 0,
      revision_requested_at: null,
      disputed_at: null,
      cancelled_at: null,
      proposer_signature: null,
      acceptor_signature: null,
      bounty_amount: null,
      bounty_token: null,
      bounty_network: null,
      payment_status: 'none',
      payment_signature: null,
      payment_requirements: null,
      payment_payer: null,
      payment_nonce: null,
      payment_verified: 0,
      payment_settled: 0,
      payment_tx_hash: null,
      payment_expires_at: null,
      auto_release_at: isoPlus(submittedAt, REVIEW_WINDOW_MS),
      settle_attempts: 0,
      settle_broadcast: 0,
      settle_started_at: null,
      settle_next_at: null,
      settled_at: null,
      last_settle_error: null,
      ...overrides,
    };
    const cols = Object.keys(row);
    await db.run(
      `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => row[c]),
    );
    return taskId;
  }

  /** Columns of a bounty that was authorized at accept time (T4-P), ready to settle. */
  async function authorizedBounty(taskId: string): Promise<Partial<TaskRow>> {
    const requirements = buildRequirements({ task_id: taskId, bounty_amount: '5000000', bounty_network: 'eip155:8453' }, TEST_WALLET);
    return {
      status: 'verified', verified_at: isoPlus(NOW, -30 * 60_000), accepted_by: 'creator', auto_release_at: null,
      bounty_amount: '5000000', bounty_token: 'USDC', bounty_network: 'eip155:8453',
      payment_status: 'authorized',
      payment_signature: await encryptPaymentSignature(paymentHeaderFor(requirements), TEST_ENC_KEY),
      payment_requirements: JSON.stringify(requirements),
      payment_payer: TEST_PAYER,
      payment_verified: 1,
      payment_expires_at: isoPlus(NOW, 60 * 60_000),
      settle_next_at: NOW,
    };
  }

  async function row(taskId: string): Promise<TaskRow> {
    return (await loadTask(db, taskId))!;
  }

  async function events(taskId: string): Promise<Array<{ event_type: string; details: Record<string, unknown> | null }>> {
    const rows = await db.all<{ event_type: string; details: string | null }>(
      'SELECT event_type, details FROM payment_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC', taskId,
    );
    return rows.map((r) => ({ event_type: r.event_type, details: r.details ? JSON.parse(r.details) as Record<string, unknown> : null }));
  }

  async function chainEntries(): Promise<Array<{ agent_id: string; entry_type: string }>> {
    return db.all<{ agent_id: string; entry_type: string }>('SELECT agent_id, entry_type FROM chain ORDER BY sequence ASC');
  }

  async function funnelRows(): Promise<Array<{ event: string; funnel_id: string | null; provider: string | null }>> {
    return db.all<{ event: string; funnel_id: string | null; provider: string | null }>('SELECT event, funnel_id, provider FROM funnel_events ORDER BY id ASC');
  }

  function webhookEvents(): Array<{ url: string; type: string; body: Record<string, unknown> }> {
    return mockFetch.mock.calls
      .filter((call: unknown[]) => typeof call[0] === 'string' && (call[1] as { body?: string } | undefined)?.body)
      .map((call: unknown[]) => {
        const body = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
        return { url: call[0] as string, type: String(body.type), body };
      });
  }

  async function reputation(agentId: string): Promise<number> {
    return (await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', agentId))!.reputation_score;
  }

  /** Durable inbox events (agent_events) for one recipient, oldest first. */
  async function inboxEvents(agentId: string): Promise<Array<{ type: string; ref_id: string | null }>> {
    return db.all<{ type: string; ref_id: string | null }>(
      'SELECT type, ref_id FROM agent_events WHERE agent_id = ? ORDER BY seq ASC', agentId,
    );
  }

  // ─── 1. Auto-accept ───

  describe('1. auto-accept', () => {
    it('a submitted free task past its review window → verified/auto with chain entry, reputation, funnel and webhook', async () => {
      const SENTINEL = 0.4242;
      await db.run('UPDATE agents SET reputation_score = ? WHERE id = ?', SENTINEL, deliverer.agentId);
      const taskId = await seedTask();

      const summary = await runTaskCron(db, env, NOW);
      await flush();

      expect(summary).toEqual({ ...EMPTY_SUMMARY, auto_accepted: 1, settle_skipped_reason: 'payments_disabled' });
      expect(await row(taskId)).toMatchObject({
        status: 'verified', accepted_by: 'auto', verified_at: NOW, auto_release_at: null,
        disputed_at: null, payment_status: 'none',
      });

      expect(await chainEntries()).toEqual([{ agent_id: deliverer.agentId, entry_type: 'task_verified' }]);

      const score = await reputation(deliverer.agentId);
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(score).not.toBe(SENTINEL);

      expect(await funnelRows()).toEqual([{ event: 'task_accepted', funnel_id: taskId, provider: 'auto' }]);
      expect(await events(taskId)).toEqual([]); // free task: no payment audit

      const hooks = webhookEvents();
      expect(hooks.map((h) => h.type)).toEqual(['task.verified']);
      expect(hooks[0].url).toBe(DELIVERER_HOOK);
      expect(hooks[0].body).toMatchObject({
        type: 'task.verified', agent_id: deliverer.agentId, task_id: taskId, accepted_by: 'auto',
        payment_settled: false, payment_tx_hash: null, payment_status: 'none',
      });
      expect(typeof hooks[0].body.chain_sequence).toBe('number');
    });

    it('auto_release_at exactly equal to now counts as due', async () => {
      const taskId = await seedTask({ auto_release_at: NOW });
      const summary = await runTaskCron(db, env, NOW);
      expect(summary.auto_accepted).toBe(1);
      expect((await row(taskId)).status).toBe('verified');
    });

    it('a paid submitted task is auto-accepted WITHOUT touching payment columns, logs auto_accepted, and asks the creator to pay', async () => {
      const taskId = await seedTask({
        bounty_amount: '5000000', bounty_token: 'USDC', bounty_network: 'eip155:8453', payment_status: 'pending',
      });

      const summary = await runTaskCron(db, env, NOW);
      await flush();

      expect(summary.auto_accepted).toBe(1);
      const r = await row(taskId);
      expect(r).toMatchObject({
        status: 'verified', accepted_by: 'auto', verified_at: NOW, auto_release_at: null,
        // Nothing on the payment side moved: the timer cannot move money.
        payment_status: 'pending', payment_signature: null, payment_requirements: null, payment_verified: 0, payment_settled: 0,
        payment_tx_hash: null, payment_expires_at: null, settle_attempts: 0, settle_broadcast: 0, settle_next_at: null,
        settled_at: null, last_settle_error: null,
      });

      expect(await events(taskId)).toEqual([{ event_type: 'auto_accepted', details: { payment_status: 'pending' } }]);

      const hooks = webhookEvents();
      const due = hooks.filter((h) => h.type === 'task.payment_due');
      expect(due).toHaveLength(1);
      expect(due[0].url).toBe(CREATOR_HOOK);
      expect(due[0].body).toEqual({ type: 'task.payment_due', agent_id: creator.agentId, task_id: taskId, amount_atomic: '5000000' });
      const verified = hooks.find((h) => h.type === 'task.verified')!;
      expect(verified.url).toBe(DELIVERER_HOOK);
      expect(verified.body).toMatchObject({ accepted_by: 'auto', payment_status: 'pending', payment_settled: false });
    });

    it('a paid task created by a human owner is auto-accepted and logged, but no payment_due webhook can be sent', async () => {
      const taskId = await seedTask({
        creator_agent_id: null, creator_owner_id: 'own_test', creator_kind: 'owner',
        bounty_amount: '5000000', bounty_token: 'USDC', bounty_network: 'eip155:8453', payment_status: 'pending',
      });

      const summary = await runTaskCron(db, env, NOW);
      await flush();

      expect(summary.auto_accepted).toBe(1);
      expect((await row(taskId)).status).toBe('verified');
      expect((await events(taskId)).map((e) => e.event_type)).toEqual(['auto_accepted']);
      expect(webhookEvents().map((h) => h.type)).toEqual(['task.verified']);
    });

    it('a disputed task is frozen: skipped even though its timer has elapsed', async () => {
      const taskId = await seedTask({ disputed_at: isoPlus(NOW, -60 * 60_000), review_note: 'not what I asked' });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.auto_accepted).toBe(0);
      expect(await row(taskId)).toMatchObject({ status: 'submitted', accepted_by: null, verified_at: null });
      expect(await chainEntries()).toEqual([]);
      expect(await funnelRows()).toEqual([]);
      expect(webhookEvents()).toEqual([]);
    });

    it('a task whose auto_release_at is in the future (or NULL) is left alone', async () => {
      const future = await seedTask({ auto_release_at: isoPlus(NOW, 60_000) });
      const unarmed = await seedTask({ auto_release_at: null });
      const claimed = await seedTask({ status: 'claimed', submitted_at: null, auto_release_at: isoPlus(NOW, -60_000) });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.auto_accepted).toBe(0);
      expect((await row(future)).status).toBe('submitted');
      expect((await row(unarmed)).status).toBe('submitted');
      expect((await row(claimed)).status).toBe('claimed');
      expect(await chainEntries()).toEqual([]);
    });
  });

  // ─── 1b. Claim expiry ───

  describe('1b. claim expiry', () => {
    /** A claimed task whose delivery deadline just elapsed. */
    async function seedStaleClaim(overrides: Partial<TaskRow> = {}): Promise<string> {
      return seedTask({
        status: 'claimed',
        claimed_at: isoPlus(NOW, -CLAIM_WINDOW_MS - 120_000),
        claim_expires_at: isoPlus(NOW, -60_000),
        acceptor_signature: 'sig_test',
        submitted_at: null,
        auto_release_at: null,
        ...overrides,
      });
    }

    it('a claimed task past its window → open, claimer cleared, ex-claimer notified', async () => {
      const taskId = await seedStaleClaim();

      const summary = await runTaskCron(db, env, NOW);
      await flush();

      expect(summary).toEqual({ ...EMPTY_SUMMARY, claims_expired: 1, settle_skipped_reason: 'payments_disabled' });
      expect(await row(taskId)).toMatchObject({
        status: 'open', claimed_by_agent_id: null, claimed_at: null, claim_expires_at: null,
        acceptor_signature: null, revision_count: 0, review_note: null, revision_requested_at: null,
      });
      expect(await inboxEvents(deliverer.agentId)).toContainEqual({ type: 'task.claim_expired', ref_id: taskId });
      // never moves money
      expect(await chainEntries()).toEqual([]);
    });

    it('re-notifies matching agents the work is open again, excluding the ex-claimer', async () => {
      const matcher = await createTestAgent(db, { status: 'active', capabilities: ['research'] });
      const taskId = await seedStaleClaim({ required_capabilities: JSON.stringify(['research']) });

      await runTaskCron(db, env, NOW);
      await flush();

      expect(await inboxEvents(matcher.agentId)).toContainEqual({ type: 'task.available', ref_id: taskId });
      // the ex-claimer is told it lapsed, not re-pitched the task as available
      const exClaimer = await inboxEvents(deliverer.agentId);
      expect(exClaimer).toContainEqual({ type: 'task.claim_expired', ref_id: taskId });
      expect(exClaimer.filter((e) => e.type === 'task.available')).toEqual([]);
    });

    it('leaves a claimed task whose window has not elapsed', async () => {
      const taskId = await seedStaleClaim({ claim_expires_at: isoPlus(NOW, 60_000) });
      const summary = await runTaskCron(db, env, NOW);
      expect(summary.claims_expired).toBe(0);
      expect(await row(taskId)).toMatchObject({ status: 'claimed', claimed_by_agent_id: deliverer.agentId });
    });

    it('ignores a claimed task with no timer armed (claim_expires_at NULL)', async () => {
      const taskId = await seedStaleClaim({ claim_expires_at: null });
      const summary = await runTaskCron(db, env, NOW);
      expect(summary.claims_expired).toBe(0);
      expect((await row(taskId)).status).toBe('claimed');
    });
  });

  // ─── 2. Settle retry ───

  describe('2. settle retry', () => {
    it('a due verified+failed row is settled through the facilitator; summary counts attempted and settled', async () => {
      const f = enablePaymentsForTests();
      const taskId = generatePublicId('task');
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'failed', settle_attempts: 1, settle_broadcast: 1,
        last_settle_error: 'settle_exact_evm_transaction_confirmation_timed_out', settle_next_at: isoPlus(NOW, -60_000),
      });

      const summary = await runTaskCron(db, env, NOW);
      await flush();

      expect(summary).toEqual({ ...EMPTY_SUMMARY, settle_attempted: 1, settled: 1 });
      expect(f.settleCalls).toHaveLength(1);
      expect(await row(taskId)).toMatchObject({
        status: 'verified', payment_status: 'settled', payment_settled: 1, payment_tx_hash: TEST_TX, settled_at: NOW,
        settle_next_at: null, settle_attempts: 2, last_settle_error: null,
      });
      expect(await events(taskId)).toEqual([{ event_type: 'settled', details: { transaction: TEST_TX, network: 'eip155:8453', trigger: 'cron' } }]);
      expect(await chainEntries()).toEqual([{ agent_id: deliverer.agentId, entry_type: 'task_payment_settled' }]);
      expect(await funnelRows()).toEqual([{ event: 'task_paid', funnel_id: taskId, provider: 'cron' }]);
      expect(webhookEvents().map((h) => h.type)).toEqual(['task.payment_settled', 'task.payment_settled']);
    });

    it('with payments disabled the settle pass is skipped entirely (settle_skipped_reason=payments_disabled) and the row is untouched', async () => {
      setPaymentProviderForTests(null);
      const taskId = generatePublicId('task');
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'failed', settle_attempts: 1, settle_broadcast: 1, settle_next_at: isoPlus(NOW, -60_000),
        last_settle_error: 'facilitator_server: HTTP 503',
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary).toEqual({ ...EMPTY_SUMMARY, settle_skipped_reason: 'payments_disabled' });
      expect(await row(taskId)).toMatchObject({
        payment_status: 'failed', settle_attempts: 1, settle_next_at: isoPlus(NOW, -60_000), last_settle_error: 'facilitator_server: HTTP 503',
      });
      expect(await events(taskId)).toEqual([]);
    });

    it('only due rows with a stored signature are attempted: an authorized due row yes, a future or signature-less row no', async () => {
      const f = enablePaymentsForTests();
      const dueId = generatePublicId('task');
      await seedTask({ task_id: dueId, ...(await authorizedBounty(dueId)) });
      const futureId = generatePublicId('task');
      await seedTask({ task_id: futureId, ...(await authorizedBounty(futureId)), settle_next_at: isoPlus(NOW, 5 * 60_000) });
      const noSigId = generatePublicId('task');
      await seedTask({ task_id: noSigId, ...(await authorizedBounty(noSigId)), payment_signature: null });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary).toMatchObject({ settle_attempted: 1, settled: 1 });
      expect(f.settleCalls).toHaveLength(1);
      expect((await row(dueId)).payment_status).toBe('settled');
      expect(await row(futureId)).toMatchObject({ payment_status: 'authorized', settle_attempts: 0 });
      expect(await row(noSigId)).toMatchObject({ payment_status: 'authorized', settle_attempts: 0 });
    });

    it('a transient facilitator answer counts as attempted but not settled and schedules the backoff', async () => {
      enablePaymentsForTests({ settle: [{ kind: 'unavailable', cause: 'server', http: 503, detail: 'HTTP 503' }] });
      const taskId = generatePublicId('task');
      await seedTask({ task_id: taskId, ...(await authorizedBounty(taskId)) });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary).toMatchObject({ settle_attempted: 1, settled: 0 });
      expect(await row(taskId)).toMatchObject({
        payment_status: 'failed', settle_attempts: 1, settle_broadcast: 1, settle_next_at: isoPlus(NOW, 2 * 60_000),
        last_settle_error: 'facilitator_server: HTTP 503',
      });
    });

    it('a due authorization about to expire is expired by settleTask’s precheck (trigger=settle), not by the sweep', async () => {
      const f = enablePaymentsForTests();
      const taskId = generatePublicId('task');
      await seedTask({ task_id: taskId, ...(await authorizedBounty(taskId)), payment_expires_at: isoPlus(NOW, -60_000) });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary).toMatchObject({ settle_attempted: 1, settled: 0, expired: 0 });
      expect(f.settleCalls).toHaveLength(0);
      expect(await row(taskId)).toMatchObject({ payment_status: 'expired', settle_next_at: null, settle_attempts: 1, last_settle_class: 'expired' });
      expect(await events(taskId)).toEqual([{ event_type: 'expired', details: { reason: 'authorization_expired', trigger: 'cron' } }]);
    });
  });

  // ─── 3. Expiry sweep ───

  describe('3. expiry sweep', () => {
    it('an un-broadcast authorized row past validBefore → expired, event, payment_failed webhooks, summary.expired', async () => {
      const taskId = generatePublicId('task');
      await seedTask({ task_id: taskId, ...(await authorizedBounty(taskId)), payment_expires_at: isoPlus(NOW, -60_000) });

      const summary = await runTaskCron(db, env, NOW);
      await flush();

      expect(summary).toEqual({ ...EMPTY_SUMMARY, expired: 1, settle_skipped_reason: 'payments_disabled' });
      expect(await row(taskId)).toMatchObject({
        status: 'verified', payment_status: 'expired', settle_next_at: null, last_settle_error: 'authorization_expired',
        settle_broadcast: 0, settle_attempts: 0,
      });
      expect(await events(taskId)).toEqual([{ event_type: 'expired', details: { reason: 'authorization_expired', trigger: 'cron' } }]);

      const failed = webhookEvents().filter((h) => h.type === 'task.payment_failed');
      expect(failed.map((h) => h.url).sort()).toEqual([CREATOR_HOOK, DELIVERER_HOOK].sort());
      expect(failed[0].body).toMatchObject({ task_id: taskId, reason: 'expired' });
    });

    it('an un-broadcast FAILED row past validBefore is expired too', async () => {
      const taskId = generatePublicId('task');
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'failed', settle_attempts: 1, settle_broadcast: 0, last_settle_error: 'payments_not_configured',
        payment_expires_at: isoPlus(NOW, -60_000),
      });
      const summary = await runTaskCron(db, env, NOW);
      expect(summary.expired).toBe(1);
      expect((await row(taskId)).payment_status).toBe('expired');
    });

    it('a BROADCAST failed row is never expired by the sweep (its outcome is unknown until the facilitator says)', async () => {
      const taskId = generatePublicId('task');
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'failed', settle_attempts: 1, settle_broadcast: 1, settle_next_at: isoPlus(NOW, 60_000),
        last_settle_error: 'settle_exact_evm_transaction_confirmation_timed_out', payment_expires_at: isoPlus(NOW, -60_000),
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.expired).toBe(0);
      expect(await row(taskId)).toMatchObject({ payment_status: 'failed', settle_next_at: isoPlus(NOW, 60_000), last_settle_error: 'settle_exact_evm_transaction_confirmation_timed_out' });
      expect(await events(taskId)).toEqual([]);
    });

    it('a SETTLING row is never expired by the sweep', async () => {
      const taskId = generatePublicId('task');
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'settling', settle_attempts: 1, settle_broadcast: 1, settle_started_at: isoPlus(NOW, -60_000),
        settle_next_at: null, payment_expires_at: isoPlus(NOW, -60_000),
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.expired).toBe(0);
      expect((await row(taskId)).payment_status).toBe('settling');
    });

    it('an authorization that is still valid is not swept', async () => {
      const taskId = generatePublicId('task');
      await seedTask({ task_id: taskId, ...(await authorizedBounty(taskId)), payment_expires_at: isoPlus(NOW, 60_000) });
      const summary = await runTaskCron(db, env, NOW);
      expect(summary.expired).toBe(0);
      expect((await row(taskId)).payment_status).toBe('authorized');
    });
  });

  // ─── 4. Crash recovery ───

  describe('4. crash recovery', () => {
    it('a settling row with no retry scheduled whose attempt started ≥ 10 minutes ago is re-armed (settle_next_at = now)', async () => {
      const staleId = generatePublicId('task');
      await seedTask({
        task_id: staleId, ...(await authorizedBounty(staleId)),
        payment_status: 'settling', settle_attempts: 1, settle_broadcast: 1, settle_started_at: isoPlus(NOW, -11 * 60_000), settle_next_at: null,
      });
      const boundaryId = generatePublicId('task');
      await seedTask({
        task_id: boundaryId, ...(await authorizedBounty(boundaryId)),
        payment_status: 'settling', settle_attempts: 1, settle_broadcast: 0, settle_started_at: isoPlus(NOW, -10 * 60_000), settle_next_at: null,
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.recovered).toBe(2);
      expect(await row(staleId)).toMatchObject({ payment_status: 'settling', settle_next_at: NOW, settle_attempts: 1 });
      expect(await row(boundaryId)).toMatchObject({ payment_status: 'settling', settle_next_at: NOW });
      expect(await events(staleId)).toEqual([]);
    });

    it('a fresh settling attempt (started 1 minute ago) is left alone', async () => {
      const taskId = generatePublicId('task');
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'settling', settle_attempts: 1, settle_broadcast: 1, settle_started_at: isoPlus(NOW, -60_000), settle_next_at: null,
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.recovered).toBe(0);
      expect(await row(taskId)).toMatchObject({ payment_status: 'settling', settle_next_at: null });
    });

    it('a settling row that already has a retry scheduled (pending answer) is not touched by recovery', async () => {
      const taskId = generatePublicId('task');
      const next = isoPlus(NOW, 60_000);
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'settling', settle_attempts: 1, settle_broadcast: 1, settle_started_at: isoPlus(NOW, -30 * 60_000),
        settle_next_at: next, payment_tx_hash: TEST_TX, last_settle_error: 'settlement_pending',
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.recovered).toBe(0);
      expect((await row(taskId)).settle_next_at).toBe(next);
    });
  });

  // ─── 5. Unknown-outcome cap ───

  describe('5. unknown-outcome cap', () => {
    it('a broadcast failed row still retrying 24 h after its authorization expired is handed to a human', async () => {
      const taskId = generatePublicId('task');
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'failed', settle_attempts: 9, settle_broadcast: 1, settle_next_at: isoPlus(NOW, -60_000),
        last_settle_error: 'facilitator_network: fetch failed', payment_expires_at: isoPlus(NOW, -25 * 60 * 60_000),
      });

      const summary = await runTaskCron(db, env, NOW);
      await flush();

      expect(summary).toEqual({ ...EMPTY_SUMMARY, capped: 1, settle_skipped_reason: 'payments_disabled' });
      expect(await row(taskId)).toMatchObject({
        status: 'verified', payment_status: 'failed', settle_next_at: null, last_settle_error: 'unknown_outcome_manual',
        settle_broadcast: 1, settle_attempts: 9, payment_settled: 0,
      });
      expect(await events(taskId)).toEqual([{ event_type: 'settle_failed', details: { error: 'unknown_outcome_manual', trigger: 'cron' } }]);
      // Manual reconciliation is an operator matter, not a party notification.
      expect(webhookEvents()).toEqual([]);
    });

    it('the cap fires exactly at the 24 h mark and not before', async () => {
      const atId = generatePublicId('task');
      await seedTask({
        task_id: atId, ...(await authorizedBounty(atId)),
        payment_status: 'failed', settle_attempts: 5, settle_broadcast: 1, settle_next_at: isoPlus(NOW, 60_000),
        payment_expires_at: isoPlus(NOW, -UNKNOWN_OUTCOME_MAX_MS),
      });
      const beforeId = generatePublicId('task');
      await seedTask({
        task_id: beforeId, ...(await authorizedBounty(beforeId)),
        payment_status: 'failed', settle_attempts: 5, settle_broadcast: 1, settle_next_at: isoPlus(NOW, 60_000),
        payment_expires_at: isoPlus(NOW, -23 * 60 * 60_000),
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.capped).toBe(1);
      expect(await row(atId)).toMatchObject({ settle_next_at: null, last_settle_error: 'unknown_outcome_manual' });
      expect(await row(beforeId)).toMatchObject({ settle_next_at: isoPlus(NOW, 60_000), last_settle_error: null });
    });

    it('a broadcast failed row already terminal (settle_next_at NULL) is not capped again', async () => {
      const taskId = generatePublicId('task');
      await seedTask({
        task_id: taskId, ...(await authorizedBounty(taskId)),
        payment_status: 'failed', settle_attempts: 1, settle_broadcast: 1, settle_next_at: null,
        last_settle_error: 'nonce_conflict', payment_expires_at: isoPlus(NOW, -48 * 60 * 60_000),
      });
      const summary = await runTaskCron(db, env, NOW);
      expect(summary.capped).toBe(0);
      expect((await row(taskId)).last_settle_error).toBe('nonce_conflict');
      expect(await events(taskId)).toEqual([]);
    });
  });

  // ─── 6. Per-row isolation ───

  describe('6. per-row isolation', () => {
    it('a DB error on one auto-accept row does not stop the loop: the other due row is still accepted', async () => {
      const poisonId = await seedTask();
      const okId = await seedTask();
      const realRun = db.run.bind(db);
      vi.spyOn(db, 'run').mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (/accepted_by = 'auto'/.test(sql) && params.includes(poisonId)) throw new Error('simulated D1 failure');
        return realRun(sql, ...params);
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.auto_accepted).toBe(1);
      expect((await row(poisonId)).status).toBe('submitted');
      expect(await row(okId)).toMatchObject({ status: 'verified', accepted_by: 'auto' });
      expect(await chainEntries()).toEqual([{ agent_id: deliverer.agentId, entry_type: 'task_verified' }]);
    });

    it('a task whose deliverer row vanished is still auto-accepted (chain entry is best-effort) alongside a healthy one', async () => {
      const ghost = await createTestAgent(db, { status: 'active' });
      const ghostTask = await seedTask({ claimed_by_agent_id: ghost.agentId });
      const okTask = await seedTask();
      await db.exec('PRAGMA foreign_keys = OFF');
      await db.run('DELETE FROM agents WHERE id = ?', ghost.agentId);
      await db.exec('PRAGMA foreign_keys = ON');

      const summary = await runTaskCron(db, env, NOW);

      expect(summary.auto_accepted).toBe(2);
      expect(await row(ghostTask)).toMatchObject({ status: 'verified', accepted_by: 'auto' });
      expect(await row(okTask)).toMatchObject({ status: 'verified', accepted_by: 'auto' });
      // Only the healthy deliverer got a chain entry; both got a funnel row.
      expect(await chainEntries()).toEqual([{ agent_id: deliverer.agentId, entry_type: 'task_verified' }]);
      expect((await funnelRows()).map((f) => f.funnel_id).sort()).toEqual([ghostTask, okTask].sort());
    });

    it('a DB error inside one settle attempt does not stop the settle pass', async () => {
      const f = enablePaymentsForTests();
      const poisonId = generatePublicId('task');
      await seedTask({ task_id: poisonId, ...(await authorizedBounty(poisonId)) });
      const okId = generatePublicId('task');
      await seedTask({ task_id: okId, ...(await authorizedBounty(okId)) });
      const realRun = db.run.bind(db);
      vi.spyOn(db, 'run').mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (/payment_status = 'settling', settle_attempts/.test(sql) && params.includes(poisonId)) throw new Error('simulated D1 failure');
        return realRun(sql, ...params);
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary).toMatchObject({ settle_attempted: 2, settled: 1 });
      expect(f.settleCalls).toHaveLength(1);
      expect(await row(poisonId)).toMatchObject({ payment_status: 'authorized', settle_attempts: 0 });
      expect(await row(okId)).toMatchObject({ payment_status: 'settled', settle_attempts: 1 });
    });

    it('all five passes run in one tick and the summary reflects each', async () => {
      enablePaymentsForTests();
      // 1. auto-accept
      const acceptId = await seedTask();
      // 2. settle
      const settleId = generatePublicId('task');
      await seedTask({ task_id: settleId, ...(await authorizedBounty(settleId)) });
      // 3. sweep (not due for settle, so step 2 leaves it to the sweep)
      const sweepId = generatePublicId('task');
      await seedTask({ task_id: sweepId, ...(await authorizedBounty(sweepId)), settle_next_at: null, payment_expires_at: isoPlus(NOW, -60_000) });
      // 4. recovery
      const recoverId = generatePublicId('task');
      await seedTask({
        task_id: recoverId, ...(await authorizedBounty(recoverId)),
        payment_status: 'settling', settle_attempts: 1, settle_broadcast: 1, settle_started_at: isoPlus(NOW, -20 * 60_000), settle_next_at: null,
      });
      // 5. cap (retry in the future so step 2 does not pick it up)
      const capId = generatePublicId('task');
      await seedTask({
        task_id: capId, ...(await authorizedBounty(capId)),
        payment_status: 'failed', settle_attempts: 7, settle_broadcast: 1, settle_next_at: isoPlus(NOW, 60_000),
        payment_expires_at: isoPlus(NOW, -30 * 60 * 60_000),
      });

      const summary = await runTaskCron(db, env, NOW);

      expect(summary).toEqual({ auto_accepted: 1, claims_expired: 0, settle_attempted: 1, settled: 1, expired: 1, recovered: 1, capped: 1, settle_skipped_reason: null, escrow_swept: 0, escrow_stuck: 0, bonds_slashed: 0, bond_withdrawals_settled: 0, bond_withdrawals_refunded: 0 });
      expect((await row(acceptId)).status).toBe('verified');
      expect((await row(settleId)).payment_status).toBe('settled');
      expect((await row(sweepId)).payment_status).toBe('expired');
      expect((await row(recoverId)).settle_next_at).toBe(NOW);
      expect((await row(capId)).last_settle_error).toBe('unknown_outcome_manual');
    });
  });

  describe('7. autoAcceptGate predicate (review finding)', () => {
    it('does not accept a task whose timer was re-armed after the cron SELECT', async () => {
      const { autoAcceptGate } = await import('../tasks/service.js');
      const taskId = generatePublicId('task');
      await seedTask({ task_id: taskId, status: 'submitted', auto_release_at: isoPlus(NOW, 6 * 24 * 60 * 60_000) });
      expect(await autoAcceptGate(db, taskId, NOW)).toBe(false);
      expect(await row(taskId)).toMatchObject({ status: 'submitted' });
      await db.run(`UPDATE tasks SET auto_release_at = ? WHERE task_id = ?`, isoPlus(NOW, -1), taskId);
      expect(await autoAcceptGate(db, taskId, NOW)).toBe(true);
      expect(await row(taskId)).toMatchObject({ status: 'verified', accepted_by: 'auto' });
    });
  });
});
