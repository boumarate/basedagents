/**
 * Agent Testing — fulfillment bridge tests (spec §20.3, §20.4 subset).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeHarness, setupOperator, operatorSign, paidOrder, registerWorkerAgent, workerRequest,
  buildWorkerResult, sha256hexStr, type Harness, type Worker,
} from './test-harness.js';
import { TestingStore } from './store.js';
import { maxRunsPerGroup } from './fulfillment.js';
import { loadTask } from '../../tasks/service.js';

let h: Harness;
let op: Awaited<ReturnType<typeof setupOperator>>;

beforeEach(async () => {
  h = makeHarness();
  op = await setupOperator(h);
});

afterEach(() => h.teardown());

/** Seed the platform service principal + an approved worker per environment. */
async function seedWorkers(groups: Array<{ group: string; envs: Array<{ client: string; transport: string }> }>): Promise<Worker[]> {
  const platform = await registerWorkerAgent(h, 'BasedAgents Testing');
  h.env.TESTING_PLATFORM_AGENT_ID = platform.agentId;
  const workers: Worker[] = [];
  for (const g of groups) {
    const worker = await registerWorkerAgent(h);
    workers.push(worker);
    const res = await h.post(`/v1/owner/admin/testing/workers/${worker.agentId}/eligibility`, {
      operator_group_id: g.group,
      group_confidence: 'operator_reviewed',
      capabilities: ['agent-compatibility-testing'],
      environments: g.envs,
      evidence_refs: ['manual review 2026-09'],
      provenance: 'operator_reviewed',
      status: 'approved',
      expires_at: null,
      notes: '',
    }, op.cookie);
    expect(res.status).toBe(200);
  }
  return workers;
}

async function publishAllExternal(orderId: string): Promise<string[]> {
  const store = new TestingStore(h.db);
  const runs = (await store.listRuns(orderId)).filter((r) => r.kind === 'external');
  const runIds = runs.map((r) => r.id).sort();
  const quote = (await store.getQuote((await store.getOrder(orderId))!.quote_id))!;
  const signed = await operatorSign(h, op, 'testing.publish_tasks', {
    order_id: orderId,
    run_ids: runIds,
    scope_hash: quote.scope_hash,
    bounty_usdc_atomic: quote.worker_bounty_usdc_atomic,
    total_commitment_usdc_atomic: String(BigInt(quote.worker_bounty_usdc_atomic) * BigInt(runIds.length)),
    worker_cap_usdc_atomic: quote.worker_cap_usdc_atomic,
  });
  const res = await h.post(`/v1/owner/admin/testing/orders/${orderId}/publish-tasks`, { run_ids: runIds, ...signed }, op.cookie);
  expect(res.status).toBe(200);
  await h.runJobs(); // execute publish operations
  return runIds;
}

const THREE_GROUPS = [
  { group: 'grp-alpha', envs: [{ client: 'claude-code', transport: 'mcp' }] },
  { group: 'grp-beta', envs: [{ client: 'openhands', transport: 'http' }] },
  { group: 'grp-gamma', envs: [{ client: 'aider', transport: 'http' }] },
];

