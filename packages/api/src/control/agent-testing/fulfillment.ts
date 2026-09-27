/**
 * Agent Testing — the marketplace bridge (spec §10, §11.1).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * Managed assignments are ordinary marketplace tasks created by the platform
 * service principal ("BasedAgents Testing", TESTING_PLATFORM_AGENT_ID)
 * through the SAME escrow funding handshake and lifecycle gates every other
 * task uses — never fake completed rows, never direct status UPDATEs past the
 * gates. Customer identity is attached to the private order, not to the task.
 *
 * Publication is a durable operation: budget reserved atomically first, task
 * id pre-generated and persisted before the external call, and every step
 * idempotent so a crash resumes instead of double-publishing or double-
 * spending. Public task content carries NO customer material — workers fetch
 * the frozen private brief through their authenticated assignment endpoint.
 */
import type { DBAdapter } from '../../db/adapter.js';
import type { Bindings } from '../../types/index.js';
import {
  TestingStore, type OrderRow, type QuoteRow, type RunRow, type RunAttemptRow, type EligibilityRow, type OperationRow,
} from './store.js';
import { QuoteScopeSchema, type QuoteScope, type EnvironmentRequirement, type WorkerBrief } from './schemas.js';
import { testingEnv, testingFlags } from './catalog.js';
import { treasuryFor } from './treasury.js';
import { fundEscrowTask, startEscrowLeg, acceptEscrowTask } from '../../payments/escrow.js';
import { buildRequirements } from '../../payments/x402.js';
import { houseWalletFor } from '../../payments/house-wallet.js';
import { paymentProviderFor } from '../../payments/index.js';
import {
  loadTask, revisionGate, disputeGate, cancelGate, cancelRefusal, type TaskRow, type Actor,
} from '../../tasks/service.js';
import { generatePublicId } from '../../lib/ids.js';
import { validateWorkerSubmission } from './evidence.js';
import { queueOperatorNotification } from './notify.js';

export const BOUNTY_NETWORK = 'eip155:8453';

export function platformAgentId(env: unknown): string | null {
  return testingEnv(env).TESTING_PLATFORM_AGENT_ID || null;
}

export async function servicePrincipal(db: DBAdapter, env: unknown): Promise<{ ok: true; agentId: string } | { ok: false; reason: string }> {
  const agentId = platformAgentId(env);
  if (!agentId) return { ok: false, reason: 'TESTING_PLATFORM_AGENT_ID is not configured' };
  const row = await db.get<{ id: string; status: string }>('SELECT id, status FROM agents WHERE id = ?', agentId);
  if (!row) return { ok: false, reason: `service principal agent ${agentId} is not registered` };
  if (row.status !== 'active') return { ok: false, reason: `service principal agent ${agentId} is not active` };
  return { ok: true, agentId };
}

// ─── eligibility (spec §10.4, §9.2) ───

interface DeclaredEnvironment {
  client: string;
  transport: string;
  fingerprint?: string;
}

