/**
 * Agent Testing — hosted one-time Checkout (spec §8.2–§8.3).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * mode=payment, server-allowlisted price, quantity 1, server-controlled
 * return URLs. The client supplies only the approved quote id/version, the
 * scope hash, disclosure versions and an idempotency key — never a price, a
 * Stripe id, a budget or a redirect target.
 *
 * The Stripe client is an interface so tests and the local demo inject a
 * scripted double (`c.set('testingStripe', …)`, same pattern as emailSender);
 * production builds the real SDK client from env. Missing configuration
 * disables checkout with useful copy — it never fakes success.
 */
import Stripe from 'stripe';
import type { Context } from 'hono';
import type { AppEnv } from '../../types/index.js';
import { ControlStore } from '../store.js';
import { consoleOrigin } from '../email.js';
import { TestingStore, type QuoteRow, type OrderRow, type CheckoutAttemptRow } from './store.js';
import { activePackage, checkoutDisabledReason, testingEnv, testingFlags } from './catalog.js';

// ─── the injectable Stripe surface (only what this product needs) ───

export interface TestingCheckoutSession {
  id: string;
  url: string | null;
  mode: string | null;
  status: string | null;
  payment_status: string | null;
  currency: string | null;
  amount_subtotal: number | null;
  amount_total: number | null;
  total_details?: { amount_tax?: number | null } | null;
  payment_intent: string | null;
  livemode: boolean;
  metadata: Record<string, string> | null;
  client_reference_id?: string | null;
}

export interface TestingPaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  livemode: boolean;
  latest_charge: string | null;
  metadata: Record<string, string> | null;
}

export interface TestingCharge {
  id: string;
  payment_intent: string | null;
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  currency: string;
  livemode: boolean;
}

export interface TestingPrice {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  type: string; // 'one_time' | 'recurring'
  livemode: boolean;
}

export interface TestingRefund {
  id: string;
  status: string | null; // pending | succeeded | failed | canceled
  amount: number;
  charge: string | null;
}

export interface TestingStripe {
  retrievePrice(priceId: string): Promise<TestingPrice>;
  createCustomer(input: { email?: string; ownerId: string }, idempotencyKey: string): Promise<{ id: string }>;
  createCheckoutSession(
    input: {
      priceId: string;
      customerId: string | null;
      successUrl: string;
      cancelUrl: string;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ): Promise<TestingCheckoutSession>;
  retrieveCheckoutSession(sessionId: string): Promise<TestingCheckoutSession>;
  retrievePaymentIntent(id: string): Promise<TestingPaymentIntent>;
  retrieveCharge(id: string): Promise<TestingCharge>;
  createRefund(input: { paymentIntentId: string; amountCents: number; reason?: string }, idempotencyKey: string): Promise<TestingRefund>;
}

// ─── real client (Workers-compatible fetch transport, billing.ts pattern) ───

export function realTestingStripe(secretKey: string): TestingStripe {
  const stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });
  return {
    async retrievePrice(priceId) {
      const p = await stripe.prices.retrieve(priceId);
      return { id: p.id, active: p.active, currency: p.currency, unit_amount: p.unit_amount, type: p.type, livemode: p.livemode };
    },
    async createCustomer(input, idempotencyKey) {
      const c = await stripe.customers.create(
        { email: input.email, metadata: { owner_id: input.ownerId } },
        { idempotencyKey },
      );
      return { id: c.id };
    },
    async createCheckoutSession(input, idempotencyKey) {
      const s = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          customer: input.customerId ?? undefined,
          line_items: [{ price: input.priceId, quantity: 1 }],
          payment_method_types: ['card'],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: input.metadata,
          payment_intent_data: { metadata: input.metadata },
        },
        { idempotencyKey },
      );
      return shapeSession(s);
    },
    async retrieveCheckoutSession(sessionId) {
      return shapeSession(await stripe.checkout.sessions.retrieve(sessionId));
    },
    async retrievePaymentIntent(id) {
      const pi = await stripe.paymentIntents.retrieve(id);
      return {
        id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency, livemode: pi.livemode,
        latest_charge: typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? null),
        metadata: (pi.metadata ?? null) as Record<string, string> | null,
      };
    },
    async retrieveCharge(id) {
      const ch = await stripe.charges.retrieve(id);
      return {
        id: ch.id,
        payment_intent: typeof ch.payment_intent === 'string' ? ch.payment_intent : (ch.payment_intent?.id ?? null),
        amount: ch.amount, amount_refunded: ch.amount_refunded, refunded: ch.refunded,
        currency: ch.currency, livemode: ch.livemode,
      };
    },
    async createRefund(input, idempotencyKey) {
      const r = await stripe.refunds.create(
        { payment_intent: input.paymentIntentId, amount: input.amountCents },
        { idempotencyKey },
      );
      return { id: r.id, status: r.status, amount: r.amount, charge: typeof r.charge === 'string' ? r.charge : (r.charge?.id ?? null) };
    },
  };
}

