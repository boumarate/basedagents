/**
 * Agent Testing — the required test-mode end-to-end demonstration
 * (spec §20.6), as an executable, deterministic walkthrough:
 *
 *   new human buyer → intake → operator approves quote → hosted test
 *   checkout → verified payment → operator approves bounded task publication
 *   → three simulated integration fixtures submit evidence → operator
 *   reviews/accepts → private report published → buyer views/exports →
 *   buyer requests one retest → buyer starts a separate repeat purchase.
 *
 * The three "workers" here are SIMULATED INTEGRATION FIXTURES exercising the
 * application (fake facilitator, scripted Stripe double, software passkey).
 * They are not evidence that real workers or customer products passed.
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 */
import { it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeHarness, setupOperator, operatorSign, paidOrder, registerWorkerAgent, workerRequest,
  buildWorkerResult, sha256hexStr, type Harness, type Worker,
} from './test-harness.js';
import { TestingStore } from './store.js';
import { loadTask } from '../../tasks/service.js';
import { operatorMetrics } from './metrics.js';

let h: Harness;
let op: Awaited<ReturnType<typeof setupOperator>>;

beforeEach(async () => {
  h = makeHarness();
  op = await setupOperator(h);
});

afterEach(() => h.teardown());

const GROUPS = [
  { group: 'grp-alpha', envs: [{ client: 'claude-code', transport: 'mcp' }] },
  { group: 'grp-beta', envs: [{ client: 'openhands', transport: 'http' }] },
  { group: 'grp-gamma', envs: [{ client: 'aider', transport: 'http' }] },
];

async function seedWorkers(): Promise<Worker[]> {
  const platform = await registerWorkerAgent(h, 'BasedAgents Testing');
  h.env.TESTING_PLATFORM_AGENT_ID = platform.agentId;
  const workers: Worker[] = [];
  for (const g of GROUPS) {
    const worker = await registerWorkerAgent(h);
    workers.push(worker);
    await h.post(`/v1/owner/admin/testing/workers/${worker.agentId}/eligibility`, {
      operator_group_id: g.group, group_confidence: 'operator_reviewed',
      capabilities: ['agent-compatibility-testing'], environments: g.envs,
      evidence_refs: ['fixture'], provenance: 'operator_reviewed', status: 'approved', expires_at: null, notes: '',
    }, op.cookie);
  }
  return workers;
}