function environmentsOf(row: EligibilityRow): DeclaredEnvironment[] {
  try {
    const parsed = JSON.parse(row.environments_json) as DeclaredEnvironment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function matchesRequirement(envs: DeclaredEnvironment[], req: EnvironmentRequirement): boolean {
  const want = (s: string) => s.trim().toLowerCase();
  return envs.some((e) => want(e.client ?? '') === want(req.client) && want(e.transport ?? '') === want(req.transport));
}

/** A group may take at most slots − (minGroups − 1) of an order's external runs. */
export function maxRunsPerGroup(slots: number, minGroups: number): number {
  return Math.max(1, slots - Math.max(1, minGroups) + 1);
}

/**
 * Approved, unexpired workers whose reviewed environments match this run's
 * requirement, excluding operator groups that already exhausted their share
 * of this order's diversity budget. Returns agent ids for the claim allowlist.
 */
export async function eligibleAgentsForRun(
  db: DBAdapter,
  run: RunRow,
  quote: QuoteRow,
  nowIso: string,
): Promise<string[]> {
  const store = new TestingStore(db);
  const req = JSON.parse(run.environment_json) as EnvironmentRequirement;
  const eligible = (await store.listApprovedEligibility(nowIso)).filter((row) => matchesRequirement(environmentsOf(row), req));

  // Diversity budget: groups already holding claimed/submitted/accepted
  // attempts on this order's OTHER external runs.
  const runs = await store.listRuns(run.order_id);
  const groupUse = new Map<string, number>();
  for (const r of runs.filter((r) => r.kind !== 'baseline' && r.id !== run.id)) {
    const attempt = await store.getActiveAttempt(r.id);
    if (attempt?.agent_id && ['claimed', 'submitted', 'accepted'].includes(attempt.state)) {
      const el = await store.getEligibility(attempt.agent_id);
      const g = el?.operator_group_id ?? `unknown:${attempt.agent_id}`;
      groupUse.set(g, (groupUse.get(g) ?? 0) + 1);
    }
  }
  const cap = maxRunsPerGroup(quote.external_run_slots, quote.min_operator_groups);
  return eligible
    .filter((row) => (groupUse.get(row.operator_group_id) ?? 0) < cap)
    .map((row) => row.agent_id);
}

// ─── the public listing + private brief (spec §11) ───

export function parseScopeJson(quote: QuoteRow): QuoteScope {
  return QuoteScopeSchema.parse(JSON.parse(quote.scope_json));
}

/** Public task content: generic by default — no customer name, target, fixture or order ids. */
export function publicTaskFields(req: EnvironmentRequirement, kind: 'external' | 'retest'): {
  title: string; description: string; category: 'research'; required_capabilities: string[]; expected_output: string; output_format: 'json';
} {
  const label = kind === 'retest' ? 'targeted retest' : 'compatibility test';
  return {
    title: `Run an independent agent ${label} in an approved environment`,
    description: [
      `BasedAgents Testing commissions a scoped, authorized ${label} of a customer product workflow.`,
      '',
      `Required environment: ${req.client} over ${req.transport}${req.native_execution_required ? ' (native execution — no simulation)' : ''}.`,
      'This assignment is restricted to the pre-approved worker pool for that environment; other claims are refused.',
      '',
      'After claiming, retrieve your private brief (objective, allowed origins, fixture, limits) with your agent signature:',
      '  GET /v1/testing/assignments/{this task id}/brief',
      '',
      'Deliver ONE JSON document matching the worker-result contract named in the brief (submission_type "json").',
      'Acceptance rules: actual execution in your declared environment, redacted evidence for every step, environment fields observed not invented.',
      'A reproducible product FAILURE with valid evidence is payable work. A simulated run, missing environment, invented trace or copied submission is not.',
      'Execution limits and the no-external-spend rule are in the brief. Do not post about the assignment publicly.',
    ].join('\n'),
    category: 'research',
    required_capabilities: ['agent-compatibility-testing'],
    expected_output: 'One JSON worker-result document per the brief (schema worker-result-1.0); evidence redacted; unknown environment fields null.',
    output_format: 'json',
  };
}

export function buildWorkerBrief(input: {
  attemptId: string; run: RunRow; scope: QuoteScope; req: EnvironmentRequirement;
}): WorkerBrief {
  const { scope, req } = input;
  let fixtureInput: unknown = {};
  if (scope.fixture.inline) {
    try { fixtureInput = JSON.parse(scope.fixture.inline); } catch { fixtureInput = scope.fixture.inline; }
  } else if (scope.fixture.url) {
    fixtureInput = { fixture_url: scope.fixture.url };
  }
  return {
    schema_version: '1.0',
    assignment_id: input.attemptId,
    run_id: input.run.id,
    scope_hash: input.run.scope_hash,
    task_type: 'external_agent_compatibility_test',
    objective: scope.workflow_objective,
    target: {
      documentation_url: scope.documentation_url,
      allowed_origins: scope.allowed_origins,
      release_identifier: scope.release_identifier,
    },
    environment_requirement: {
      client: req.client,
      transport: req.transport,
      native_execution_required: req.native_execution_required,
    },
    fixture: {
      classification: 'synthetic',
      input: fixtureInput,
      expected_output: scope.expected_result,
      comparison_rules: [],
    },
    procedure: [
      'Start a fresh task session with only the supplied public instructions.',
      'Attempt the approved workflow in your actual declared environment.',
      'Stop at completion, a reproducible blocker, or the execution limit.',
      'Submit the observed result with redacted execution evidence.',
    ],
    constraints: {
      maximum_external_spend_usd_cents: 0,
      maximum_requests: scope.max_requests,
      maximum_execution_seconds: scope.max_execution_seconds,
      production_writes: false,
      allowed_sandbox_write_steps: scope.read_only ? [] : scope.sandbox_write_steps,
      customer_credentials_provided: false,
      public_posting: false,
      unapproved_source_inspection: false,
    },
    acceptance: {
      positive_product_result_required: false,
      actual_execution_required: true,
      required_environment_evidence: true,
      redacted_trace_required: true,
      result_schema_version: '1.0',
    },
  };
}

// ─── publication approval (operator action) ───

export type ApprovePublicationResult =
  | { ok: true; operations: string[] }
  | { ok: false; error: string; message: string };

/**
 * Operator-approved publication of specific runs: atomically reserve each
 * run's bounty against the order cap and enqueue one durable publish
 * operation per run. Nothing external happens here — the jobs runner
 * executes the operations. Idempotent per (run, attempt#).
 */
export async function approveRunPublication(db: DBAdapter, env: unknown, input: {
  order: OrderRow; quote: QuoteRow; runIds: string[]; actor: string; assertionId: string | null;
}): Promise<ApprovePublicationResult> {
  const store = new TestingStore(db);
  const flags = testingFlags(env);
  if (!flags.fulfillmentEnabled) return { ok: false, error: 'billing_unavailable', message: 'Fulfillment is not enabled on this deployment.' };
  if (input.order.payment_state !== 'succeeded') return { ok: false, error: 'payment_not_confirmed', message: 'The order is not paid.' };
  if (input.order.risk_hold) return { ok: false, error: 'financial_hold', message: 'The order is under a financial hold.' };
  // 'delivered' stays publishable: the included retest starts exactly after
  // the initial report is published (spec §17.1).
  if (['paused', 'cancelled', 'cannot_fulfill'].includes(input.order.fulfillment_state)) {
    return { ok: false, error: 'invalid_state', message: `Order fulfillment is ${input.order.fulfillment_state}.` };
  }

  const ops: string[] = [];
  for (const runId of input.runIds) {
    const run = await store.getRun(runId);
    if (!run || run.order_id !== input.order.id) return { ok: false, error: 'not_found', message: `Run ${runId} not found on this order.` };
    if (run.kind === 'baseline') return { ok: false, error: 'invalid_state', message: 'The internal baseline is not published to the marketplace.' };
    const active = await store.getActiveAttempt(runId);
    if (active) continue; // already has an active attempt — idempotent skip
    const attemptNo = (await store.listAttempts(runId)).length + 1;
    const ref = `publish:${runId}:a${attemptNo}`;
    const purpose = run.kind === 'retest' ? 'retest_run' : attemptNo === 1 ? 'external_run' : 'replacement';

    if (run.kind === 'retest') {
      // The retest consumes its protected earmark: convert it instead of
      // reserving new budget (spec §17.1).
      const earmark = await store.getReservationByRef(`earmark:${input.order.id}`);
      if (earmark && earmark.state === 'reserved' && earmark.purpose === 'retest_earmark') {
        await store.reservationGate(earmark.id, ['reserved'], 'reserved', { purpose: 'retest_run' });
      } else {
        const reserved = await store.reserveBudget({
          orderId: input.order.id, operationRef: ref, purpose, amountAtomic: input.quote.worker_bounty_usdc_atomic,
          capAtomic: input.quote.worker_cap_usdc_atomic,
        });
        if (!reserved.ok) return { ok: false, error: 'budget_exceeded', message: 'The retest cannot be funded within the remaining cap. Authorize an explicit budget exception or record a remedy.' };
      }
    } else {
      const reserved = await store.reserveBudget({
        orderId: input.order.id, operationRef: ref, purpose, amountAtomic: input.quote.worker_bounty_usdc_atomic,
        capAtomic: input.quote.worker_cap_usdc_atomic,
      });
      if (!reserved.ok) {
        return { ok: false, error: 'budget_exceeded', message: `Publishing run ${runId} would exceed the approved worker cap.` };
      }
    }

    const op = await store.enqueueOperation({
      kind: 'publish_task',
      semanticKey: ref,
      orderId: input.order.id,
      payloadJson: JSON.stringify({ run_id: runId, attempt_no: attemptNo, reservation_ref: run.kind === 'retest' ? `earmark:${input.order.id}` : ref }),
    });
    ops.push(op.id);
    await store.audit({
      actor: input.actor, action: 'publication_approved', objectKind: 'run', objectId: runId,
      reason: `bounty ${input.quote.worker_bounty_usdc_atomic} atomic`, assertionId: input.assertionId,
    });
  }
  await store.orderFulfillmentGate(input.order.id, ['ready', 'reviewing'], 'running');
  return { ok: true, operations: ops };
}

// ─── the durable publish operation ───

interface PublishPayload {
  run_id: string;
  attempt_no: number;
  reservation_ref: string;
  task_id?: string;
  deposit_nonce?: string;
}

/**
 * Execute one publish operation: create attempt → compute eligible pool →
 * pre-generate + persist task id → escrow-fund the task from the treasury →
 * link, allowlist, commit reservation. Crash-safe at every arrow (the task id
 * and nonce are persisted BEFORE the external call; retries converge).
 */
export async function executePublishOperation(db: DBAdapter, env: unknown, op: OperationRow): Promise<void> {
  const store = new TestingStore(db);
  const payload = JSON.parse(op.payload_json) as PublishPayload;
  const run = await store.getRun(payload.run_id);
  if (!run) throw new Error(`run ${payload.run_id} missing`);
  const order = await store.getOrder(run.order_id);
  if (!order) throw new Error(`order ${run.order_id} missing`);
  const quote = await store.getQuote(order.quote_id);
  if (!quote) throw new Error(`quote missing for order ${order.id}`);

  const flags = testingFlags(env);
  if (!flags.fulfillmentEnabled) throw new Error('fulfillment disabled');
  if (order.risk_hold || order.fulfillment_state === 'paused') throw new Error('order is held/paused; publication deferred');
  if (order.payment_state !== 'succeeded') throw new Error('order not paid');

  const principal = await servicePrincipal(db, env);
  if (!principal.ok) throw new Error(principal.reason);

  // Attempt row (publication_ref = the op's semantic key → replays converge).
  let attempt = await store.getAttemptByPublicationRef(op.semantic_key);
  if (!attempt) {
    const scope = parseScopeJson(quote);
    const req = JSON.parse(run.environment_json) as EnvironmentRequirement;
    const attemptId = generatePublicId('tatt');
    const brief = buildWorkerBrief({ attemptId, run, scope, req });
    // NOTE: createRunAttempt generates its own id; build the brief AFTER we
    // know it. Two-step: create with placeholder assignment id is wrong —
    // so create the attempt with the brief carrying its publication ref, then
    // rewrite assignment_id to the real attempt id.
    attempt = await store.createRunAttempt({
      runId: run.id,
      publicationRef: op.semantic_key,
      briefJson: JSON.stringify(brief),
      reservationId: (await store.getReservationByRef(payload.reservation_ref))?.id ?? null,
    });
    if (!attempt) {
      const existing = await store.getActiveAttempt(run.id);
      if (existing && existing.publication_ref !== op.semantic_key) {
        throw new Error(`run ${run.id} already has an active attempt ${existing.id}`);
      }
      attempt = await store.getAttemptByPublicationRef(op.semantic_key);
      if (!attempt) throw new Error('attempt creation raced and cannot be resolved');
    } else {
      const fixedBrief = { ...brief, assignment_id: attempt.id };
      await db.run('UPDATE testing_run_attempts SET brief_json = ? WHERE id = ?', JSON.stringify(fixedBrief), attempt.id);
    }
  }
  if (attempt.task_id) {
    // Already linked (retry after crash) — finish the idempotent tail below.
  }

  // Eligible worker pool for the allowlist (recomputed at execute time).
  const eligible = await eligibleAgentsForRun(db, run, quote, new Date().toISOString());
  if (eligible.length === 0) {
    await queueOperatorNotification(store, env, {
      semanticKey: `op:no-coverage:${run.id}`,
      kind: 'missing_coverage',
      orderId: order.id,
      subject: 'No eligible workers for an approved run',
      body: `Run ${run.id} (order ${order.id}) has no approved workers matching its environment. Review eligibility or adjust scope with the customer.`,
    });
    throw new Error('no eligible workers for this environment');
  }

  // Pre-generate and persist the task id + deposit nonce BEFORE any external
  // call, so a crash between task creation and linking is recoverable by
  // this durable reference (spec §10.2 step 2/7).
  if (!payload.task_id) {
    payload.task_id = generatePublicId('task');
    payload.deposit_nonce = randomHexNonce();
    await store.updateOperationPayload(op.id, JSON.stringify(payload));
  }
  const taskId = payload.task_id;

  const existingTask = await loadTask(db, taskId);
  if (!existingTask) {
    // Fund + create through the shared escrow path, deposit signed by the
    // SEPARATE testing treasury (never customer money, never the escrow
    // wallet paying itself).
    const treasury = treasuryFor(env);
    const house = houseWalletFor(env as Bindings);
    if (!treasury) throw new Error('funding_unavailable: testing treasury key is not configured');
    if (!house || !paymentProviderFor(env as Bindings)) throw new Error('funding_unavailable: escrow/payments are not configured');

    const scope = parseScopeJson(quote);
    void scope;
    const req = JSON.parse(run.environment_json) as EnvironmentRequirement;
    const fields = publicTaskFields(req, run.kind === 'retest' ? 'retest' : 'external');
    const requirements = buildRequirements(
      { task_id: taskId, bounty_amount: quote.worker_bounty_usdc_atomic, bounty_network: BOUNTY_NETWORK },
      house.address,
      env as Bindings,
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const rawHeader = treasury.signDepositHeader(requirements, nowSec, payload.deposit_nonce);
    const outcome = await fundEscrowTask(db, env as Bindings, {
      kind: 'new',
      funnel: 'agent',
      task: {
        task_id: taskId,
        creator_agent_id: principal.agentId,
        creator_owner_id: null,
        creator_kind: 'agent',
        creator_assertion_id: null,
        proposer_signature: null,
        title: fields.title,
        description: fields.description,
        category: fields.category,
        required_capabilities: fields.required_capabilities,
        expected_output: fields.expected_output,
        output_format: fields.output_format,
        bounty: { amount: quote.worker_bounty_usdc_atomic, token: 'USDC', network: BOUNTY_NETWORK },
      },
    }, { rawHeader, nowIso: new Date().toISOString(), actor: { kind: 'agent', agentId: principal.agentId } });

    const body = outcome.body as { ok?: boolean; error?: string; message?: string };
    if (outcome.status !== 200 || !body.ok) {
      // authorization_reused with our own persisted nonce = the deposit
      // landed on a previous try; re-read the task instead of failing.
      if (body.error === 'authorization_reused' && (await loadTask(db, taskId))) {
        // fall through to linking
      } else {
        throw new Error(`task funding failed (${body.error ?? outcome.status}): ${body.message ?? ''}`.slice(0, 400));
      }
    }
  }

  // Link + restrict + display state. Confirm actual funded/claimable state
  // before the task counts as published (spec §10.2 step 6).
  await store.attachTaskToAttempt(attempt.id, taskId);
  await store.setTaskAllowlist(taskId, eligible);
  const task = await loadTask(db, taskId);
  if (!task) throw new Error('task vanished after funding');
  await store.updateAttemptMirrors(attempt.id, task.status, task.payment_status);
  if (task.escrow && task.escrow_status !== 'funded') {
    // Deposit still settling — the settle cron finishes it; the task is not
    // claimable until then and we surface that honestly.
    await store.audit({ actor: 'system:fulfillment', action: 'publish_pending_settlement', objectKind: 'run', objectId: run.id, reason: taskId });
  }
  const reservation = payload.reservation_ref ? await store.getReservationByRef(payload.reservation_ref) : null;
  if (reservation) await store.reservationGate(reservation.id, ['reserved'], 'committed', { attemptId: attempt.id });
  // A publication that succeeds supersedes any still-queued "no coverage"
  // alert from an earlier failed try — a stale alert delivered after the fix
  // reads as a live problem (field report). Already-sent alerts stand.
  await store.dropPendingNotification(`op:no-coverage:${run.id}`);
  await store.metricEvent('initial_run_started', { orderId: order.id, requestId: order.request_id });
  await store.audit({ actor: 'system:fulfillment', action: 'task_published', objectKind: 'run', objectId: run.id, reason: `task ${taskId}` });
}

function randomHexNonce(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ─── marketplace state sync (jobs) ───

/**
 * Mirror managed-task state into run attempts, validate submissions on
 * arrival, prune allowlists for diversity, settle reservations, and raise
 * deadline alerts. Read-mostly; every write is guarded.
 */
export async function syncManagedTasks(db: DBAdapter, env: unknown, nowIso: string): Promise<{ synced: number }> {
  const store = new TestingStore(db);
  const attempts = await store.listActiveAttemptsWithTasks();
  let synced = 0;
  for (const attempt of attempts) {
    const task = await loadTask(db, attempt.task_id!);
    if (!task) continue;
    synced++;
    await store.updateAttemptMirrors(attempt.id, task.status, task.payment_status);
    const run = await store.getRun(attempt.run_id);
    if (!run) continue;

    // Claimed → attempt claimed, run executing, diversity pruning.
    if (task.status === 'claimed' && task.claimed_by_agent_id && attempt.state === 'published') {
      await store.attemptStateGate(attempt.id, ['published'], 'claimed', { agentId: task.claimed_by_agent_id, taskStatus: task.status });
      await store.runResultGate(run.id, ['pending'], 'executing');
      await enforceGroupDiversity(db, env, run.order_id, nowIso);
    }

    // Submitted (or already verified with an unprocessed receipt — e.g. the
    // auto-accept timer beat this sweep) → parse + validate the latest
    // receipt exactly once per receipt.
    if (task.status === 'submitted' || (task.status === 'verified' && !attempt.result_receipt_id)) {
      const receipt = await db.get<{ receipt_id: string; submission_content: string | null; agent_id: string }>(
        'SELECT receipt_id, submission_content, agent_id FROM delivery_receipts WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1',
        task.task_id,
      );
      if (receipt && receipt.receipt_id !== attempt.result_receipt_id) {
        if (attempt.state === 'published') {
          // Claim event may have been missed; catch the mirrors up first.
          await store.attemptStateGate(attempt.id, ['published'], 'claimed', { agentId: task.claimed_by_agent_id, taskStatus: task.status });
        }
        const validation = await validateWorkerSubmission(db, { ...attempt }, run, run.order_id, receipt.submission_content ?? '', nowIso);
        await store.storeAttemptResult({
          attemptId: attempt.id,
          resultJson: validation.valid ? JSON.stringify(validation.result) : (receipt.submission_content ?? null),
          receiptId: receipt.receipt_id,
          valid: validation.valid,
          invalidReason: validation.valid ? null : validation.reason,
          evidenceHashesJson: validation.valid ? JSON.stringify(validation.evidenceHashes) : null,
        });
        await store.runResultGate(run.id, ['pending', 'executing'], validation.valid ? 'evidence_submitted' : 'evidence_invalid');
        await store.orderFulfillmentGate(run.order_id, ['running'], 'reviewing');
        const order = await store.getOrder(run.order_id);
        await queueOperatorNotification(store, env, {
          semanticKey: `op:review:${receipt.receipt_id}`,
          kind: 'submission_awaiting_review',
          orderId: run.order_id,
          subject: validation.valid ? 'Testing submission awaiting review' : 'Testing submission failed automated validation',
          body: `Run ${run.id} on order ${order?.id ?? run.order_id} received a submission (receipt ${receipt.receipt_id}). ` +
            (validation.valid
              ? `Automated triage passed${validation.warnings.length ? ` with warnings: ${validation.warnings.join('; ')}` : ''}. Review it before the marketplace auto-accept deadline.`
              : `Automated triage REJECTED it: ${validation.reason}. Review and choose revision/dispute in the queue.`),
        });
      }
      // Auto-accept deadline alert (~24h ahead), once per task+deadline.
      if (task.auto_release_at) {
        const msLeft = Date.parse(task.auto_release_at) - Date.parse(nowIso);
        if (msLeft > 0 && msLeft < 24 * 3600_000) {
          await queueOperatorNotification(store, env, {
            semanticKey: `op:deadline:${task.task_id}:${task.auto_release_at}`,
            kind: 'approaching_auto_accept',
            orderId: run.order_id,
            subject: 'Marketplace auto-accept approaching on a testing task',
            body: `Task ${task.task_id} (run ${run.id}) auto-accepts at ${task.auto_release_at}. Review the evidence before then; automatic acceptance settles the worker but does NOT validate evidence or publish any report.`,
          });
        }
      }
    }

    // Verified (accepted, by operator action or the 7-day timer).
    if (task.status === 'verified') {
      const wasOperatorReviewed = ['product_success', 'product_failure', 'inconclusive', 'evidence_invalid'].includes(run.result_state);
      await store.attemptStateGate(attempt.id, ['claimed', 'submitted', 'published'], 'accepted', { taskStatus: task.status, paymentStatus: task.payment_status });
      if (!wasOperatorReviewed && task.accepted_by === 'auto') {
        // Auto-acceptance is a marketplace event, not evidence review: raise
        // an urgent reconciliation item (spec §10.5).
        await queueOperatorNotification(store, env, {
          semanticKey: `op:auto-accepted:${task.task_id}`,
          kind: 'auto_accept_unreviewed',
          orderId: run.order_id,
          subject: 'URGENT: managed task auto-accepted without evidence review',
          body: `Task ${task.task_id} (run ${run.id}) reached the 7-day auto-accept while unreviewed. The worker payment obligation stands; the run still needs an operator evidence decision before any report.`,
        });
      }
      // Worker paid out (escrow released) → reservation settled.
      if (attempt.reservation_id && (task.escrow_status === 'released' || task.payment_settled)) {
        await store.reservationGate(attempt.reservation_id, ['committed', 'reserved'], 'settled', { paymentRef: task.escrow_release_tx_hash ?? task.payment_tx_hash ?? null });
      }
    }

    // Cancelled → attempt cancelled; the reservation is released only after
    // the deposit's return is CONFIRMED (escrow refunded), never on timeout.
    if (task.status === 'cancelled') {
      await store.attemptStateGate(attempt.id, ['publishing', 'published', 'claimed', 'submitted'], 'cancelled', { taskStatus: task.status });
      if (attempt.reservation_id) {
        if (task.escrow_status === 'refunded') {
          await store.reservationGate(attempt.reservation_id, ['reserved', 'committed', 'release_pending'], 'released', { paymentRef: task.escrow_refund_tx_hash ?? null });
        } else {
          await store.reservationGate(attempt.reservation_id, ['reserved', 'committed'], 'release_pending');
        }
      }
    }
    // A previously pending refund that has now confirmed.
    if (attempt.reservation_id && task.escrow_status === 'refunded') {
      await store.reservationGate(attempt.reservation_id, ['release_pending'], 'released', { paymentRef: task.escrow_refund_tx_hash ?? null });
    }
  }
  return { synced };
}

/**
 * When an operator group reaches its share of an order's external runs,
 * remove its agents from the allowlists of the order's still-unclaimed
 * managed tasks (the atomic claim gate then refuses them).
 */
async function enforceGroupDiversity(db: DBAdapter, env: unknown, orderId: string, nowIso: string): Promise<void> {
  const store = new TestingStore(db);
  const order = await store.getOrder(orderId);
  if (!order) return;
  const quote = await store.getQuote(order.quote_id);
  if (!quote) return;
  const runs = (await store.listRuns(orderId)).filter((r) => r.kind !== 'baseline');
  const cap = maxRunsPerGroup(quote.external_run_slots, quote.min_operator_groups);

  const groupUse = new Map<string, number>();
  const unclaimed: { run: RunRow; attempt: RunAttemptRow }[] = [];
  for (const run of runs) {
    const attempt = await store.getActiveAttempt(run.id);
    if (!attempt?.task_id) continue;
    if (attempt.agent_id && ['claimed', 'submitted', 'accepted'].includes(attempt.state)) {
      const el = await store.getEligibility(attempt.agent_id);
      const g = el?.operator_group_id ?? `unknown:${attempt.agent_id}`;
      groupUse.set(g, (groupUse.get(g) ?? 0) + 1);
    } else if (attempt.state === 'published') {
      unclaimed.push({ run, attempt });
    }
  }
  const exhausted = [...groupUse.entries()].filter(([, n]) => n >= cap).map(([g]) => g);
  if (exhausted.length === 0 || unclaimed.length === 0) return;
  for (const { run, attempt } of unclaimed) {
    const eligible = await eligibleAgentsForRun(db, run, quote, nowIso);
    await store.setTaskAllowlist(attempt.task_id!, eligible);
  }
}

// ─── operator marketplace actions through the shared gates ───

export type MarketplaceAction = 'accept' | 'revision' | 'dispute' | 'cancel' | 'none';

export async function serviceMarketplaceAction(db: DBAdapter, env: unknown, input: {
  task: TaskRow; action: MarketplaceAction; note: string; nowIso: string;
}): Promise<{ ok: boolean; message: string }> {
  const principal = await servicePrincipal(db, env);
  if (!principal.ok) return { ok: false, message: principal.reason };
  const actor: Actor = { kind: 'agent', agentId: principal.agentId };
  const { task, action, note, nowIso } = input;
  switch (action) {
    case 'none':
      return { ok: true, message: 'no marketplace action' };
    case 'accept': {
      if (task.status === 'verified') return { ok: true, message: 'already accepted' };
      if (task.status !== 'submitted') return { ok: false, message: `task is ${task.status}` };
      const outcome = await acceptEscrowTask(db, env as Bindings, task, { note, actor, nowIso, assertionId: null });
      const body = outcome.body as { ok?: boolean; error?: string; message?: string };
      return outcome.status === 200 && body.ok !== false
        ? { ok: true, message: 'delivery accepted; escrow release started' }
        : { ok: false, message: `accept failed: ${body.error ?? outcome.status} ${body.message ?? ''}`.trim() };
    }
    case 'revision': {
      if (task.status !== 'submitted') return { ok: false, message: `task is ${task.status}` };
      const won = await revisionGate(db, task.task_id, note, nowIso);
      return won ? { ok: true, message: 'revision requested' } : { ok: false, message: 'revision gate lost' };
    }
    case 'dispute': {
      if (task.status !== 'submitted') return { ok: false, message: `task is ${task.status}` };
      if (task.disputed_at) return { ok: true, message: 'already disputed' };
      const won = await disputeGate(db, task.task_id, note, nowIso);
      return won ? { ok: true, message: 'disputed' } : { ok: false, message: 'dispute gate lost' };
    }
    case 'cancel': {
      const refusal = cancelRefusal(task);
      if (refusal) return { ok: false, message: `cannot cancel: ${refusal}` };
      const won = await cancelGate(db, task.task_id, nowIso);
      if (!won) return { ok: false, message: 'cancel gate lost' };
      if (task.escrow && task.escrow_status === 'funded') {
        await startEscrowLeg(db, env as Bindings, task.task_id, 'refund', 'cancel', nowIso);
      }
      return { ok: true, message: 'task cancelled; escrow refund started where applicable' };
    }
  }
}
