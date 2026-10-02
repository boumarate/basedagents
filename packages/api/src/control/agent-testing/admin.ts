/**
 * Agent Testing — operator routes (spec §7.2, §5.2).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * Access model: ownerSession + ADMIN_OWNER_IDS on every route (non-admins get
 * 404 from the server; the console nav is cosmetic). Sensitive mutations —
 * quote approval, task publication, run review, replacements, refunds, report
 * publication, order cancel/resume — additionally require a fresh WebAuthn
 * action assertion whose canonical binds the exact object ids, versions,
 * scope hash and amounts for that one decision.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../types/index.js';
import { ownerSession, verifyAndRecordAction, AssertionSchema } from '../routes.js';
import { isAdminOwner } from '../admin-ids.js';
import { canonicalJsonStringify } from '../../crypto/index.js';
import { loadTask } from '../../tasks/service.js';
import { TestingStore } from './store.js';
import { QuoteScopeSchema, RUN_OUTCOMES, ReportSchema, hashJson, scopeHash as computeScopeHash, sha256hex } from './schemas.js';
import { activePackage, testingEnv } from './catalog.js';
import { createInitialPlan } from './planner.js';
import { approveRunPublication, serviceMarketplaceAction, eligibleAgentsForRun } from './fulfillment.js';
import { generateDraftReport } from './reports.js';
import { queueCustomerNotification } from './notify.js';
import { operatorMetrics } from './metrics.js';
import { reconcileCheckoutAttempt, testingStripeFor } from './checkout.js';

type Ctx = Context<AppEnv>;

const getOwnerId = (c: Ctx) => (c.get as (k: string) => string)('ownerId');
const getStore = (c: Ctx) => new TestingStore(c.get('db'));
const nowIso = () => new Date().toISOString();

function err(c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 422 | 503, error: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, message, request_id: c.req.header('CF-Ray') ?? crypto.randomUUID(), ...extra }, status);
}

async function readJson(c: Ctx): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text.length > 512 * 1024) return { ok: false };
  try {
    return { ok: true, body: text.trim() ? JSON.parse(text) : {} };
  } catch {
    return { ok: false };
  }
}

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdminOwner(c.env, getOwnerId(c))) return c.json({ error: 'not_found', message: 'Not found' }, 404);
  await next();
};

const CeremonyShape = { nonce: z.string().min(1), assertion: AssertionSchema };

/**
 * Run the required action ceremony for an operator mutation. `params` are the
 * server-derived facts the signature must cover; the canonical is rebuilt
 * here exactly as /action/begin builds it, so a signature over different
 * facts fails before anything is consumed.
 */
async function operatorCeremony(
  c: Ctx,
  actionType: string,
  nonce: string,
  assertion: z.infer<typeof AssertionSchema>,
  params: Record<string, unknown>,
): Promise<{ ok: true; assertionId: string } | { ok: false; res: Response }> {
  const ownerId = getOwnerId(c);
  const canonical = canonicalJsonStringify({ action_type: actionType, owner_id: ownerId, nonce, ...params });
  const outcome = await verifyAndRecordAction(c, ownerId, actionType, canonical, assertion);
  if (!outcome.ok) return { ok: false, res: outcome.res };
  return { ok: true, assertionId: outcome.row.id };
}

const app = new Hono<AppEnv>();
app.use('*', ownerSession, requireAdmin);

// ─── queue + reads ───

