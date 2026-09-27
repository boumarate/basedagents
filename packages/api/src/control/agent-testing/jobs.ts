/**
 * Agent Testing — durable jobs (spec §15).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * Every job claims work under a lease with finite retries and a
 * manual-review dead-letter state (store.ts). The checkout/fulfillment kill
 * switches (flags) pause NEW commitments only — reconciliation, refunds,
 * notification delivery and state sync below always run, so a paused rollout
 * can still heal itself. No database transaction is held across a Stripe or
 * settlement call: intent is persisted first, external calls run through
 * recoverable operations, outcomes reconcile afterward.
 */
import type { DBAdapter } from '../../db/adapter.js';
import type { EmailSender } from '../email.js';
import { TestingStore, type OperationRow } from './store.js';
import { drainTestingInbox } from './stripe-events.js';
import { type TestingStripe, reconcileCheckoutAttempt } from './checkout.js';
import { createInitialPlan } from './planner.js';
import { executePublishOperation, syncManagedTasks } from './fulfillment.js';
import { sendDueNotifications, queueOperatorNotification } from './notify.js';
import { retentionDays } from './catalog.js';

export interface TestingJobDeps {
  stripe: TestingStripe | null;
  emailSender: EmailSender;
  env: unknown;
}

export interface TestingJobSummary {
  inbox: { processed: number; failed: number };
  operations: { succeeded: number; failed: number };
  sync: { synced: number };
  notifications: { sent: number; failed: number };
  quotes_expired: number;
  drafts_deleted: number;
  evidence_redacted: number;
  intake_inbox_expired: number;
}

export async function runTestingJobs(db: DBAdapter, deps: TestingJobDeps, nowIso: string): Promise<TestingJobSummary> {
  const store = new TestingStore(db);

  // 1. Stripe inbox (verified events → financial facts).
  const inbox = await drainTestingInbox(db, { stripe: deps.stripe, env: deps.env }, nowIso);

  // 2. Durable operations.
  const operations = { succeeded: 0, failed: 0 };
  for (const op of await store.operationsDue(nowIso)) {
    if (!(await store.operationClaim(op.id, nowIso))) continue;
    try {
      await executeOperation(db, deps, op);
      await store.operationSucceeded(op.id, null);
      operations.succeeded++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      operations.failed++;
      // Configuration gaps wait for an operator instead of burning retries.
      const manual = message.startsWith('funding_unavailable') || message.includes('not configured') || message.includes('no eligible workers');
      await store.operationFailed(op.id, message, { manual });
    }
  }

  // 3. Marketplace mirror + evidence intake + deadline alerts.
  const sync = await syncManagedTasks(db, deps.env, nowIso);

  // 4. Delivery-target alerts (overdue orders still in flight).
  await alertOverdueOrders(db, deps.env, nowIso);

  // 5. Stale checkout attempts → reconcile against Stripe.
  await reconcileStaleCheckouts(db, deps, nowIso);

  // 6. Notifications.
  const notifications = await sendDueNotifications(db, deps.emailSender, nowIso);

  // 7. Expiry + retention.
  const quotesExpired = await store.expireQuotes(nowIso);
  const retain = retentionDays(deps.env);
  const draftCutoff = new Date(Date.parse(nowIso) - retain.drafts * 86_400_000).toISOString();
  const draftsDeleted = await store.deleteStaleDrafts(draftCutoff);
  const evidenceCutoff = new Date(Date.parse(nowIso) - retain.evidence * 86_400_000).toISOString();
  const evidenceRedacted = await store.redactExpiredEvidence(evidenceCutoff);

  const intakeInboxExpired = await store.expireInboxRows(nowIso);

  return { inbox, operations, sync, notifications, quotes_expired: quotesExpired, drafts_deleted: draftsDeleted, evidence_redacted: evidenceRedacted, intake_inbox_expired: intakeInboxExpired };
}

async function executeOperation(db: DBAdapter, deps: TestingJobDeps, op: OperationRow): Promise<void> {
  const store = new TestingStore(db);
  switch (op.kind) {
    case 'create_plan': {
      const payload = JSON.parse(op.payload_json) as { order_id: string };
      await createInitialPlan(db, payload.order_id);
      return;
    }
    case 'publish_task':
      await executePublishOperation(db, deps.env, op);
      return;
    case 'stripe_refund': {
      if (!deps.stripe) throw new Error('stripe not configured');
      const payload = JSON.parse(op.payload_json) as { order_id: string; payment_intent_id: string; amount_cents: number; reason: string };
      // Provider idempotency key = the operation's semantic key: a lost
      // response retried under the same key cannot double-refund.
      const refund = await deps.stripe.createRefund(
        { paymentIntentId: payload.payment_intent_id, amountCents: payload.amount_cents, reason: payload.reason },
        op.semantic_key,
      );
      // A requested refund is not automatically completed: pending/succeeded/
      // failed are reconciled by the refund webhook events; here we only
      // record the request outcome we saw.
      if (refund.status === 'failed' || refund.status === 'canceled') {
        const order = await store.getOrder(payload.order_id);
        if (order) await store.setOrderRefundFacts(order.id, 'failed', order.refunded_cents);
        throw new Error(`refund ${refund.id} ${refund.status}`);
      }
      return;
    }
    case 'retest_request':
      // A durable record of the customer's request; the operator acts on it
      // through publish-tasks. Nothing to execute.
      return;
    default:
      throw new Error(`unknown operation kind ${op.kind}`);
  }
}

async function alertOverdueOrders(db: DBAdapter, env: unknown, nowIso: string): Promise<void> {
  const store = new TestingStore(db);
  const inFlight = await store.listOrdersByFulfillment(['ready', 'running', 'reviewing']);
  for (const order of inFlight) {
    const quote = await store.getQuote(order.quote_id);
    if (!quote || quote.delivery_target_at > nowIso) continue;
    await queueOperatorNotification(store, env, {
      semanticKey: `op:overdue:${order.id}:${quote.delivery_target_at}`,
      kind: 'overdue_delivery_target',
      orderId: order.id,
      subject: 'Testing order past its delivery target',
      body: `Order ${order.id} passed its delivery target (${quote.delivery_target_at}) in state ${order.fulfillment_state}. Contact the customer or adjust the plan.`,
    });
  }
}

async function reconcileStaleCheckouts(db: DBAdapter, deps: TestingJobDeps, nowIso: string): Promise<void> {
  if (!deps.stripe) return;
  const store = new TestingStore(db);
  const staleBefore = new Date(Date.parse(nowIso) - 60 * 60_000).toISOString();
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM testing_checkout_attempts WHERE state IN ('creating','needs_reconciliation') AND updated_at < ? LIMIT 20`,
    staleBefore,
  );
  for (const row of rows) {
    const attempt = await store.getCheckoutAttempt(row.id);
    if (!attempt) continue;
    try {
      if (attempt.stripe_session_id) {
        await reconcileCheckoutAttempt(store, deps.stripe, attempt);
      } else if (attempt.state === 'creating') {
        // No session was ever stored and the operation key would have been
        // reused by any retry — after an hour this attempt is dead.
        await store.failCheckoutAttempt(attempt.id, 'stale: no session created', ['creating']);
      }
    } catch {
      // stays stale; next cron pass retries
    }
  }
}