describe('publication + funding (spec §10.2, §10.3)', () => {
  it('operator-approved publication creates one funded escrow task per run, restricted to the approved pool', async () => {
    await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);

    const store = new TestingStore(h.db);
    const runs = (await store.listRuns(orderId)).filter((r) => r.kind === 'external');
    for (const run of runs) {
      const attempt = (await store.getActiveAttempt(run.id))!;
      expect(attempt.state).toBe('published');
      expect(attempt.task_id).toBeTruthy();
      const task = (await loadTask(h.db, attempt.task_id!))!;
      expect(task.status).toBe('open');
      expect(task.escrow).toBe(1);
      expect(task.escrow_status).toBe('funded'); // treasury deposit settled (fake facilitator)
      expect(task.bounty_amount).toBe('5000000');
      const allow = await h.db.all<{ agent_id: string }>('SELECT agent_id FROM task_claim_allowlist WHERE task_id = ?', attempt.task_id);
      expect(allow.length).toBeGreaterThan(0);
    }
    // Budget: earmark + 3 committed run reservations, inside the cap.
    const reservations = await store.listReservations(orderId);
    const committed = reservations.filter((r) => r.state === 'committed');
    expect(committed).toHaveLength(3);
    expect(String(await store.remainingBudget(orderId, '30000000'))).toBe(String(30000000 - 4 * 5000000));
  });

  it('re-running jobs or re-approving publication never double-publishes or exceeds caps', async () => {
    await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    const runIds = await publishAllExternal(orderId);
    await h.runJobs();
    await h.runJobs();
    const tasks = await h.db.all('SELECT task_id FROM tasks');
    expect(tasks).toHaveLength(3);

    // Second approval round: idempotent skip of runs with active attempts.
    const store = new TestingStore(h.db);
    const quote = (await store.getQuote((await store.getOrder(orderId))!.quote_id))!;
    const signed = await operatorSign(h, op, 'testing.publish_tasks', {
      order_id: orderId, run_ids: runIds, scope_hash: quote.scope_hash,
      bounty_usdc_atomic: quote.worker_bounty_usdc_atomic,
      total_commitment_usdc_atomic: String(BigInt(quote.worker_bounty_usdc_atomic) * BigInt(runIds.length)),
      worker_cap_usdc_atomic: quote.worker_cap_usdc_atomic,
    });
    expect((await h.post(`/v1/owner/admin/testing/orders/${orderId}/publish-tasks`, { run_ids: runIds, ...signed }, op.cookie)).status).toBe(200);
    await h.runJobs();
    expect(await h.db.all('SELECT task_id FROM tasks')).toHaveLength(3);
    expect((await store.listReservations(orderId)).filter((r) => r.state !== 'released')).toHaveLength(4);
  });

  it('publication without an eligible worker pool fails to manual review with an operator alert — no task, budget still reserved', async () => {
    const platform = await registerWorkerAgent(h, 'BasedAgents Testing');
    h.env.TESTING_PLATFORM_AGENT_ID = platform.agentId;
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    expect(await h.db.all('SELECT task_id FROM tasks')).toHaveLength(0);
    const ops = await h.db.all<{ state: string }>(`SELECT state FROM testing_operations WHERE kind = 'publish_task'`);
    expect(ops.every((o) => o.state === 'manual_review')).toBe(true);
    const alert = await h.db.get(`SELECT semantic_key FROM testing_notifications WHERE kind = 'missing_coverage'`);
    expect(alert).not.toBeNull();
  });

  it('missing treasury key disables funding with a clear failure, never a fake success', async () => {
    await seedWorkers(THREE_GROUPS);
    delete h.env.TESTING_TREASURY_PRIVATE_KEY;
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    expect(await h.db.all('SELECT task_id FROM tasks')).toHaveLength(0);
    const ops = await h.db.all<{ state: string; last_error: string }>(`SELECT state, last_error FROM testing_operations WHERE kind = 'publish_task'`);
    expect(ops.every((o) => o.state === 'manual_review' && o.last_error.includes('funding_unavailable'))).toBe(true);
    void orderId;
  });

  it('the kill switch (fulfillment flag off) pauses new publication but the inbox/jobs keep running', async () => {
    await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    h.env.TESTING_FULFILLMENT_ENABLED = '0';
    const store = new TestingStore(h.db);
    const runs = (await store.listRuns(orderId)).filter((r) => r.kind === 'external');
    const quote = (await store.getQuote((await store.getOrder(orderId))!.quote_id))!;
    const signed = await operatorSign(h, op, 'testing.publish_tasks', {
      order_id: orderId, run_ids: runs.map((r) => r.id).sort(), scope_hash: quote.scope_hash,
      bounty_usdc_atomic: quote.worker_bounty_usdc_atomic,
      total_commitment_usdc_atomic: String(BigInt(quote.worker_bounty_usdc_atomic) * BigInt(runs.length)),
      worker_cap_usdc_atomic: quote.worker_cap_usdc_atomic,
    });
    const res = await h.post(`/v1/owner/admin/testing/orders/${orderId}/publish-tasks`, { run_ids: runs.map((r) => r.id).sort(), ...signed }, op.cookie);
    expect(res.status).toBe(409);
    const summary = await h.runJobs(); // still runs — recovery is never disabled
    expect(summary.inbox).toBeDefined();
  });
});