app.get('/queue', async (c) => {
  const store = getStore(c);
  const now = nowIso();
  const [submitted, needsChanges] = await Promise.all([
    store.listRequestsByStatus('submitted'),
    store.listRequestsByStatus('needs_changes'),
  ]);
  const awaitingPayment = await store.listOrdersByFulfillment(['awaiting_payment']);
  const ready = await store.listOrdersByFulfillment(['ready']);
  const running = await store.listOrdersByFulfillment(['running']);
  const reviewing = await store.listOrdersByFulfillment(['reviewing']);
  const paused = await store.listOrdersByFulfillment(['paused', 'cannot_fulfill']);
  // Completed work must stay reachable — a published order previously fell
  // out of every bucket (field report: "the audit disappeared").
  const delivered = (await store.listOrdersByFulfillment(['delivered'], 25)).reverse();
  const cancelled = (await store.listOrdersByFulfillment(['cancelled'], 25)).reverse();
  const attention = await store.listOperationsByState(['manual_review']);
  const overdue = [...running, ...reviewing].filter((o) => o.cancel_requested_at !== null);
  const shape = (o: { id: string; owner_id: string; payment_state: string; fulfillment_state: string; risk_hold: number; cancel_requested_at: string | null; updated_at: string }) => ({
    id: o.id, payment_state: o.payment_state, fulfillment_state: o.fulfillment_state,
    risk_hold: o.risk_hold === 1, cancel_requested_at: o.cancel_requested_at, updated_at: o.updated_at,
  });
  const pkg = activePackage(c.env);
  return c.json({
    now,
    package: {
      price_cents: pkg.price_cents,
      currency: pkg.currency,
      worker_cap_usdc_atomic: pkg.maximum_worker_commitment_usdc_atomic,
      worker_bounty_usdc_atomic: pkg.worker_bounty_usdc_atomic,
      external_run_slots: pkg.initial_external_run_slots,
      quote_validity_days: pkg.quote_validity_days,
      min_operator_groups: pkg.minimum_distinct_operator_groups,
    },
    intake_review: submitted.map((r) => ({ id: r.id, owner_id: r.owner_id, version: r.version, updated_at: r.updated_at, source: r.source })),
    // Public submissions whose email hasn't signed in yet — demand that is
    // coming but not reviewable until verified (they adopt on sign-in).
    awaiting_email_verification: await store.countPendingInbox(now),
    needs_changes: needsChanges.map((r) => ({ id: r.id, version: r.version, updated_at: r.updated_at })),
    awaiting_payment: awaitingPayment.map(shape),
    awaiting_task_approval: ready.map(shape),
    executing: running.map(shape),
    evidence_review: reviewing.map(shape),
    paused_or_blocked: paused.map(shape),
    cancel_requested: overdue.map(shape),
    delivered: delivered.map(shape),
    cancelled: cancelled.map(shape),
    operations_needing_attention: attention.map((op) => ({ id: op.id, kind: op.kind, order_id: op.order_id, last_error: op.last_error, updated_at: op.updated_at })),
  });
});

app.get('/requests/:id', async (c) => {
  const store = getStore(c);
  const request = await store.getRequest(c.req.param('id'));
  if (!request) return err(c, 404, 'not_found', 'Request not found');
  const quote = await store.getQuoteForRequest(request.id);
  const order = quote ? await store.getOrderByQuote(quote.id) : null;
  return c.json({
    request: { ...request, intake: JSON.parse(request.intake_json) },
    quote: quote ? { ...quote, scope: JSON.parse(quote.scope_json) } : null,
    order_id: order?.id ?? null,
  });
});

app.get('/orders/:id', async (c) => {
  const store = getStore(c);
  const order = await store.getOrder(c.req.param('id'));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  const quote = await store.getQuote(order.quote_id);
  const runs = await store.listRuns(order.id);
  const runsOut = [];
  for (const run of runs) {
    const attempts = await store.listAttempts(run.id);
    runsOut.push({
      ...run,
      environment: JSON.parse(run.environment_json),
      attempts: await Promise.all(attempts.map(async (a) => {
        const task = a.task_id ? await loadTask(c.get('db'), a.task_id) : null;
        return {
          id: a.id, attempt: a.attempt, state: a.state, active: a.active === 1, task_id: a.task_id,
          agent_id: a.agent_id, result_valid: a.result_valid, result_invalid_reason: a.result_invalid_reason,
          result_json: a.result_json, task_status: task?.status ?? a.task_status_mirror,
          payment_status: task?.payment_status ?? a.payment_status_mirror,
          auto_release_at: task?.auto_release_at ?? null, last_error: a.last_error,
        };
      })),
    });
  }
  const reservations = await store.listReservations(order.id);
  const reports = await store.listReports(order.id);
  const checkoutAttempts = await store.listCheckoutAttempts(order.id);
  const operations = await store.listOperationsByOrder(order.id);
  const remaining = quote ? String(await store.remainingBudget(order.id, quote.worker_cap_usdc_atomic)) : null;
  return c.json({
    order,
    quote: quote ? { ...quote, scope: JSON.parse(quote.scope_json) } : null,
    runs: runsOut,
    reservations,
    remaining_budget_atomic: remaining,
    reports: reports.map((r) => ({ id: r.id, version: r.version, status: r.status, published_at: r.published_at })),
    checkout_attempts: checkoutAttempts,
    operations,
  });
});

// ─── intake decisions (bookkeeping: session + admin) ───

const NoteBody = z.object({ note: z.string().min(1).max(2000) }).strict();

app.post('/requests/:id/needs-changes', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = NoteBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'a note is required');
  const store = getStore(c);
  if (!(await store.setRequestDecision(c.req.param('id'), 'needs_changes', body.data.note))) {
    return err(c, 409, 'invalid_state', 'Only a submitted request can be sent back for changes');
  }
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'request_needs_changes', objectKind: 'request', objectId: c.req.param('id'), reason: body.data.note.slice(0, 300) });
  return c.json({ ok: true });
});

