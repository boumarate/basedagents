/**
 * Billing for the Keyring control plane (coder brief Task 1 — decisions locked).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * North star: **local is free, hosted is paid.** The agent is the unit of
 * scale — Free = 1 owner / 3 delegated agents / 30-day retention; Pro
 * ($10/mo, $96/yr) = unlimited agents / 1-year retention / anomaly flags.
 *
 * Non-negotiable rules implemented here and at the enforcement points:
 *   1. Security actions are NEVER paywalled and never degrade — revoke, kill
 *      switch, daemon pull/confirm, and recent-timeline reads work on
 *      past_due and canceled accounts. Plan state is consulted at exactly two
 *      places: delegation creation (the 4th agent on Free) and grant
 *      approval. Never at lease time; never on daemon endpoints.
 *   2. {@link getEntitlements} is the single source of truth. No inline plan
 *      checks anywhere else.
 *   3. Downgrades apply at period end (Stripe default). Over-limit after a
 *      downgrade: existing agents keep working; no new delegations or grant
 *      approvals until under limit or re-upgraded.
 *   4. Retention is enforced at query time (no purge cron).
 *
 * Stripe wiring: Checkout for upgrades, the Customer Portal for everything
 * else (card, cancel, invoices — no custom UI), webhooks as the only writer
 * of plan state (the success redirect is untrusted). Webhook processing is
 * idempotent by event id via an atomic INSERT claim.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import Stripe from 'stripe';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ControlStore } from './store.js';
import { ownerSession } from './routes.js';
import { consoleOrigin } from './email.js';

// Entitlements live in ./entitlements.ts (no route imports there — this
// module imports ownerSession from routes.ts, and routes.ts consumes the
// entitlement gate, so keeping it here would be an ESM import cycle).
import { getEntitlements } from './entitlements.js';
export { getEntitlements, checkAgentLimit, type Entitlements } from './entitlements.js';

// Agent Testing (one-time payments) — product-aware webhook dispatch. Testing
// events are stored durably and processed under a lease; they must NEVER
// touch owners.plan / Keyring entitlements (spec §3.1).
import { isTestingStripeEvent, receiveTestingEvent, drainTestingInbox } from './agent-testing/stripe-events.js';
import { testingStripeFor } from './agent-testing/checkout.js';

// ─── config / small helpers ───

interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  priceMonthly: string;
  priceYearly: string;
}

/** Env is an opaque map (same pattern as config.ts) — no shared-Bindings widening. */
function stripeConfig(env: unknown): StripeConfig | null {
  const e = (env ?? {}) as Record<string, string | undefined>;
  if (!e.STRIPE_SECRET_KEY) return null;
  return {
    secretKey: e.STRIPE_SECRET_KEY,
    webhookSecret: e.STRIPE_WEBHOOK_SECRET ?? '',
    priceMonthly: e.STRIPE_PRICE_PRO_MONTHLY ?? '',
    priceYearly: e.STRIPE_PRICE_PRO_YEARLY ?? '',
  };
}

/** Workers-compatible client (fetch transport, WebCrypto signature checks). */
function stripeClient(cfg: StripeConfig): Stripe {
  return new Stripe(cfg.secretKey, { httpClient: Stripe.createFetchHttpClient() });
}

const cryptoProvider = Stripe.createSubtleCryptoProvider();

function getStore(c: Context<AppEnv>): ControlStore {
  return new ControlStore(c.get('db'));
}

function getOwnerId(c: Context<AppEnv>): string {
  return (c.get as (k: string) => string)('ownerId');
}

function err(
  c: Context<AppEnv>,
  status: 400 | 401 | 402 | 404 | 409 | 503,
  error: string,
  message: string,
) {
  return c.json({ error, message }, status);
}

function unixToIso(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

// ─── owner-facing routes (mounted at /v1/owner) ───

const CheckoutSchema = z.object({ interval: z.enum(['monthly', 'yearly']) });

export const billingRoutes = new Hono<AppEnv>();

/** Plan + entitlements + usage for the console's /settings/billing page. */
billingRoutes.get('/billing', ownerSession, async (c) => {
  const store = getStore(c);
  const owner = await store.getOwner(getOwnerId(c));
  if (!owner) return err(c, 404, 'not_found', 'owner not found');
  const entitlements = getEntitlements(owner);
  const activeAgents = await store.countActiveDelegations(owner.id);
  return c.json({
    plan: owner.plan,
    plan_status: owner.plan_status,
    current_period_end: owner.current_period_end,
    entitlements: {
      max_agents: Number.isFinite(entitlements.maxAgents) ? entitlements.maxAgents : null, // null = unlimited
      retention_days: entitlements.retentionDays,
      anomaly_flags: entitlements.anomalyFlags,
    },
    active_agents: activeAgents,
    billing_configured: stripeConfig(c.env) !== null,
  });
});

billingRoutes.post('/billing/checkout', ownerSession, async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg) return err(c, 503, 'billing_unavailable', 'billing is not configured');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = CheckoutSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'interval must be monthly or yearly');

  const store = getStore(c);
  const owner = await store.getOwner(getOwnerId(c));
  if (!owner) return err(c, 404, 'not_found', 'owner not found');

  const stripe = stripeClient(cfg);
  let customerId = owner.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: owner.email ?? undefined,
      metadata: { owner_id: owner.id },
    });
    customerId = customer.id;
    await store.setStripeCustomerId(owner.id, customerId);
  }

  const base = consoleOrigin(c.env);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: owner.id,
    line_items: [
      { price: parsed.data.interval === 'yearly' ? cfg.priceYearly : cfg.priceMonthly, quantity: 1 },
    ],
    success_url: `${base}/settings/billing?checkout=success`,
    cancel_url: `${base}/settings/billing?checkout=canceled`,
  });
  return c.json({ url: session.url });
});