function shapeSession(s: Stripe.Checkout.Session): TestingCheckoutSession {
  return {
    id: s.id,
    url: s.url ?? null,
    mode: s.mode ?? null,
    status: s.status ?? null,
    payment_status: s.payment_status ?? null,
    currency: s.currency ?? null,
    amount_subtotal: s.amount_subtotal ?? null,
    amount_total: s.amount_total ?? null,
    total_details: s.total_details ?? null,
    payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null),
    livemode: s.livemode,
    metadata: (s.metadata ?? null) as Record<string, string> | null,
    client_reference_id: s.client_reference_id ?? null,
  };
}

/** Resolve the Stripe client: injected double first, else real SDK from env, else null. */
export function testingStripeFor(c: Context<AppEnv>): TestingStripe | null {
  const injected = (c.get as (k: string) => TestingStripe | undefined)('testingStripe');
  if (injected) return injected;
  const e = testingEnv(c.env);
  if (!e.STRIPE_SECRET_KEY) return null;
  return realTestingStripe(e.STRIPE_SECRET_KEY);
}

/** Same resolution for non-request contexts (jobs): injected via deps or env. */
export function testingStripeFromEnv(env: unknown): TestingStripe | null {
  const e = testingEnv(env);
  if (!e.STRIPE_SECRET_KEY) return null;
  return realTestingStripe(e.STRIPE_SECRET_KEY);
}

// ─── checkout creation (spec §8.2) ───

export const TESTING_PRODUCT_FAMILY = 'agent_testing';

export type CheckoutStartResult =
  | { ok: true; url: string; orderId: string; attemptId: string; reused: boolean }
  | { ok: false; status: 402 | 409 | 422 | 429 | 503; error: string; message: string };