app.post('/requests/:id/decline', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = NoteBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'a note is required');
  const store = getStore(c);
  if (!(await store.setRequestDecision(c.req.param('id'), 'declined', body.data.note))) {
    return err(c, 409, 'invalid_state', 'Only a submitted request can be declined');
  }
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'request_declined', objectKind: 'request', objectId: c.req.param('id'), reason: body.data.note.slice(0, 300) });
  return c.json({ ok: true });
});

/** Tag founder/test work so it never counts as external demand (spec §6.2). */
app.post('/requests/:id/source', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = z.object({ source: z.enum(['external_customer', 'founder_sample', 'test_fixture']) }).strict().safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'source invalid');
  const store = getStore(c);
  if (!(await store.setRequestSource(c.req.param('id'), body.data.source))) return err(c, 404, 'not_found', 'Request not found');
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'request_source_set', objectKind: 'request', objectId: c.req.param('id'), reason: body.data.source });
  return c.json({ ok: true });
});

// ─── quote approval (ceremony: binds request version, scope hash, price, cap, target) ───

const ApproveQuoteBody = z.object({
  request_version: z.number().int().min(1),
  scope: QuoteScopeSchema,
  delivery_target_at: z.string().datetime({ offset: true }),
  checklist_confirmed: z.literal(true), // spec §9.1 — the operator affirms the scope checklist
  ...CeremonyShape,
}).strict();

app.post('/requests/:id/approve-quote', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = ApproveQuoteBody.safeParse(json.body);
  if (!body.success) {
    const first = body.error.issues[0];
    return err(c, 422, 'validation_failed', `Invalid at ${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'}`);
  }
  const store = getStore(c);
  const request = await store.getRequest(c.req.param('id'));
  if (!request) return err(c, 404, 'not_found', 'Request not found');
  if (request.status !== 'submitted' || request.version !== body.data.request_version) {
    return err(c, 409, 'version_conflict', `Request is ${request.status} at version ${request.version}`);
  }
  const intake = JSON.parse(request.intake_json) as { product_category: string; auth_mode: string };
  if (intake.product_category === 'other') {
    return err(c, 409, 'invalid_state', 'Category "other" is not eligible for the standard package; adjust scope with the customer first.');
  }
  if (!['none', 'worker_owned_test_account'].includes(intake.auth_mode)) {
    return err(c, 409, 'invalid_state', 'Unsupported authentication mode; adjust scope before quoting.');
  }
  const pkg = activePackage(c.env);
  const hash = computeScopeHash(body.data.scope);
  const deliveryTarget = body.data.delivery_target_at;
  if (Date.parse(deliveryTarget) <= Date.now()) return err(c, 422, 'validation_failed', 'delivery_target_at must be in the future');

  const ceremony = await operatorCeremony(c, 'testing.approve_quote', body.data.nonce, body.data.assertion, {
    request_id: request.id,
    request_version: request.version,
    scope_hash: hash,
    subtotal_cents: pkg.price_cents,
    worker_cap_usdc_atomic: pkg.maximum_worker_commitment_usdc_atomic,
    delivery_target_at: deliveryTarget,
  });
  if (!ceremony.ok) return ceremony.res;

  const expiresAt = new Date(Date.now() + pkg.quote_validity_days * 86_400_000).toISOString();
  const quote = await store.approveQuote({
    requestId: request.id,
    requestVersion: request.version,
    scopeJson: JSON.stringify(body.data.scope),
    scopeHash: hash,
    packageKey: pkg.package_key,
    packageVersion: pkg.package_version,
    stripePriceId: testingEnv(c.env).STRIPE_PRICE_TESTING_AUDIT ?? null,
    subtotalCents: pkg.price_cents,
    currency: pkg.currency,
    taxMode: testingEnv(c.env).TESTING_TAX_MODE === 'stripe_tax' ? 'stripe_tax' : 'none',
    workerCapAtomic: pkg.maximum_worker_commitment_usdc_atomic,
    workerBountyAtomic: pkg.worker_bounty_usdc_atomic,
    externalRunSlots: pkg.initial_external_run_slots,
    retestSlots: pkg.included_targeted_retest_slots,
    retestWindowDays: pkg.retest_request_window_days,
    minOperatorGroups: pkg.minimum_distinct_operator_groups,
    termsVersion: pkg.terms_version,
    disclosureVersion: pkg.disclosure_version,
    deliveryTargetAt: deliveryTarget,
    expiresAt,
    approvedBy: getOwnerId(c),
    assertionId: ceremony.assertionId,
  });
  if (!quote) return err(c, 409, 'version_conflict', 'The request changed while approving');
  await store.metricEvent('quote_approved', { requestId: request.id });
  await store.audit({
    actor: `operator:${getOwnerId(c)}`, action: 'quote_approved', objectKind: 'quote', objectId: quote.id,
    detailHash: hash, assertionId: ceremony.assertionId, reason: `subtotal ${pkg.price_cents}c, cap ${pkg.maximum_worker_commitment_usdc_atomic}`,
  });
  await queueCustomerNotification(c.get('db'), store, c.env, {
    semanticKey: `cust:quote:${quote.id}`,
    kind: 'quote_ready',
    orderId: null,
    ownerId: request.owner_id,
    subject: 'Your audit scope is ready to review',
    body: 'We confirmed coverage for your requested audit. Review the exact scope, delivery target and price, then pay to start. No payment has been taken.',
    path: `/testing/requests/${request.id}`,
  });
  return c.json({ quote: { ...quote, scope: JSON.parse(quote.scope_json) } });
});