billingRoutes.post('/billing/portal', ownerSession, async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg) return err(c, 503, 'billing_unavailable', 'billing is not configured');
  const store = getStore(c);
  const owner = await store.getOwner(getOwnerId(c));
  if (!owner?.stripe_customer_id) {
    return err(c, 400, 'bad_request', 'no billing account yet — upgrade first');
  }
  const stripe = stripeClient(cfg);
  const session = await stripe.billingPortal.sessions.create({
    customer: owner.stripe_customer_id,
    return_url: `${consoleOrigin(c.env)}/settings/billing`,
  });
  return c.json({ url: session.url });
});

// ─── the webhook (mounted at /v1 — no session; Stripe signature IS the auth) ───

export const stripeWebhookRoutes = new Hono<AppEnv>();

stripeWebhookRoutes.post('/stripe/webhook', async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg || !cfg.webhookSecret) return err(c, 503, 'billing_unavailable', 'billing is not configured');

  const signature = c.req.header('stripe-signature');
  if (!signature) return err(c, 400, 'bad_request', 'missing stripe-signature header');
  const payload = await c.req.text();

  const stripe = stripeClient(cfg);
  let event: Stripe.Event;
  try {
    // Async variant is REQUIRED on Workers (SubtleCrypto is async-only).
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      cfg.webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch {
    return err(c, 400, 'bad_request', 'webhook signature verification failed');
  }

  const store = getStore(c);

  // ── Product dispatch (spec §3.1): resolve the event's product family BEFORE
  // any claim. Agent-testing events go to a durable inbox (stored before the
  // ack, processed under a lease — a crash after the insert is retried, never
  // suppressed), and must never grant or revoke Keyring Pro. Everything else
  // keeps the legacy Keyring path below, including its event-id claim.
  const db = c.get('db');
  if (await isTestingStripeEvent(db, event as unknown as { id: string; type: string; data?: { object?: Record<string, unknown> } })) {
    await receiveTestingEvent(db, event as unknown as { id: string; type: string; livemode?: boolean }, payload);
    // Inline best-effort drain so the common case fulfills promptly; the cron
    // drains anything this pass misses (crash, lease, backoff).
    try {
      await drainTestingInbox(db, { stripe: testingStripeFor(c), env: c.env }, new Date().toISOString(), 5);
    } catch (err) {
      console.error('[testing] inline inbox drain failed (cron will retry):', err);
    }
    return c.json({ received: true, product: 'agent_testing' });
  }

  // Atomic idempotency claim: a replayed event id is acknowledged, not reprocessed.
  if (!(await store.claimStripeEvent(event.id, event.type))) {
    return c.json({ received: true, duplicate: true });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      // Keyring Pro is a SUBSCRIPTION product: plan state changes only for a
      // session that verifiably maps to a subscription — mode=subscription,
      // or (legacy event shapes without mode) a subscription id on the
      // session. A one-time payment session that reached this branch — e.g.
      // a testing session whose product association could not be resolved —
      // is acknowledged without Keyring side effects (spec §3.1).
      const mapsToSubscription = session.mode === 'subscription' || (session.mode == null && session.subscription != null);
      if (!mapsToSubscription) break;
      const ownerId = session.client_reference_id;
      if (ownerId && (await store.getOwner(ownerId))) {
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        if (customerId) await store.setStripeCustomerId(ownerId, customerId);
        await store.updateOwnerBilling({
          ownerId,
          plan: 'pro',
          planStatus: 'active',
          stripeSubscriptionId:
            typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null),
          // Period end arrives with the customer.subscription.updated that follows.
          currentPeriodEnd: null,
        });
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const owner = await store.getOwnerByStripeCustomerId(customerId);
      if (owner) {
        // Newer API versions carry current_period_end on the item, older on the sub.
        const periodEnd =
          unixToIso((sub as unknown as { current_period_end?: number }).current_period_end) ??
          unixToIso(sub.items?.data?.[0]?.current_period_end);
        if (sub.status === 'active' || sub.status === 'trialing') {
          await store.updateOwnerBilling({
            ownerId: owner.id, plan: 'pro', planStatus: 'active',
            stripeSubscriptionId: sub.id, currentPeriodEnd: periodEnd,
          });
        } else if (sub.status === 'past_due') {
          // Rule 1: past_due degrades creation limits to Free via getEntitlements,
          // but plan stays 'pro' so a recovered payment restores state cleanly.
          await store.updateOwnerBilling({
            ownerId: owner.id, plan: 'pro', planStatus: 'past_due',
            stripeSubscriptionId: sub.id, currentPeriodEnd: periodEnd,
          });
        } else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired') {
          await store.updateOwnerBilling({
            ownerId: owner.id, plan: 'free', planStatus: 'canceled',
            stripeSubscriptionId: null, currentPeriodEnd: null,
          });
        }
        // Other statuses (incomplete, paused) change nothing.
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const owner = await store.getOwnerByStripeCustomerId(customerId);
      if (owner) {
        await store.updateOwnerBilling({
          ownerId: owner.id, plan: 'free', planStatus: 'canceled',
          stripeSubscriptionId: null, currentPeriodEnd: null,
        });
      }
      break;
    }

    default:
      break; // acknowledged, ignored
  }

  return c.json({ received: true });
});