describe('claims, allowlist and briefs (spec §10.4, §7.3, §11)', () => {
  it('only approved workers can claim; the brief is claimant-only and revoked on cancel', async () => {
    const workers = await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);

    const store = new TestingStore(h.db);
    const runs = (await store.listRuns(orderId)).filter((r) => r.kind === 'external');
    const first = (await store.getActiveAttempt(runs[0].id))!;
    const taskId = first.task_id!;

    // An active agent OUTSIDE the pool cannot claim.
    const outsider = await registerWorkerAgent(h);
    const refused = await workerRequest(h, outsider, 'POST', `/v1/tasks/${taskId}/claim`, {});
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('worker_ineligible');

    // No pre-claim brief access, even for the eligible worker.
    const preclaim = await workerRequest(h, workers[0], 'GET', `/v1/testing/assignments/${taskId}/brief`);
    expect(preclaim.status).toBe(404);

    // Environment slot 1 requires claude-code/mcp → workers[0] (grp-alpha).
    const claim = await workerRequest(h, workers[0], 'POST', `/v1/tasks/${taskId}/claim`, {});
    expect(claim.status).toBe(200);

    // The claimant reads the frozen brief; another pool member does not.
    const brief = await workerRequest(h, workers[0], 'GET', `/v1/testing/assignments/${taskId}/brief`);
    expect(brief.status).toBe(200);
    const briefBody = (await brief.json()) as { brief: { assignment_id: string; target: { allowed_origins: string[] }; constraints: { maximum_external_spend_usd_cents: number } } };
    expect(briefBody.brief.assignment_id).toBe(first.id);
    expect(briefBody.brief.target.allowed_origins).toEqual(['https://sandbox.acme.example']);
    expect(briefBody.brief.constraints.maximum_external_spend_usd_cents).toBe(0);
    expect((await workerRequest(h, workers[1], 'GET', `/v1/testing/assignments/${taskId}/brief`)).status).toBe(404);

    // Public task carries no customer material.
    const publicTask = (await (await h.get(`/v1/tasks/${taskId}`)).json()) as { title?: string; description?: string; task?: { description?: string } };
    const text = JSON.stringify(publicTask);
    expect(text).not.toContain('acme.example');
    expect(text).not.toContain(orderId);
    expect(text).not.toContain('metrics');

    // Suspending eligibility revokes brief access on the very next request.
    await h.post(`/v1/owner/admin/testing/workers/${workers[0].agentId}/eligibility`, {
      operator_group_id: 'grp-alpha', group_confidence: 'operator_reviewed',
      capabilities: ['agent-compatibility-testing'], environments: THREE_GROUPS[0].envs,
      evidence_refs: [], provenance: 'operator_reviewed', status: 'suspended', expires_at: null, notes: '',
    }, op.cookie);
    expect((await workerRequest(h, workers[0], 'GET', `/v1/testing/assignments/${taskId}/brief`)).status).toBe(403);
  });

  it('group diversity: one group cannot take more external runs than slots − (min groups − 1)', () => {
    expect(maxRunsPerGroup(3, 2)).toBe(2);
    expect(maxRunsPerGroup(3, 3)).toBe(1);
    expect(maxRunsPerGroup(1, 1)).toBe(1);
  });

  it('a group that reached its share is pruned from other unclaimed managed tasks (atomic gate refuses it)', async () => {
    // One group covers TWO environments + a second group covers the third.
    const [multiEnvWorker] = await seedWorkers([
      { group: 'grp-multi', envs: [{ client: 'claude-code', transport: 'mcp' }, { client: 'openhands', transport: 'http' }, { client: 'aider', transport: 'http' }] },
      { group: 'grp-solo', envs: [{ client: 'aider', transport: 'http' }] },
    ]);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    const store = new TestingStore(h.db);
    const runs = (await store.listRuns(orderId)).filter((r) => r.kind === 'external');
    const tasks: string[] = [];
    for (const run of runs) tasks.push((await store.getActiveAttempt(run.id))!.task_id!);

    // grp-multi claims runs 1 and 2 (its cap: 3 slots, min 2 groups → 2 runs).
    expect((await workerRequest(h, multiEnvWorker, 'POST', `/v1/tasks/${tasks[0]}/claim`, {})).status).toBe(200);
    await h.runJobs(); // sync + diversity enforcement
    expect((await workerRequest(h, multiEnvWorker, 'POST', `/v1/tasks/${tasks[1]}/claim`, {})).status).toBe(200);
    await h.runJobs();
    // The third task's allowlist no longer contains grp-multi's worker.
    const third = await workerRequest(h, multiEnvWorker, 'POST', `/v1/tasks/${tasks[2]}/claim`, {});
    expect([403, 409]).toContain(third.status);
  });

  it('ordinary marketplace tasks are untouched by the allowlist machinery', async () => {
    const anyAgent = await registerWorkerAgent(h);
    const creator = await registerWorkerAgent(h);
    // A plain unrestricted task from another agent.
    const create = await workerRequest(h, creator, 'POST', '/v1/tasks', {
      title: 'Summarize a public dataset', description: 'plain marketplace task', output_format: 'json',
    });
    expect(create.status).toBe(200);
    const taskId = ((await create.json()) as { task_id: string }).task_id;
    expect((await workerRequest(h, anyAgent, 'POST', `/v1/tasks/${taskId}/claim`, {})).status).toBe(200);
  });
});