// ─── plan + publication ───

app.post('/orders/:id/plan', async (c) => {
  const store = getStore(c);
  const order = await store.getOrder(c.req.param('id'));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  if (order.payment_state !== 'succeeded') return err(c, 409, 'payment_not_confirmed', 'The order is not paid');
  const result = await createInitialPlan(c.get('db'), order.id);
  return c.json({ runs: result.runs, earmark_reserved: result.earmarkReserved });
});

const PublishBody = z.object({ run_ids: z.array(z.string().min(1)).min(1).max(10), ...CeremonyShape }).strict();

app.post('/orders/:id/publish-tasks', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = PublishBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'run_ids plus the action ceremony are required');
  const store = getStore(c);
  const order = await store.getOrder(c.req.param('id'));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  const quote = await store.getQuote(order.quote_id);
  if (!quote) return err(c, 404, 'not_found', 'Quote not found');
  const runIds = [...body.data.run_ids].sort();
  const totalCommitment = String(BigInt(quote.worker_bounty_usdc_atomic) * BigInt(runIds.length));

  const ceremony = await operatorCeremony(c, 'testing.publish_tasks', body.data.nonce, body.data.assertion, {
    order_id: order.id,
    run_ids: runIds,
    scope_hash: quote.scope_hash,
    bounty_usdc_atomic: quote.worker_bounty_usdc_atomic,
    total_commitment_usdc_atomic: totalCommitment,
    worker_cap_usdc_atomic: quote.worker_cap_usdc_atomic,
  });
  if (!ceremony.ok) return ceremony.res;

  const result = await approveRunPublication(c.get('db'), c.env, {
    order, quote, runIds, actor: `operator:${getOwnerId(c)}`, assertionId: ceremony.assertionId,
  });
  if (!result.ok) return err(c, result.error === 'budget_exceeded' ? 409 : 409, result.error, result.message);
  return c.json({ ok: true, operations: result.operations, note: 'Publication runs as durable operations; check the order view for task ids.' });
});

/** Preview eligible worker pool for a run (no side effects). */
app.get('/runs/:id/eligibility-preview', async (c) => {
  const store = getStore(c);
  const run = await store.getRun(c.req.param('id'));
  if (!run) return err(c, 404, 'not_found', 'Run not found');
  const order = await store.getOrder(run.order_id);
  const quote = order ? await store.getQuote(order.quote_id) : null;
  if (!quote) return err(c, 404, 'not_found', 'Quote not found');
  const agents = await eligibleAgentsForRun(c.get('db'), run, quote, nowIso());
  return c.json({ run_id: run.id, eligible_agent_count: agents.length, eligible_agent_ids: agents });
});

// ─── pause / resume / cancel ───

app.post('/orders/:id/pause', async (c) => {
  const store = getStore(c);
  if (!(await store.pauseOrder(c.req.param('id')))) return err(c, 409, 'invalid_state', 'Order cannot be paused from its current state');
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'order_paused', objectKind: 'order', objectId: c.req.param('id') });
  return c.json({ ok: true });
});

const ResumeBody = z.object({ ...CeremonyShape }).strict();

app.post('/orders/:id/resume', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = ResumeBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'the action ceremony is required');
  const store = getStore(c);
  const order = await store.getOrder(c.req.param('id'));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  const ceremony = await operatorCeremony(c, 'testing.resume_order', body.data.nonce, body.data.assertion, { order_id: order.id });
  if (!ceremony.ok) return ceremony.res;
  if (!(await store.resumeOrder(order.id))) return err(c, 409, 'invalid_state', 'Order is not paused');
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'order_resumed', objectKind: 'order', objectId: order.id, assertionId: ceremony.assertionId });
  return c.json({ ok: true });
});

const CancelBody = z.object({ reason: z.string().min(1).max(2000), ...CeremonyShape }).strict();