it('full journey: buyer → paid order → 3 fixture submissions (one product failure) → reviewed → published report → export → retest → repeat', async () => {
  const workers = await seedWorkers();
  const store = new TestingStore(h.db);

  // 1–10. buyer, intake, quote, checkout, verified payment, plan.
  const { buyer, orderId, requestId } = await paidOrder(h, op);

  // 11a. operator approves bounded publication of all three external runs.
  const runs = (await store.listRuns(orderId)).filter((r) => r.kind === 'external');
  const quote = (await store.getQuote((await store.getOrder(orderId))!.quote_id))!;
  const runIds = runs.map((r) => r.id).sort();
  const pubSigned = await operatorSign(h, op, 'testing.publish_tasks', {
    order_id: orderId, run_ids: runIds, scope_hash: quote.scope_hash,
    bounty_usdc_atomic: quote.worker_bounty_usdc_atomic,
    total_commitment_usdc_atomic: String(BigInt(quote.worker_bounty_usdc_atomic) * 3n),
    worker_cap_usdc_atomic: quote.worker_cap_usdc_atomic,
  });
  expect((await h.post(`/v1/owner/admin/testing/orders/${orderId}/publish-tasks`, { run_ids: runIds, ...pubSigned }, op.cookie)).status).toBe(200);
  await h.runJobs();

  // Customer status: Testing (real active assignments exist now).
  let view = (await (await h.get(`/v1/owner/testing/orders/${orderId}`, buyer.cookie)).json()) as { order: { stage: string; external_runs_complete?: number } };
  expect(view.order.stage).toBe('Testing');

  // 11b. three fixture workers claim, fetch briefs, execute, submit evidence.
  // Worker on slot 2 finds a real PRODUCT FAILURE (the required negative path).
  const outcomes: Array<'product_success' | 'product_failure'> = ['product_success', 'product_failure', 'product_success'];
  for (let i = 0; i < runs.length; i++) {
    const attempt = (await store.getActiveAttempt(runs[i].id))!;
    expect((await workerRequest(h, workers[i], 'POST', `/v1/tasks/${attempt.task_id}/claim`, {})).status).toBe(200);
    const brief = ((await (await workerRequest(h, workers[i], 'GET', `/v1/testing/assignments/${attempt.task_id}/brief`)).json()) as { brief: Parameters<typeof buildWorkerResult>[0] }).brief;
    const result = buildWorkerResult(brief, outcomes[i] === 'product_failure'
      ? { outcome: 'product_failure', failureStage: 'tool_schema discovery' }
      : { outcome: 'product_success' });
    expect((await workerRequest(h, workers[i], 'POST', `/v1/tasks/${attempt.task_id}/deliver`, {
      summary: 'testing result attached', submission_type: 'json', submission_content: JSON.stringify(result),
    })).status).toBe(200);
  }
  await h.runJobs(); // validation triage

  // 11c. operator records the internal baseline (identified as internal).
  const baseline = (await store.listRuns(orderId)).find((r) => r.kind === 'baseline')!;
  const baseSigned = await operatorSign(h, op, 'testing.review_run', {
    run_id: baseline.id, run_version: baseline.version, evidence: 'valid', outcome: 'product_success',
    marketplace_action: 'none', note_hash: sha256hexStr('internal baseline completed the workflow'),
  });
  expect((await h.post(`/v1/owner/admin/testing/runs/${baseline.id}/review`, {
    expected_version: baseline.version, evidence: 'valid', outcome: 'product_success',
    environment_demonstrated: null, slot_satisfied: true, marketplace_action: 'none',
    note: 'internal baseline completed the workflow', ...baseSigned,
  }, op.cookie)).status).toBe(200);

  // 11d. operator reviews and ACCEPTS all three deliveries — including the
  // product failure, which is valid, payable work.
  for (let i = 0; i < runs.length; i++) {
    const fresh = (await store.getRun(runs[i].id))!;
    expect(fresh.result_state).toBe('evidence_submitted');
    const note = outcomes[i] === 'product_failure' ? 'reproducible discovery failure; evidence valid' : 'workflow completed; evidence valid';
    const signed = await operatorSign(h, op, 'testing.review_run', {
      run_id: runs[i].id, run_version: fresh.version, evidence: 'valid', outcome: outcomes[i],
      marketplace_action: 'accept', note_hash: sha256hexStr(note),
    });
    expect((await h.post(`/v1/owner/admin/testing/runs/${runs[i].id}/review`, {
      expected_version: fresh.version, evidence: 'valid', outcome: outcomes[i],
      environment_demonstrated: true, slot_satisfied: true, operator_group_id: GROUPS[i].group,
      marketplace_action: 'accept', note, ...signed,
    }, op.cookie)).status).toBe(200);
    const attempt = (await store.getActiveAttempt(runs[i].id))!;
    expect(((await loadTask(h.db, attempt.task_id!))!).status).toBe('verified');
  }
  await h.runJobs(); // reservations settle as escrow releases

  // Customer status now shows 3/3 valid reviewed runs.
  view = (await (await h.get(`/v1/owner/testing/orders/${orderId}`, buyer.cookie)).json()) as { order: { stage: string; external_runs_complete?: number } };
  expect(view.order.external_runs_complete).toBe(3);

  // 12a. deterministic draft from reviewed records; the failure appears as a
  // BLOCKING finding, not a rejected result.
  const draftRes = await h.post(`/v1/owner/admin/testing/orders/${orderId}/report-draft`, {}, op.cookie);
  expect(draftRes.status).toBe(200);
  const draft = ((await draftRes.json()) as { report: { id: string; source_hash?: string; document: { findings: Array<{ severity: string; baseline_relation: string; finding_id: string }>; coverage: { external_runs_valid: number }; baseline: { ran: boolean } } } }).report;
  expect(draft.document.coverage.external_runs_valid).toBe(3);
  expect(draft.document.baseline.ran).toBe(true);
  expect(draft.document.findings).toHaveLength(1);
  expect(draft.document.findings[0].severity).toBe('blocking');
  expect(draft.document.findings[0].baseline_relation).toBe('external_only');

  // Draft is not visible to the customer.
  expect((await h.get(`/v1/owner/testing/reports/${draft.id}`, buyer.cookie)).status).toBe(404);

  // 12b. publish (fresh assertion) → customer notified, retest window armed.
  const row = (await store.getReport(draft.id))!;
  const pubReport = await operatorSign(h, op, 'testing.publish_report', {
    report_id: row.id, order_id: orderId, report_version: row.version, source_hash: row.source_hash,
  });
  expect((await h.post(`/v1/owner/admin/testing/reports/${row.id}/publish`, { source_hash: row.source_hash, ...pubReport }, op.cookie)).status).toBe(200);
  await h.runJobs(); // deliver the email
  expect(h.email.messages.some((m) => m.to === buyer.email && /report is ready/i.test(m.subject))).toBe(true);

  // 12c. buyer views + exports; exports carry version, scope hash, timestamps.
  const reportView = await h.get(`/v1/owner/testing/reports/${row.id}`, buyer.cookie);
  expect(reportView.status).toBe(200);
  expect(reportView.headers.get('Cache-Control')).toContain('no-store');
  const reportDoc = ((await reportView.json()) as { report: { executive_summary: string; scope_hash: string } }).report;
  expect(reportDoc.executive_summary).toContain('3 of 3');

  const md = await h.get(`/v1/owner/testing/reports/${row.id}/export?format=md`, buyer.cookie);
  expect(md.status).toBe(200);
  const mdText = await md.text();
  expect(mdText).toContain(`Report v1`);
  expect(mdText).toContain(reportDoc.scope_hash);
  expect(mdText).toContain('BLOCKING');
  const json = await h.get(`/v1/owner/testing/reports/${row.id}/export?format=json`, buyer.cookie);
  expect(json.status).toBe(200);
  expect(((JSON.parse(await json.text())) as { version: number }).version).toBe(1);

  // Published reports are immutable; a draft edit on it is refused.
  expect((await h.patch(`/v1/owner/admin/testing/reports/${row.id}`, { document: JSON.parse(row.report_json) }, op.cookie)).status).toBe(409);

  // 13a. buyer requests the included targeted retest against the finding.
  const finding = draft.document.findings[0];
  const retest = await h.post(`/v1/owner/testing/orders/${orderId}/retest-request`, {
    finding_id: finding.finding_id,
    change_description: 'We added the aggregates endpoint to the tool listing.',
    updated_target: 'https://sandbox.acme.example release 2026-09.1',
  }, buyer.cookie);
  expect(retest.status).toBe(200);
  const retestRun = (await store.listRuns(orderId)).find((r) => r.kind === 'retest')!;
  expect(retestRun.parent_finding_id).toBe(finding.finding_id);
  // Second retest request → refused (one included slot).
  expect((await h.post(`/v1/owner/testing/orders/${orderId}/retest-request`, {
    finding_id: finding.finding_id, change_description: 'again', updated_target: 'same',
  }, buyer.cookie)).status).toBe(409);

  // Operator publishes the retest from the protected earmark.
  const retestSigned = await operatorSign(h, op, 'testing.publish_tasks', {
    order_id: orderId, run_ids: [retestRun.id], scope_hash: quote.scope_hash,
    bounty_usdc_atomic: quote.worker_bounty_usdc_atomic,
    total_commitment_usdc_atomic: quote.worker_bounty_usdc_atomic,
    worker_cap_usdc_atomic: quote.worker_cap_usdc_atomic,
  });
  expect((await h.post(`/v1/owner/admin/testing/orders/${orderId}/publish-tasks`, { run_ids: [retestRun.id], ...retestSigned }, op.cookie)).status).toBe(200);
  await h.runJobs();
  const retestAttempt = (await store.getActiveAttempt(retestRun.id))!;
  expect(retestAttempt.task_id).toBeTruthy();
  // The earmark was converted, not new budget: total open commitment ≤ cap.
  expect((await store.remainingBudget(orderId, quote.worker_cap_usdc_atomic)) >= 0n).toBe(true);

  // The retest STILL FAILS (product not actually fixed) — appended as a new
  // version, original observations unchanged, and the worker is still paid.
  expect((await workerRequest(h, workers[1], 'POST', `/v1/tasks/${retestAttempt.task_id}/claim`, {})).status).toBe(200);
  const retestBrief = ((await (await workerRequest(h, workers[1], 'GET', `/v1/testing/assignments/${retestAttempt.task_id}/brief`)).json()) as { brief: Parameters<typeof buildWorkerResult>[0] }).brief;
  const retestResult = buildWorkerResult(retestBrief, { outcome: 'product_failure', failureStage: 'tool_schema discovery' });
  expect((await workerRequest(h, workers[1], 'POST', `/v1/tasks/${retestAttempt.task_id}/deliver`, {
    summary: 'retest result', submission_type: 'json', submission_content: JSON.stringify(retestResult),
  })).status).toBe(200);
  await h.runJobs();
  const freshRetest = (await store.getRun(retestRun.id))!;
  const retestReview = await operatorSign(h, op, 'testing.review_run', {
    run_id: retestRun.id, run_version: freshRetest.version, evidence: 'valid', outcome: 'product_failure',
    marketplace_action: 'accept', note_hash: sha256hexStr('still failing at discovery'),
  });
  expect((await h.post(`/v1/owner/admin/testing/runs/${retestRun.id}/review`, {
    expected_version: freshRetest.version, evidence: 'valid', outcome: 'product_failure',
    environment_demonstrated: true, slot_satisfied: true, operator_group_id: 'grp-beta',
    marketplace_action: 'accept', note: 'still failing at discovery', ...retestReview,
  }, op.cookie)).status).toBe(200);

  const draft2Res = await h.post(`/v1/owner/admin/testing/orders/${orderId}/report-draft`, {}, op.cookie);
  const draft2 = ((await draft2Res.json()) as { report: { id: string; document: { version: number } } }).report;
  expect(draft2.document.version).toBe(2);
  const row2 = (await store.getReport(draft2.id))!;
  const pub2 = await operatorSign(h, op, 'testing.publish_report', {
    report_id: row2.id, order_id: orderId, report_version: 2, source_hash: row2.source_hash,
  });
  expect((await h.post(`/v1/owner/admin/testing/reports/${row2.id}/publish`, { source_hash: row2.source_hash, ...pub2 }, op.cookie)).status).toBe(200);
  // v1 stays immutable and readable.
  expect(((await (await h.get(`/v1/owner/testing/reports/${row.id}`, buyer.cookie)).json()) as { report: { version: number } }).report.version).toBe(1);

  // 13b. feedback + repeat purchase (new draft, fresh consent, no charge).
  expect((await h.post(`/v1/owner/testing/orders/${orderId}/feedback`, {
    useful: 'yes', action_taken: 'fixed the tool listing', incremental: 'external_only',
  }, buyer.cookie)).status).toBe(200);
  const repeat = await h.post(`/v1/owner/testing/orders/${orderId}/repeat`, {}, buyer.cookie);
  expect(repeat.status).toBe(200);
  const newDraft = ((await repeat.json()) as { request: { id: string; status: string } }).request;
  expect(newDraft.status).toBe('draft');
  expect(newDraft.id).not.toBe(requestId);
  expect((await store.getOrder(orderId))!.payment_state).toBe('succeeded'); // nothing re-charged

  // Metrics reflect one external customer, exact counts, no invented scores.
  const metrics = await operatorMetrics(h.db);
  const demand = metrics.external_demand as { unique_paying_customers: number; repeat_payments: number };
  expect(demand.unique_paying_customers).toBe(1);
  expect(demand.repeat_payments).toBe(0); // repeat DRAFT exists; no second payment yet
  const delivery = metrics.delivery as { delivered_orders: number };
  expect(delivery.delivered_orders).toBe(1);
}, 30_000);

it('founder/test-fixture orders never inflate external demand metrics', async () => {
  await seedWorkers();
  const { orderId, requestId } = await paidOrder(h, op);
  expect((await h.post(`/v1/owner/admin/testing/requests/${requestId}/source`, { source: 'founder_sample' }, op.cookie)).status).toBe(200);
  await h.db.run(`UPDATE testing_orders SET source = 'founder_sample' WHERE id = ?`, orderId);
  const metrics = await operatorMetrics(h.db);
  const demand = metrics.external_demand as { unique_paying_customers: number; related_party_or_test_orders_excluded: number };
  expect(demand.unique_paying_customers).toBe(0);
  expect(demand.related_party_or_test_orders_excluded).toBe(1);
});