describe('evidence intake + review + settlement (spec §11.3, §12, §20.3)', () => {
  async function claimAndSubmit(worker: Worker, taskId: string, opts: Parameters<typeof buildWorkerResult>[1] = {}): Promise<{ result: Record<string, unknown> }> {
    const claim = await workerRequest(h, worker, 'POST', `/v1/tasks/${taskId}/claim`, {});
    expect(claim.status).toBe(200);
    const brief = ((await (await workerRequest(h, worker, 'GET', `/v1/testing/assignments/${taskId}/brief`)).json()) as { brief: Parameters<typeof buildWorkerResult>[0] }).brief;
    const result = buildWorkerResult(brief, opts);
    const deliver = await workerRequest(h, worker, 'POST', `/v1/tasks/${taskId}/deliver`, {
      summary: 'testing result attached', submission_type: 'json', submission_content: JSON.stringify(result),
    });
    expect(deliver.status).toBe(200);
    return { result };
  }

  it('a VALID PRODUCT FAILURE is accepted as payable work and the reservation settles when escrow releases', async () => {
    const workers = await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    const store = new TestingStore(h.db);
    const run = (await store.listRuns(orderId)).find((r) => r.kind === 'external' && r.slot === 1)!;
    const attempt = (await store.getActiveAttempt(run.id))!;
    await claimAndSubmit(workers[0], attempt.task_id!, { outcome: 'product_failure', failureStage: 'tool_schema discovery' });
    await h.runJobs(); // sync → validate → evidence_submitted

    let freshRun = (await store.getRun(run.id))!;
    expect(freshRun.result_state).toBe('evidence_submitted');

    const signed = await operatorSign(h, op, 'testing.review_run', {
      run_id: run.id, run_version: freshRun.version, evidence: 'valid', outcome: 'product_failure',
      marketplace_action: 'accept', note_hash: sha256hexStr('reproducible failure at discovery; evidence checks out'),
    });
    const review = await h.post(`/v1/owner/admin/testing/runs/${run.id}/review`, {
      expected_version: freshRun.version, evidence: 'valid', outcome: 'product_failure',
      environment_demonstrated: true, slot_satisfied: true, operator_group_id: 'grp-alpha',
      marketplace_action: 'accept', note: 'reproducible failure at discovery; evidence checks out', ...signed,
    }, op.cookie);
    expect(review.status).toBe(200);

    freshRun = (await store.getRun(run.id))!;
    expect(freshRun.result_state).toBe('product_failure');

    const task = (await loadTask(h.db, attempt.task_id!))!;
    expect(task.status).toBe('verified'); // negative result, still paid
    await h.runJobs();
    const reservation = (await store.getReservation(attempt.reservation_id!))!;
    expect(['settled', 'committed']).toContain(reservation.state);
    if (task.escrow_status === 'released') expect(reservation.state).toBe('settled');
  });

  it('invalid evidence (scope-hash mismatch) is auto-flagged, does not satisfy coverage, and revision goes through gates', async () => {
    const workers = await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    const store = new TestingStore(h.db);
    const run = (await store.listRuns(orderId)).find((r) => r.kind === 'external' && r.slot === 2)!;
    const attempt = (await store.getActiveAttempt(run.id))!;
    const claim = await workerRequest(h, workers[1], 'POST', `/v1/tasks/${attempt.task_id}/claim`, {});
    expect(claim.status).toBe(200);
    const brief = ((await (await workerRequest(h, workers[1], 'GET', `/v1/testing/assignments/${attempt.task_id}/brief`)).json()) as { brief: { assignment_id: string; scope_hash: string; environment_requirement: { client: string; transport: string } } }).brief;
    const forged = buildWorkerResult({ ...brief, scope_hash: 'sha256-of-something-else' });
    await workerRequest(h, workers[1], 'POST', `/v1/tasks/${attempt.task_id}/deliver`, {
      summary: 'result', submission_type: 'json', submission_content: JSON.stringify(forged),
    });
    await h.runJobs();
    const freshRun = (await store.getRun(run.id))!;
    expect(freshRun.result_state).toBe('evidence_invalid');
    const freshAttempt = (await store.getRunAttempt(attempt.id))!;
    expect(freshAttempt.result_valid).toBe(0);
    expect(freshAttempt.result_invalid_reason).toContain('scope_hash');

    // Operator sends it back for revision through the normal gate.
    const signed = await operatorSign(h, op, 'testing.review_run', {
      run_id: run.id, run_version: freshRun.version, evidence: 'needs_revision', outcome: null,
      marketplace_action: 'revision', note_hash: sha256hexStr('resubmit with the correct frozen scope hash'),
    });
    const review = await h.post(`/v1/owner/admin/testing/runs/${run.id}/review`, {
      expected_version: freshRun.version, evidence: 'needs_revision', outcome: null,
      environment_demonstrated: null, slot_satisfied: false, marketplace_action: 'revision',
      note: 'resubmit with the correct frozen scope hash', ...signed,
    }, op.cookie);
    expect(review.status).toBe(200);
    const task = (await loadTask(h.db, attempt.task_id!))!;
    expect(task.status).toBe('claimed'); // revision through the shared gate
  });

  it('copied evidence across attempts of one order is rejected as duplicate', async () => {
    const workers = await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    const store = new TestingStore(h.db);
    const runs = (await store.listRuns(orderId)).filter((r) => r.kind === 'external');
    const attempt1 = (await store.getActiveAttempt(runs[0].id))!;
    const attempt2 = (await store.getActiveAttempt(runs[1].id))!;
    await claimAndSubmit(workers[0], attempt1.task_id!, { evidenceSalt: 'SHARED' });
    await h.runJobs();
    // Worker 2 copies worker 1's evidence bytes.
    const claim = await workerRequest(h, workers[1], 'POST', `/v1/tasks/${attempt2.task_id}/claim`, {});
    expect(claim.status).toBe(200);
    const brief2 = ((await (await workerRequest(h, workers[1], 'GET', `/v1/testing/assignments/${attempt2.task_id}/brief`)).json()) as { brief: Parameters<typeof buildWorkerResult>[0] }).brief;
    const copied = buildWorkerResult(brief2, { evidenceSalt: 'SHARED' });
    await workerRequest(h, workers[1], 'POST', `/v1/tasks/${attempt2.task_id}/deliver`, {
      summary: 'result', submission_type: 'json', submission_content: JSON.stringify(copied),
    });
    await h.runJobs();
    const freshAttempt2 = (await store.getRunAttempt(attempt2.id))!;
    expect(freshAttempt2.result_valid).toBe(0);
    expect(freshAttempt2.result_invalid_reason).toContain('duplicates');
  });

  it('secret-like content in evidence is rejected without persisting validity', async () => {
    const workers = await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    const store = new TestingStore(h.db);
    const run = (await store.listRuns(orderId)).find((r) => r.kind === 'external' && r.slot === 1)!;
    const attempt = (await store.getActiveAttempt(run.id))!;
    const claim = await workerRequest(h, workers[0], 'POST', `/v1/tasks/${attempt.task_id}/claim`, {});
    expect(claim.status).toBe(200);
    const brief = ((await (await workerRequest(h, workers[0], 'GET', `/v1/testing/assignments/${attempt.task_id}/brief`)).json()) as { brief: Parameters<typeof buildWorkerResult>[0] }).brief;
    const result = buildWorkerResult(brief) as { evidence: Array<{ content: string; content_sha256: string }> };
    result.evidence[0].content = 'captured header authorization: bearer abcdef0123456789abcdef';
    result.evidence[0].content_sha256 = sha256hexStr(result.evidence[0].content);
    await workerRequest(h, workers[0], 'POST', `/v1/tasks/${attempt.task_id}/deliver`, {
      summary: 'result', submission_type: 'json', submission_content: JSON.stringify(result),
    });
    await h.runJobs();
    const fresh = (await store.getRunAttempt(attempt.id))!;
    expect(fresh.result_valid).toBe(0);
    expect(fresh.result_invalid_reason).toContain('secret-like');
  });

  it('marketplace auto-accept pays the worker but raises an urgent reconciliation item, never a report', async () => {
    const workers = await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    const store = new TestingStore(h.db);
    const run = (await store.listRuns(orderId)).find((r) => r.kind === 'external' && r.slot === 1)!;
    const attempt = (await store.getActiveAttempt(run.id))!;
    await claimAndSubmit(workers[0], attempt.task_id!);
    // Simulate the 7-day timer having fired via the shared cron gate.
    await h.db.run(`UPDATE tasks SET auto_release_at = ? WHERE task_id = ?`, new Date(Date.now() - 1000).toISOString(), attempt.task_id);
    const { runTaskCron } = await import('../../cron/tasks.js');
    await runTaskCron(h.db, h.env as never, new Date().toISOString());
    const task = (await loadTask(h.db, attempt.task_id!))!;
    expect(task.status).toBe('verified');
    expect(task.accepted_by).toBe('auto');
    await h.runJobs();
    const alert = await h.db.get(`SELECT semantic_key FROM testing_notifications WHERE kind = 'auto_accept_unreviewed'`);
    expect(alert).not.toBeNull();
    // The run still has no reviewed outcome and no report exists.
    expect((await store.getRun(run.id))!.result_state).toBe('evidence_submitted');
    expect(await store.getDraftReport(orderId)).toBeNull();
  });

  it('replacement: refused while the old attempt is unresolved; allowed after cancel+refund; caps still hold', async () => {
    const workers = await seedWorkers(THREE_GROUPS);
    const { orderId } = await paidOrder(h, op);
    await publishAllExternal(orderId);
    const store = new TestingStore(h.db);
    const run = (await store.listRuns(orderId)).find((r) => r.kind === 'external' && r.slot === 3)!;
    const attempt = (await store.getActiveAttempt(run.id))!;

    // Unresolved (claimed) → replacement refused.
    expect((await workerRequest(h, workers[2], 'POST', `/v1/tasks/${attempt.task_id}/claim`, {})).status).toBe(200);
    await h.runJobs();
    const signedEarly = await operatorSign(h, op, 'testing.replace_attempt', {
      run_id: run.id, order_id: orderId, bounty_usdc_atomic: '5000000', reason_hash: sha256hexStr('worker unresponsive'),
    });
    const early = await h.post(`/v1/owner/admin/testing/runs/${run.id}/replace-attempt`, { reason: 'worker unresponsive', ...signedEarly }, op.cookie);
    expect(early.status).toBe(409);

    // Resolve: review evidence_invalid isn't needed here — the claim never delivered;
    // cancel is refused on claimed tasks unless disputed, so expire the claim via the cron window instead.
    await h.db.run(`UPDATE tasks SET claim_expires_at = ? WHERE task_id = ?`, new Date(Date.now() - 1000).toISOString(), attempt.task_id);
    const { runTaskCron } = await import('../../cron/tasks.js');
    await runTaskCron(h.db, h.env as never, new Date().toISOString());
    const reopened = (await loadTask(h.db, attempt.task_id!))!;
    expect(reopened.status).toBe('open');
    // Operator cancels the open task (releases escrow deposit back to treasury).
    const { serviceMarketplaceAction } = await import('./fulfillment.js');
    const cancel = await serviceMarketplaceAction(h.db, h.env, { task: reopened, action: 'cancel', note: 'replacing', nowIso: new Date().toISOString() });
    expect(cancel.ok).toBe(true);
    await h.runJobs(); // attempt → cancelled; reservation released after refund confirms

    const signed = await operatorSign(h, op, 'testing.replace_attempt', {
      run_id: run.id, order_id: orderId, bounty_usdc_atomic: '5000000', reason_hash: sha256hexStr('worker unresponsive'),
    });
    const replaced = await h.post(`/v1/owner/admin/testing/runs/${run.id}/replace-attempt`, { reason: 'worker unresponsive', ...signed }, op.cookie);
    expect(replaced.status).toBe(200);
    await h.runJobs();
    const attempts = await store.listAttempts(run.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.filter((a) => a.active === 1)).toHaveLength(1);
    // Commitment never exceeded the cap: earmark (reserved) + settled/committed ≤ 30 USDC.
    const remaining = await store.remainingBudget(orderId, '30000000');
    expect(remaining >= 0n).toBe(true);
  });
});