app.post('/orders/:id/cancel', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = CancelBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'a reason plus the action ceremony are required');
  const store = getStore(c);
  const order = await store.getOrder(c.req.param('id'));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  const ceremony = await operatorCeremony(c, 'testing.cancel_order', body.data.nonce, body.data.assertion, {
    order_id: order.id, reason_hash: sha256hex(body.data.reason),
  });
  if (!ceremony.ok) return ceremony.res;

  // Cancel unclaimed managed tasks through the normal lifecycle; claimed or
  // submitted work is resolved explicitly per run (spec §8.7). Earned worker
  // obligations are never erased here.
  const runs = await store.listRuns(order.id);
  const skipped: string[] = [];
  for (const run of runs) {
    const attempt = await store.getActiveAttempt(run.id);
    if (!attempt?.task_id) continue;
    const task = await loadTask(c.get('db'), attempt.task_id);
    if (!task) continue;
    if (task.status === 'open') {
      const out = await serviceMarketplaceAction(c.get('db'), c.env, { task, action: 'cancel', note: body.data.reason, nowIso: nowIso() });
      if (!out.ok) skipped.push(`${attempt.task_id}: ${out.message}`);
    } else if (['claimed', 'submitted'].includes(task.status)) {
      skipped.push(`${attempt.task_id}: ${task.status} — resolve via run review first`);
    }
  }
  await store.orderFulfillmentGate(order.id, ['awaiting_payment', 'needs_inputs', 'ready', 'running', 'reviewing', 'paused'], 'cancelled');
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'order_cancelled', objectKind: 'order', objectId: order.id, reason: body.data.reason.slice(0, 300), assertionId: ceremony.assertionId });
  await queueCustomerNotification(c.get('db'), store, c.env, {
    semanticKey: `cust:cancelled:${order.id}`,
    kind: 'cancellation_update',
    orderId: order.id,
    ownerId: order.owner_id,
    subject: 'Your audit order was cancelled',
    body: 'Your audit order was cancelled by our team. If a refund applies it is processed separately and you will get a confirmation.',
  });
  return c.json({ ok: true, unresolved_tasks: skipped });
});

// ─── refunds (ceremony binds amount + reason; executed as a durable operation) ───

const RefundBody = z.object({ amount_cents: z.number().int().min(1), reason: z.string().min(1).max(2000), ...CeremonyShape }).strict();

app.post('/orders/:id/refund', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = RefundBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'amount_cents, reason and the action ceremony are required');
  const store = getStore(c);
  const order = await store.getOrder(c.req.param('id'));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  if (order.payment_state !== 'succeeded') return err(c, 409, 'payment_not_confirmed', 'Only a paid order can be refunded');
  if (body.data.amount_cents > order.collected_cents - order.refunded_cents) {
    return err(c, 409, 'invalid_state', 'Refund exceeds the remaining collected amount');
  }
  const attempts = await store.listCheckoutAttempts(order.id);
  const completed = attempts.find((a) => a.state === 'completed' && a.stripe_payment_intent_id);
  if (!completed?.stripe_payment_intent_id) return err(c, 409, 'operation_needs_reconciliation', 'No settled payment intent found for this order');

  const ceremony = await operatorCeremony(c, 'testing.refund_order', body.data.nonce, body.data.assertion, {
    order_id: order.id, amount_cents: body.data.amount_cents, reason_hash: sha256hex(body.data.reason),
  });
  if (!ceremony.ok) return ceremony.res;

  const op = await store.enqueueOperation({
    kind: 'stripe_refund',
    semanticKey: `refund:${order.id}:${body.data.nonce}`,
    orderId: order.id,
    payloadJson: JSON.stringify({
      order_id: order.id,
      payment_intent_id: completed.stripe_payment_intent_id,
      amount_cents: body.data.amount_cents,
      reason: body.data.reason,
    }),
  });
  await store.setOrderRefundFacts(order.id, 'pending', order.refunded_cents);
  await store.audit({
    actor: `operator:${getOwnerId(c)}`, action: 'refund_requested', objectKind: 'order', objectId: order.id,
    reason: `${body.data.amount_cents}c: ${body.data.reason.slice(0, 200)}`, assertionId: ceremony.assertionId,
  });
  return c.json({ ok: true, operation_id: op.id, note: 'Refund runs as a durable operation; the webhook confirms the final state.' });
});

app.post('/orders/:id/reconcile', async (c) => {
  const store = getStore(c);
  const order = await store.getOrder(c.req.param('id'));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  const stripe = testingStripeFor(c);
  if (!stripe) return err(c, 503, 'billing_unavailable', 'Stripe is not configured');
  const attempts = await store.listCheckoutAttempts(order.id);
  for (const attempt of attempts) {
    if (['creating', 'open', 'needs_reconciliation'].includes(attempt.state)) {
      try {
        await reconcileCheckoutAttempt(store, stripe, attempt);
      } catch (e) {
        await store.markCheckoutNeedsReconciliation(attempt.id, e instanceof Error ? e.message : String(e));
      }
    }
  }
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'order_reconciled', objectKind: 'order', objectId: order.id });
  return c.json({ ok: true, checkout_attempts: await store.listCheckoutAttempts(order.id) });
});

