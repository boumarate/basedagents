/**
 * Agent Testing — product-aware Stripe event handling (spec §8.4–§8.7).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * The central webhook verifies the signature, then asks {@link isTestingStripeEvent}
 * whether the event belongs to this product. Testing events are stored in the
 * durable inbox BEFORE the webhook acknowledges, then processed under a lease
 * (crash → lease expires → retried; never permanently suppressed by an event-id
 * claim). Keyring subscription events never reach this module, and nothing in
 * this module touches owners.plan or Keyring entitlements.
 *
 * Financial facts are validated against CANONICAL objects re-fetched from
 * Stripe — metadata is only the association hint.
 */
import type { DBAdapter } from '../../db/adapter.js';
import { TestingStore, type InboxRow } from './store.js';
import { TESTING_PRODUCT_FAMILY, type TestingStripe } from './checkout.js';
import { testingEnv } from './catalog.js';
import { queueCustomerNotification, queueOperatorNotification } from './notify.js';
import { sha256hex } from './schemas.js';

// Loosely-typed event payloads (whatever Stripe versions send; we validate).
interface StripeEventLike {
  id: string;
  type: string;
  livemode?: boolean;
  data?: { object?: Record<string, unknown> };
}

function obj(event: StripeEventLike): Record<string, unknown> {
  return event.data?.object ?? {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function metaFamily(o: Record<string, unknown>): string | null {
  const meta = o.metadata as Record<string, unknown> | undefined;
  return str(meta?.product_family);
}

/**
 * Does this verified event belong to the testing product? Metadata first
 * (set server-side on both the session and the payment intent), then the
 * object's session/payment-intent/charge association against our attempts.
 * Keyring subscription objects (mode=subscription sessions, subscriptions)
 * are explicitly NOT ours.
 */
export async function isTestingStripeEvent(db: DBAdapter, event: StripeEventLike): Promise<boolean> {
  const o = obj(event);
  const objectKind = str(o.object);
  if (objectKind === 'subscription') return false;
  if (metaFamily(o) === TESTING_PRODUCT_FAMILY) return true;
  const store = new TestingStore(db);
  try {
    if (objectKind === 'checkout.session') {
      const id = str(o.id);
      return !!(id && (await store.getCheckoutAttemptBySession(id)));
    }
    const piField = str(o.payment_intent) ?? (objectKind === 'payment_intent' ? str(o.id) : null);
    if (piField && (await store.getCheckoutAttemptByPaymentIntent(piField))) return true;
    if (objectKind === 'charge') {
      const id = str(o.id);
      if (id) {
        // A charge we have seen through refund reconciliation carries payment_intent;
        // the lookup above covers it. No separate charge table in v1.
      }
    }
  } catch {
    // Testing tables absent (pre-0042 deploy): nothing is ours.
    return false;
  }
  return false;
}

/** Store the verified event durably; call BEFORE acknowledging the webhook. */
export async function receiveTestingEvent(db: DBAdapter, event: StripeEventLike, rawPayload: string): Promise<void> {
  const store = new TestingStore(db);
  await store.inboxReceive({
    eventId: event.id,
    eventType: event.type,
    payloadJson: rawPayload,
    payloadHash: sha256hex(rawPayload),
    livemode: !!event.livemode,
  });
}

export interface TestingEventDeps {
  stripe: TestingStripe | null;
  env: unknown;
}

/** Whether the configured Stripe key mode matches the event's livemode. */
function livemodeMatches(env: unknown, livemode: boolean): boolean {
  const key = testingEnv(env).STRIPE_SECRET_KEY ?? '';
  if (!key) return false;
  const keyIsLive = key.startsWith('sk_live');
  return keyIsLive === livemode;
}

/**
 * Process ONE inbox row (already claimed by the caller). Throws on retryable
 * failure; returns quietly when the event is finished or is a no-op.
 */
export async function processTestingEvent(db: DBAdapter, deps: TestingEventDeps, row: InboxRow): Promise<void> {
  const store = new TestingStore(db);
  let event: StripeEventLike;
  try {
    event = JSON.parse(row.payload_json) as StripeEventLike;
  } catch {
    await store.inboxFailed(row.event_id, 'unparseable payload', 1); // straight to manual review
    return;
  }

  // Environment separation: a test-mode object is never processed by a
  // live-keyed deployment and vice versa (spec §20.2).
  if (!livemodeMatches(deps.env, !!event.livemode)) {
    await store.inboxFailed(row.event_id, `livemode mismatch (event livemode=${!!event.livemode})`, 1);
    return;
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await applyCheckoutSuccess(db, store, deps, event);
      break;
    case 'checkout.session.expired': {
      const sessionId = str(obj(event).id);
      if (sessionId) {
        const attempt = await store.getCheckoutAttemptBySession(sessionId);
        if (attempt) await store.expireCheckoutAttempt(attempt.id);
      }
      break;
    }
    case 'checkout.session.async_payment_failed': {
      const sessionId = str(obj(event).id);
      if (sessionId) {
        const attempt = await store.getCheckoutAttemptBySession(sessionId);
        if (attempt) {
          await store.failCheckoutAttempt(attempt.id, 'async_payment_failed');
          await store.orderPaymentFailed(attempt.order_id);
        }
      }
      break;
    }
    case 'payment_intent.succeeded': {
      // Reconciliation only: resolve through the SESSION so the same
      // validation path runs; never a second entitlement (plan op key is
      // unique per order).
      const piId = str(obj(event).id);
      if (piId) {
        const attempt = await store.getCheckoutAttemptByPaymentIntent(piId);
        if (attempt?.stripe_session_id && attempt.state !== 'completed' && deps.stripe) {
          const session = await deps.stripe.retrieveCheckoutSession(attempt.stripe_session_id);
          await applyVerifiedSession(db, store, deps, session);
        }
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const piId = str(obj(event).id);
      if (piId) {
        const attempt = await store.getCheckoutAttemptByPaymentIntent(piId);
        if (attempt) {
          await store.failCheckoutAttempt(attempt.id, 'payment_intent.payment_failed');
          await store.orderPaymentFailed(attempt.order_id);
        }
      }
      break;
    }
    case 'charge.refunded':
    case 'charge.refund.updated':
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await applyRefundFacts(db, store, deps, event);
      break;
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
      await applyDisputeFacts(db, store, deps, event);
      break;
    default:
      // Associated but unhandled type: acknowledged without side effects.
      break;
  }
  await store.inboxProcessed(row.event_id);
}

/** checkout.session.* success events: re-fetch the canonical session, then apply. */
async function applyCheckoutSuccess(db: DBAdapter, store: TestingStore, deps: TestingEventDeps, event: StripeEventLike): Promise<void> {
  const sessionId = str(obj(event).id);
  if (!sessionId) return;
  if (!deps.stripe) throw new Error('stripe unavailable for canonical fetch');
  const session = await deps.stripe.retrieveCheckoutSession(sessionId);
  await applyVerifiedSession(db, store, deps, session);
}

/**
 * The single fulfillment-safe application of a paid session (spec §8.4):
 * canonical object validation → attempt completed → order payment succeeded →
 * ONE plan operation → notifications. Safe under repeats and concurrency.
 */
async function applyVerifiedSession(
  db: DBAdapter,
  store: TestingStore,
  deps: TestingEventDeps,
  session: Awaited<ReturnType<TestingStripe['retrieveCheckoutSession']>>,
): Promise<void> {
  const attempt = await store.getCheckoutAttemptBySession(session.id);
  if (!attempt) {
    // Metadata claimed testing but we have no attempt — manual review, not a write.
    throw new Error(`no checkout attempt for session ${session.id}`);
  }
  const order = await store.getOrder(attempt.order_id);
  if (!order) throw new Error(`attempt ${attempt.id} has no order`);
  const quote = await store.getQuote(order.quote_id);
  if (!quote) throw new Error(`order ${order.id} has no quote`);

  // Canonical financial validation — metadata is only a hint.
  if (session.mode !== 'payment') throw new Error(`session ${session.id} mode=${session.mode}, expected payment`);
  if (session.payment_status !== 'paid') return; // not paid (yet) — async methods resolve via their own events
  if (!livemodeMatches(deps.env, session.livemode)) throw new Error('session livemode mismatch');
  if ((session.currency ?? '').toLowerCase() !== quote.currency) throw new Error('session currency mismatch');
  if (session.amount_subtotal !== quote.subtotal_cents) throw new Error(`session subtotal ${session.amount_subtotal} != quoted ${quote.subtotal_cents}`);
  const meta = session.metadata ?? {};
  if (meta.testing_order_id && meta.testing_order_id !== order.id) throw new Error('session metadata names a different order');
  if (meta.scope_hash && meta.scope_hash !== quote.scope_hash) throw new Error('session metadata scope hash mismatch');

  const taxCents = session.total_details?.amount_tax ?? 0;
  const totalCents = session.amount_total ?? quote.subtotal_cents;

  const completed = await store.completeCheckoutAttempt({
    attemptId: attempt.id,
    paymentIntentId: session.payment_intent,
    subtotalCents: session.amount_subtotal ?? quote.subtotal_cents,
    taxCents,
    totalCents,
    currency: (session.currency ?? quote.currency).toLowerCase(),
    livemode: session.livemode,
  });

  const paid = await store.orderPaymentSucceeded(order.id, totalCents, taxCents);
  if (!paid) {
    const fresh = await store.getOrder(order.id);
    if (fresh?.payment_state === 'succeeded') {
      // Already paid. Same attempt re-delivered → idempotent no-op. A
      // DIFFERENT attempt having collected money is a duplicate charge:
      // a reconciliation incident, never a second run plan (spec §8.7).
      const attempts = await store.listCheckoutAttempts(order.id);
      const otherCompleted = attempts.find((a) => a.id !== attempt.id && a.state === 'completed');
      if (completed && otherCompleted) {
        await store.markCheckoutNeedsReconciliation(attempt.id, 'duplicate successful payment for one order');
        await store.audit({
          actor: 'system:webhook', action: 'duplicate_payment_detected', objectKind: 'order', objectId: order.id,
          reason: `attempt ${attempt.id} paid while order already paid via ${otherCompleted.id}`,
        });
        await queueOperatorNotification(store, deps.env, {
          semanticKey: `op:duplicate-payment:${attempt.id}`,
          kind: 'payment_anomaly',
          orderId: order.id,
          subject: 'Testing order received a duplicate payment',
          body: `Order ${order.id} shows a second successful payment (attempt ${attempt.id}). Resolve through the refund workflow — do not create a second run plan.`,
        });
      }
      return;
    }
    // Payment could not be applied (unexpected state) — retry later.
    throw new Error(`order ${order.id} payment transition failed from state ${fresh?.payment_state}`);
  }

  // ONE deterministic plan per order (semantic key), created only after
  // verified payment. Operator approval is still required before any task
  // is published — payment alone never publishes work.
  await store.enqueueOperation({
    kind: 'create_plan',
    semanticKey: `plan:${order.id}`,
    orderId: order.id,
    payloadJson: JSON.stringify({ order_id: order.id }),
  });
  await store.metricEvent(order.previous_order_id ? 'repeat_payment_confirmed' : 'payment_confirmed', { orderId: order.id, requestId: order.request_id });
  await store.audit({ actor: 'system:webhook', action: 'payment_succeeded', objectKind: 'order', objectId: order.id, reason: `session ${session.id}` });
  await queueCustomerNotification(db, store, deps.env, {
    semanticKey: `cust:paid:${order.id}`,
    kind: 'payment_confirmed',
    orderId: order.id,
    ownerId: order.owner_id,
    subject: 'Payment confirmed — your agent compatibility audit',
    body: `Your payment for order ${order.id} is confirmed. We are preparing the test plan; you can follow progress in the console under Testing → Orders.`,
  });
  await queueOperatorNotification(store, deps.env, {
    semanticKey: `op:paid:${order.id}`,
    kind: 'paid_order_needs_approval',
    orderId: order.id,
    subject: 'Paid testing order awaiting task approval',
    body: `Order ${order.id} is paid. Review the run plan and approve task publication in the operator queue.`,
  });
}

/** Refund lifecycle: recompute facts from the canonical charge; independent of payment_state. */
async function applyRefundFacts(db: DBAdapter, store: TestingStore, deps: TestingEventDeps, event: StripeEventLike): Promise<void> {
  const o = obj(event);
  const piId = str(o.payment_intent);
  const chargeId = str(o.object) === 'charge' ? str(o.id) : str(o.charge);
  if (!piId && !chargeId) return;
  let attempt = piId ? await store.getCheckoutAttemptByPaymentIntent(piId) : null;
  if (!attempt && chargeId && deps.stripe) {
    const charge = await deps.stripe.retrieveCharge(chargeId);
    if (charge.payment_intent) attempt = await store.getCheckoutAttemptByPaymentIntent(charge.payment_intent);
  }
  if (!attempt) return;
  const order = await store.getOrder(attempt.order_id);
  if (!order) return;

  if (event.type === 'refund.failed' || (str(o.status) === 'failed' && str(o.object) === 'refund')) {
    await store.setOrderRefundFacts(order.id, 'failed', order.refunded_cents);
    await queueOperatorNotification(store, deps.env, {
      semanticKey: `op:refund-failed:${order.id}:${str(o.id) ?? 'unknown'}`,
      kind: 'refund_failed',
      orderId: order.id,
      subject: 'Testing refund failed',
      body: `A refund for order ${order.id} failed at the processor. Review it in the operator queue.`,
    });
    return;
  }

  // Canonical amounts from the charge (never event-arrival order).
  let refundedCents = order.refunded_cents;
  let chargeAmount = order.collected_cents;
  if (deps.stripe) {
    const canonicalChargeId = chargeId ?? (attempt.stripe_payment_intent_id
      ? (await deps.stripe.retrievePaymentIntent(attempt.stripe_payment_intent_id)).latest_charge
      : null);
    if (canonicalChargeId) {
      const charge = await deps.stripe.retrieveCharge(canonicalChargeId);
      refundedCents = charge.amount_refunded;
      chargeAmount = charge.amount;
    }
  }
  const pendingRefund = str(o.object) === 'refund' && str(o.status) === 'pending';
  const state = pendingRefund && refundedCents === 0
    ? 'pending'
    : refundedCents <= 0
      ? 'none'
      : refundedCents >= chargeAmount
        ? 'full'
        : 'partial';
  await store.setOrderRefundFacts(order.id, state, refundedCents);
  if (state === 'full' || state === 'partial') {
    await store.metricEvent('refund_confirmed', { orderId: order.id });
    await queueCustomerNotification(db, store, deps.env, {
      semanticKey: `cust:refund:${order.id}:${refundedCents}`,
      kind: 'refund_update',
      orderId: order.id,
      ownerId: order.owner_id,
      subject: 'Refund update on your audit order',
      body: `A refund of $${(refundedCents / 100).toFixed(2)} on order ${order.id} has been processed by the payment provider.`,
    });
  }
}

/** Dispute lifecycle: hold new commitments; never erase results or claw back earned payouts. */
async function applyDisputeFacts(db: DBAdapter, store: TestingStore, deps: TestingEventDeps, event: StripeEventLike): Promise<void> {
  const o = obj(event);
  const piId = str(o.payment_intent);
  if (!piId) return;
  const attempt = await store.getCheckoutAttemptByPaymentIntent(piId);
  if (!attempt) return;
  const order = await store.getOrder(attempt.order_id);
  if (!order) return;
  const status = str(o.status) ?? '';
  if (event.type === 'charge.dispute.closed') {
    const won = status === 'won';
    await store.setOrderDisputeState(order.id, won ? 'won' : 'lost', !won);
  } else {
    await store.setOrderDisputeState(order.id, 'open', true);
    await store.pauseOrder(order.id); // pauses unpublished work; published/earned obligations stand
    await queueOperatorNotification(store, deps.env, {
      semanticKey: `op:dispute:${order.id}`,
      kind: 'dispute_opened',
      orderId: order.id,
      subject: 'Dispute opened on a testing payment',
      body: `A card dispute opened for order ${order.id}. New task publication is paused; earned worker obligations are unaffected. Review in the operator queue.`,
    });
  }
  await store.audit({ actor: 'system:webhook', action: `dispute_${event.type.split('.').pop()}`, objectKind: 'order', objectId: order.id, reason: status });
}

/** Drain due inbox rows under leases (jobs entry point). */
export async function drainTestingInbox(db: DBAdapter, deps: TestingEventDeps, nowIso: string, limit = 25): Promise<{ processed: number; failed: number }> {
  const store = new TestingStore(db);
  const due = await store.inboxDue(nowIso, limit);
  let processed = 0;
  let failed = 0;
  for (const row of due) {
    if (!(await store.inboxClaim(row.event_id, nowIso))) continue;
    try {
      await processTestingEvent(db, deps, { ...row, attempts: row.attempts + 1 });
      processed++;
    } catch (err) {
      failed++;
      await store.inboxFailed(row.event_id, err instanceof Error ? err.message : String(err));
    }
  }
  return { processed, failed };
}
