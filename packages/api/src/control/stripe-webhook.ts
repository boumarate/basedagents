/**
 * The Stripe webhook (mounted at /v1 — no session; the Stripe signature IS
 * the auth).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Keyring Pro (the subscription product this endpoint originally served) was
 * retired in migration 0048; the only Stripe product left is Agent Testing's
 * one-time checkout. Its events go to a durable inbox (stored before the
 * ack, processed under a lease — a crash after the insert is retried, never
 * suppressed; spec §3.1). Any other event — a dangling subscription event
 * from the retired product, or a testing session whose product association
 * could not be resolved — is acknowledged and ignored, so Stripe never
 * retries into a product that no longer exists.
 */
import { Hono } from 'hono';
import Stripe from 'stripe';
import type { AppEnv } from '../types/index.js';
import { isTestingStripeEvent, receiveTestingEvent, drainTestingInbox } from './agent-testing/stripe-events.js';
import { testingStripeFor } from './agent-testing/checkout.js';

/** Env is an opaque map (same pattern as config.ts) — no shared-Bindings widening. */
function stripeSecrets(env: unknown): { secretKey: string; webhookSecret: string } | null {
  const e = (env ?? {}) as Record<string, string | undefined>;
  if (!e.STRIPE_SECRET_KEY || !e.STRIPE_WEBHOOK_SECRET) return null;
  return { secretKey: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET };
}

const cryptoProvider = Stripe.createSubtleCryptoProvider();

export const stripeWebhookRoutes = new Hono<AppEnv>();

stripeWebhookRoutes.post('/stripe/webhook', async (c) => {
  const cfg = stripeSecrets(c.env);
  if (!cfg) return c.json({ error: 'billing_unavailable', message: 'billing is not configured' }, 503);

  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'bad_request', message: 'missing stripe-signature header' }, 400);
  const payload = await c.req.text();

  const stripe = new Stripe(cfg.secretKey, { httpClient: Stripe.createFetchHttpClient() });
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
    return c.json({ error: 'bad_request', message: 'webhook signature verification failed' }, 400);
  }

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

  return c.json({ received: true });
});