// ─── run review (ceremony binds run version, evidence decision, outcome, marketplace action) ───

const ReviewBody = z.object({
  expected_version: z.number().int().min(1),
  evidence: z.enum(['valid', 'needs_revision', 'invalid']),
  outcome: z.enum(RUN_OUTCOMES).nullable(),
  environment_demonstrated: z.boolean().nullable(),
  slot_satisfied: z.boolean().nullable(),
  operator_group_id: z.string().max(120).nullable().optional(),
  marketplace_action: z.enum(['accept', 'revision', 'dispute', 'cancel', 'none']),
  note: z.string().min(1).max(4000),
  baseline_result_json: z.string().max(65536).optional(),
  ...CeremonyShape,
}).strict();

app.post('/runs/:id/review', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = ReviewBody.safeParse(json.body);
  if (!body.success) {
    const first = body.error.issues[0];
    return err(c, 422, 'validation_failed', `Invalid at ${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'}`);
  }
  const store = getStore(c);
  const run = await store.getRun(c.req.param('id'));
  if (!run) return err(c, 404, 'not_found', 'Run not found');
  if (run.version !== body.data.expected_version) {
    return err(c, 409, 'version_conflict', `Run is at version ${run.version}`);
  }
  if (body.data.evidence === 'valid' && !body.data.outcome) {
    return err(c, 422, 'validation_failed', 'A valid-evidence review must state the product outcome');
  }

  const ceremony = await operatorCeremony(c, 'testing.review_run', body.data.nonce, body.data.assertion, {
    run_id: run.id,
    run_version: run.version,
    evidence: body.data.evidence,
    outcome: body.data.outcome,
    marketplace_action: body.data.marketplace_action,
    note_hash: sha256hex(body.data.note),
  });
  if (!ceremony.ok) return ceremony.res;

  // Resulting run state: outcome for valid evidence; evidence_invalid for
  // invalid; unchanged-executing for needs_revision (worker will resubmit).
  const resultState = body.data.evidence === 'valid'
    ? body.data.outcome!
    : body.data.evidence === 'invalid'
      ? 'evidence_invalid'
      : 'executing';

  const reviewed = await store.reviewRun({
    runId: run.id,
    expectedVersion: run.version,
    resultState,
    reviewedResultJson: JSON.stringify({
      evidence: body.data.evidence,
      outcome: body.data.outcome,
      note: body.data.note,
      baseline_result: run.kind === 'baseline' && body.data.baseline_result_json ? JSON.parse(body.data.baseline_result_json) : undefined,
      reviewed_at: nowIso(),
    }),
    environmentDemonstrated: body.data.environment_demonstrated,
    slotSatisfied: body.data.slot_satisfied,
    operatorGroupId: body.data.operator_group_id ?? null,
    environmentObservedJson: null,
    reviewedBy: getOwnerId(c),
    assertionId: ceremony.assertionId,
  });
  if (!reviewed) return err(c, 409, 'version_conflict', 'Run changed while reviewing');

  // The marketplace consequence goes through the normal lifecycle gates as
  // the service principal — never a direct status write from here.
  let marketplace: { ok: boolean; message: string } = { ok: true, message: 'no marketplace action' };
  const attempt = await store.getActiveAttempt(run.id);
  if (body.data.marketplace_action !== 'none' && run.kind !== 'baseline') {
    if (!attempt?.task_id) {
      marketplace = { ok: false, message: 'run has no active marketplace task' };
    } else {
      const task = await loadTask(c.get('db'), attempt.task_id);
      marketplace = task
        ? await serviceMarketplaceAction(c.get('db'), c.env, { task, action: body.data.marketplace_action, note: body.data.note, nowIso: nowIso() })
        : { ok: false, message: 'task not found' };
      if (marketplace.ok && body.data.marketplace_action === 'accept') {
        await store.attemptStateGate(attempt.id, ['submitted', 'claimed'], 'accepted');
      }
      if (marketplace.ok && body.data.evidence === 'invalid' && ['dispute', 'cancel'].includes(body.data.marketplace_action)) {
        await store.retireAttempt(attempt.id, 'invalid', body.data.note.slice(0, 300));
      }
    }
  }
  if (body.data.evidence === 'valid' && body.data.outcome) {
    await store.metricEvent('initial_run_validated', { orderId: run.order_id });
  }
  await store.audit({
    actor: `operator:${getOwnerId(c)}`, action: 'run_reviewed', objectKind: 'run', objectId: run.id,
    beforeVersion: body.data.expected_version, afterVersion: body.data.expected_version + 1,
    reason: `${body.data.evidence}/${body.data.outcome ?? '-'} → ${body.data.marketplace_action}`, assertionId: ceremony.assertionId,
  });
  return c.json({ ok: true, run: await store.getRun(run.id), marketplace });
});