export async function startCheckout(input: {
  store: TestingStore;
  controlStore: ControlStore;
  stripe: TestingStripe | null;
  env: unknown;
  emailConfigured: boolean;
  ownerId: string;
  quote: QuoteRow;
  acceptedScopeHash: string;
  acceptedTermsVersion: string;
  acceptedDisclosureVersion: string;
  idempotencyKey: string;
}): Promise<CheckoutStartResult> {
  const { store, quote, env } = input;
  const e = testingEnv(env);

  const disabled = checkoutDisabledReason(env, {
    emailConfigured: input.emailConfigured,
    stripeConfigured: input.stripe !== null,
  });
  if (disabled) return { ok: false, status: 503, error: 'billing_unavailable', message: disabled };

  // Live-mode approval gate: a live Stripe key needs the explicit operator flag.
  const flags = testingFlags(env);
  if ((e.STRIPE_SECRET_KEY ?? '').startsWith('sk_live') && !flags.liveApproved) {
    return { ok: false, status: 503, error: 'billing_unavailable', message: 'Live checkout has not been approved for this deployment.' };
  }

  // The exact approved quote, unexpired, with the exact disclosures the buyer accepted.
  const now = new Date().toISOString();
  if (quote.status !== 'approved' && quote.status !== 'accepted') {
    return { ok: false, status: 409, error: 'quote_expired', message: 'This quote is no longer payable. Request an updated scope before paying.' };
  }
  if (quote.status === 'approved' && quote.expires_at <= now) {
    return { ok: false, status: 409, error: 'quote_expired', message: 'This quote has expired. Request an updated scope before paying.' };
  }
  if (quote.scope_hash !== input.acceptedScopeHash) {
    return { ok: false, status: 409, error: 'scope_changed', message: 'The scope changed since you reviewed it. Review the current scope and try again.' };
  }
  if (quote.terms_version !== input.acceptedTermsVersion || quote.disclosure_version !== input.acceptedDisclosureVersion) {
    return { ok: false, status: 409, error: 'scope_changed', message: 'The terms or disclosures changed since you reviewed them. Review and accept the current versions.' };
  }

  // Configured price must exist, be one-time, active, usd, and match the frozen subtotal.
  const priceId = e.STRIPE_PRICE_TESTING_AUDIT ?? '';
  if (!priceId || (quote.stripe_price_id && quote.stripe_price_id !== priceId)) {
    return { ok: false, status: 503, error: 'billing_unavailable', message: 'The audit package price is not configured consistently.' };
  }
  let price: TestingPrice;
  try {
    price = await input.stripe!.retrievePrice(priceId);
  } catch {
    return { ok: false, status: 503, error: 'billing_unavailable', message: 'The payment processor could not be reached. Try again shortly.' };
  }
  if (!price.active || price.type !== 'one_time' || price.currency !== quote.currency || price.unit_amount !== quote.subtotal_cents) {
    return { ok: false, status: 503, error: 'billing_unavailable', message: 'The configured price does not match this quote. The operator has been notified.' };
  }

  // Capacity: bounded number of active paid orders.
  const pkg = activePackage(env);
  const active = await store.countActivePaidOrders();
  if (active >= pkg.maximum_active_orders_default) {
    return { ok: false, status: 429, error: 'capacity_unavailable', message: 'Testing capacity is currently full. Try again soon — your approved quote remains valid until it expires.' };
  }

  // One order per quote (atomic; replays converge).
  const order = await store.createOrderForQuote({
    quote,
    ownerId: input.ownerId,
    source: (await store.getRequest(quote.request_id))?.source ?? 'external_customer',
  });
  if (!order || order.owner_id !== input.ownerId) {
    return { ok: false, status: 409, error: 'quote_expired', message: 'This quote is no longer payable. Request an updated scope before paying.' };
  }
  if (order.payment_state === 'succeeded') {
    return { ok: false, status: 409, error: 'conflict', message: 'This order is already paid.' };
  }
  if (order.risk_hold) {
    return { ok: false, status: 409, error: 'financial_hold', message: 'This order is under a financial hold. Contact support.' };
  }

  // Durable checkout operation: one attempt per (quote, client idempotency key).
  const operationKey = `chk:${quote.id}:${input.idempotencyKey}`;
  const attempt = await store.createCheckoutAttempt({
    orderId: order.id,
    operationKey,
    quotedSubtotalCents: quote.subtotal_cents,
    quotedCurrency: quote.currency,
  });
  if (!attempt) {
    return { ok: false, status: 409, error: 'conflict', message: 'A checkout for this order is already being created. Try again in a moment.' };
  }
  if (attempt.state === 'open' && attempt.checkout_url) {
    return { ok: true, url: attempt.checkout_url, orderId: order.id, attemptId: attempt.id, reused: true };
  }
  if (attempt.state === 'completed') {
    return { ok: false, status: 409, error: 'conflict', message: 'This checkout already completed.' };
  }
  if (attempt.state !== 'creating') {
    return { ok: false, status: 409, error: 'operation_needs_reconciliation', message: 'A previous checkout attempt needs review. Start a new checkout.' };
  }

  // Stable Stripe customer per owner (idempotent create; never matched by bare email).
  const owner = await input.controlStore.getOwner(input.ownerId);
  let customerId = owner?.stripe_customer_id ?? null;
  if (!customerId && owner) {
    try {
      const created = await input.stripe!.createCustomer({ email: owner.email ?? undefined, ownerId: owner.id }, `testing-cust:${owner.id}`);
      customerId = created.id;
      await input.controlStore.setStripeCustomerId(owner.id, customerId);
    } catch {
      await store.failCheckoutAttempt(attempt.id, 'customer_create_failed');
      return { ok: false, status: 503, error: 'billing_unavailable', message: 'The payment processor could not be reached. Try again shortly.' };
    }
  }

  const base = consoleOrigin(env);
  const metadata = {
    product_family: TESTING_PRODUCT_FAMILY,
    testing_order_id: order.id,
    testing_quote_id: quote.id,
    scope_hash: quote.scope_hash,
    schema_version: '1',
  };
  let session: TestingCheckoutSession;
  try {
    session = await input.stripe!.createCheckoutSession(
      {
        priceId,
        customerId,
        successUrl: `${base}/testing/orders/${order.id}?checkout=success`,
        cancelUrl: `${base}/testing/orders/${order.id}?checkout=cancelled`,
        metadata,
      },
      operationKey, // provider idempotency key — a lost response retries into the SAME session
    );
  } catch (err) {
    // The session may or may not exist at Stripe. The durable attempt row
    // stays `creating` under its operation key: the reconcile job (or a retry
    // with the SAME idempotency key) resolves it. Never mint a fresh
    // operation because a browser timed out.
    await store.markCheckoutNeedsReconciliation(attempt.id, err instanceof Error ? err.message : 'session_create_unresolved');
    return { ok: false, status: 503, error: 'operation_needs_reconciliation', message: 'The checkout could not be confirmed. Retry in a moment — you have not been charged.' };
  }
  if (!session.url) {
    await store.failCheckoutAttempt(attempt.id, 'session_missing_url');
    return { ok: false, status: 503, error: 'billing_unavailable', message: 'The payment processor returned an unusable session. Try again.' };
  }
  await store.attachStripeSession(attempt.id, session.id, session.url, session.livemode);
  await store.metricEvent('checkout_started', { orderId: order.id, requestId: quote.request_id });
  return { ok: true, url: session.url, orderId: order.id, attemptId: attempt.id, reused: false };
}

/** Reconcile a `creating`/`needs_reconciliation` attempt via its stored session (jobs). */
export async function reconcileCheckoutAttempt(
  store: TestingStore,
  stripe: TestingStripe,
  attempt: CheckoutAttemptRow,
): Promise<void> {
  if (!attempt.stripe_session_id) return; // nothing at Stripe we know of; safe to fail the attempt
  const session = await stripe.retrieveCheckoutSession(attempt.stripe_session_id);
  if (session.status === 'expired') await store.expireCheckoutAttempt(attempt.id);
}

/** True when a browser return may show "Confirming payment" (server truth pending). */
export function paymentPendingCopy(order: OrderRow): string | null {
  if (order.payment_state === 'succeeded') return null;
  return 'Confirming payment — this page updates once the payment is verified by our servers.';
}