describe('durable operations: manual_review revives on re-enqueue (operator retry)', () => {
  it('re-enqueueing the same semantic key retries a manual_review operation but never resets a succeeded one', async () => {
    const store = new TestingStore(h.db);
    const op = await store.enqueueOperation({ kind: 'publish_task', semanticKey: 'publish:trun_revive:a1', payloadJson: '{}' });
    expect(await store.operationClaim(op.id, h.now())).toBe(true);
    await store.operationFailed(op.id, 'no eligible workers for this environment', { manual: true });
    expect((await store.getOperationByKey('publish:trun_revive:a1'))!.state).toBe('manual_review');

    // The operator fixes the cause and re-approves → same semantic key.
    const revived = await store.enqueueOperation({ kind: 'publish_task', semanticKey: 'publish:trun_revive:a1', payloadJson: '{}' });
    expect(revived.state).toBe('pending');
    expect(revived.last_error).toBeNull();

    expect(await store.operationClaim(revived.id, h.now())).toBe(true);
    await store.operationSucceeded(revived.id, null);
    const again = await store.enqueueOperation({ kind: 'publish_task', semanticKey: 'publish:trun_revive:a1', payloadJson: '{}' });
    expect(again.state).toBe('succeeded'); // idempotency: success is never re-run
  });
});

describe('stale no-coverage alerts are voided by a later successful publication', () => {
  it('drops a PENDING op:no-coverage alert and leaves sent ones alone', async () => {
    const store = new TestingStore(h.db);
    await store.queueNotification({ semanticKey: 'op:no-coverage:trun_stale', kind: 'missing_coverage', recipient: 'ops@example.com', subject: 's', body: 'b' });
    expect(await store.dropPendingNotification('op:no-coverage:trun_stale')).toBe(true);
    expect(await store.notificationsDue(h.now())).toHaveLength(0);

    await store.queueNotification({ semanticKey: 'op:no-coverage:trun_sent', kind: 'missing_coverage', recipient: 'ops@example.com', subject: 's', body: 'b' });
    await store.notificationSent('op:no-coverage:trun_sent');
    expect(await store.dropPendingNotification('op:no-coverage:trun_sent')).toBe(false);
  });
});