// ─── replacement attempts (ceremony; only after the old attempt is resolved) ───

const ReplaceBody = z.object({ reason: z.string().min(1).max(2000), ...CeremonyShape }).strict();

app.post('/runs/:id/replace-attempt', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = ReplaceBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'a reason plus the action ceremony are required');
  const store = getStore(c);
  const run = await store.getRun(c.req.param('id'));
  if (!run) return err(c, 404, 'not_found', 'Run not found');
  const order = await store.getOrder(run.order_id);
  const quote = order ? await store.getQuote(order.quote_id) : null;
  if (!order || !quote) return err(c, 404, 'not_found', 'Order not found');

  // A valid product failure consumed its slot — replacements are only for
  // documented invalid/unavailable attempts (spec §10.6).
  if (['product_success', 'product_failure'].includes(run.result_state)) {
    return err(c, 409, 'invalid_state', 'This run has a valid outcome; a replacement would be paying for reruns.');
  }
  const active = await store.getActiveAttempt(run.id);
  if (active) {
    const task = active.task_id ? await loadTask(c.get('db'), active.task_id) : null;
    const resolved = !task || task.status === 'cancelled' || active.state === 'invalid';
    if (!resolved) {
      return err(c, 409, 'invalid_state', 'Resolve the current attempt first (cancel or invalidate it through review).');
    }
    await store.retireAttempt(active.id, active.state === 'invalid' ? 'replaced' : 'replaced', body.data.reason.slice(0, 300));
  }

  const ceremony = await operatorCeremony(c, 'testing.replace_attempt', body.data.nonce, body.data.assertion, {
    run_id: run.id, order_id: order.id, bounty_usdc_atomic: quote.worker_bounty_usdc_atomic, reason_hash: sha256hex(body.data.reason),
  });
  if (!ceremony.ok) return ceremony.res;

  const result = await approveRunPublication(c.get('db'), c.env, {
    order, quote, runIds: [run.id], actor: `operator:${getOwnerId(c)}`, assertionId: ceremony.assertionId,
  });
  if (!result.ok) return err(c, 409, result.error, result.message);
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'attempt_replaced', objectKind: 'run', objectId: run.id, reason: body.data.reason.slice(0, 300), assertionId: ceremony.assertionId });
  return c.json({ ok: true, operations: result.operations });
});

// ─── reports ───

app.post('/orders/:id/report-draft', async (c) => {
  const store = getStore(c);
  const order = await store.getOrder(c.req.param('id'));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  const draft = await generateDraftReport(c.get('db'), order.id, nowIso());
  return c.json({ report: { ...draft, document: JSON.parse(draft.report_json) } });
});

const DraftEditBody = z.object({ document: z.unknown() }).strict();

app.patch('/reports/:id', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = DraftEditBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'document required');
  const parsed = ReportSchema.safeParse(body.data.document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return err(c, 422, 'validation_failed', `Report invalid at ${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'}`);
  }
  const store = getStore(c);
  const row = await store.getReport(c.req.param('id'));
  if (!row) return err(c, 404, 'not_found', 'Report not found');
  if (parsed.data.report_id !== row.id || parsed.data.order_id !== row.order_id || parsed.data.version !== row.version) {
    return err(c, 409, 'invalid_state', 'The document identity fields must match the draft row');
  }
  const sourceHash = hashJson(parsed.data);
  if (!(await store.updateDraftReport(row.id, JSON.stringify(parsed.data), sourceHash))) {
    return err(c, 409, 'invalid_state', 'Only a draft report can be edited — published versions are immutable');
  }
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'report_draft_edited', objectKind: 'report', objectId: row.id, detailHash: sourceHash });
  return c.json({ ok: true });
});

const PublishReportBody = z.object({ source_hash: z.string().min(1), ...CeremonyShape }).strict();

app.post('/reports/:id/publish', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = PublishReportBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'source_hash plus the action ceremony are required');
  const store = getStore(c);
  const row = await store.getReport(c.req.param('id'));
  if (!row) return err(c, 404, 'not_found', 'Report not found');
  if (row.status !== 'draft') return err(c, 409, 'invalid_state', 'Already published');
  if (row.source_hash !== body.data.source_hash) {
    return err(c, 409, 'version_conflict', 'The draft changed since you reviewed it');
  }
  const order = await store.getOrder(row.order_id);
  if (!order) return err(c, 404, 'not_found', 'Order not found');

  const ceremony = await operatorCeremony(c, 'testing.publish_report', body.data.nonce, body.data.assertion, {
    report_id: row.id, order_id: row.order_id, report_version: row.version, source_hash: row.source_hash,
  });
  if (!ceremony.ok) return ceremony.res;

  if (!(await store.publishReport(row.id, getOwnerId(c), ceremony.assertionId))) {
    return err(c, 409, 'invalid_state', 'Report was published concurrently');
  }
  const published = (await store.getReport(row.id))!;
  // Stamp version history publication time into the immutable document copy.
  const doc = JSON.parse(published.report_json) as { version_history?: Array<{ version: number; published_at: string | null }> };
  if (doc.version_history) {
    for (const v of doc.version_history) if (v.version === row.version) v.published_at = published.published_at;
    await c.get('db').run('UPDATE testing_reports SET report_json = ? WHERE id = ? AND status = ?', JSON.stringify(doc), row.id, 'published');
  }
  if (row.version === 1) {
    const quote = await store.getQuote(order.quote_id);
    const windowDays = quote?.retest_window_days ?? 14;
    const deadline = new Date(Date.parse(published.published_at!) + windowDays * 86_400_000).toISOString();
    await store.setInitialReport(order.id, row.id, published.published_at!, deadline);
  }
  await store.orderFulfillmentGate(order.id, ['running', 'reviewing', 'ready'], 'delivered');
  await store.metricEvent('report_published', { orderId: order.id });
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'report_published', objectKind: 'report', objectId: row.id, assertionId: ceremony.assertionId });
  await queueCustomerNotification(c.get('db'), store, c.env, {
    semanticKey: `cust:report:${row.id}`,
    kind: 'report_ready',
    orderId: order.id,
    ownerId: order.owner_id,
    subject: 'Your agent compatibility report is ready',
    body: 'Your private report is published. Sign in to read it, export Markdown/JSON, and request your included targeted retest if you want one.',
  });
  return c.json({ ok: true, report_id: row.id, version: row.version, published_at: published.published_at });
});

// ─── worker eligibility (audited; operator-only) ───

const EligibilityBody = z.object({
  operator_group_id: z.string().min(1).max(120),
  group_confidence: z.enum(['unverified', 'declared', 'operator_reviewed']).default('declared'),
  capabilities: z.array(z.string().max(120)).max(20),
  environments: z.array(z.object({
    client: z.string().min(1).max(120),
    transport: z.string().min(1).max(120),
    fingerprint: z.string().max(64).optional(),
  })).min(1).max(20),
  evidence_refs: z.array(z.string().max(300)).max(20).default([]),
  provenance: z.enum(['self_reported', 'operator_reviewed']),
  status: z.enum(['approved', 'suspended', 'revoked']),
  expires_at: z.string().datetime({ offset: true }).nullable().default(null),
  notes: z.string().max(2000).default(''),
}).strict();

app.post('/workers/:agentId/eligibility', async (c) => {
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = EligibilityBody.safeParse(json.body);
  if (!body.success) {
    const first = body.error.issues[0];
    return err(c, 422, 'validation_failed', `Invalid at ${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'}`);
  }
  const agentId = c.req.param('agentId');
  const agent = await c.get('db').get<{ id: string }>('SELECT id FROM agents WHERE id = ?', agentId);
  if (!agent) return err(c, 404, 'not_found', 'Agent not found');
  const store = getStore(c);
  await store.upsertEligibility({
    agentId,
    operatorGroupId: body.data.operator_group_id,
    groupConfidence: body.data.group_confidence,
    capabilitiesJson: JSON.stringify(body.data.capabilities),
    environmentsJson: JSON.stringify(body.data.environments),
    evidenceRefsJson: JSON.stringify(body.data.evidence_refs),
    provenance: body.data.provenance,
    status: body.data.status,
    reviewedBy: getOwnerId(c),
    expiresAt: body.data.expires_at,
    notes: body.data.notes || null,
  });
  await store.audit({ actor: `operator:${getOwnerId(c)}`, action: 'eligibility_upserted', objectKind: 'worker', objectId: agentId, reason: `${body.data.status}/${body.data.provenance}` });
  return c.json({ ok: true, eligibility: await store.getEligibility(agentId) });
});

app.get('/workers', async (c) => {
  return c.json({ workers: await getStore(c).listEligibility() });
});

// ─── metrics ───

app.get('/metrics', async (c) => {
  return c.json(await operatorMetrics(c.get('db')));
});

export const testingAdminRoutes = app;
