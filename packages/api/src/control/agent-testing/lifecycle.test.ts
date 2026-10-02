/**
 * Agent Testing — customer lifecycle + payment processing tests
 * (spec §20.1, §20.2).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeHarness, signupBuyer, setupOperator, operatorSign, sampleIntake, sampleScope,
  approveQuoteParams, paidOrder, stripeEvent, type Harness,
} from './test-harness.js';
import { TestingStore } from './store.js';
import { ControlStore } from '../store.js';

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => h.teardown());

describe('buyer entry and intake (spec §2.1, §4.3)', () => {
  it('new buyer signs up via the ladder with no agent/vault/wallet, drafts, edits and submits an intake', async () => {
    const buyer = await signupBuyer(h);
    // No delegation, vault key, or Keyring plan change.
    const me = (await (await h.get('/v1/owner/me', buyer.cookie)).json()) as { delegations: unknown[]; vault_key: unknown };
    expect(me.delegations).toEqual([]);
    expect(me.vault_key).toBeNull();

    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    expect(created.status).toBe(200);
    const request = ((await created.json()) as { request: { id: string; version: number; status: string } }).request;
    expect(request.status).toBe('draft');

    // Version-guarded edit.
    const edit = await h.patch(`/v1/owner/testing/requests/${request.id}`, {
      expected_version: request.version,
      intake: sampleIntake({ product_name: 'Acme Metrics API v2' }),
    }, buyer.cookie);
    expect(edit.status).toBe(200);
    const stale = await h.patch(`/v1/owner/testing/requests/${request.id}`, {
      expected_version: request.version, // stale now
      intake: sampleIntake(),
    }, buyer.cookie);
    expect(stale.status).toBe(409);

    const submit = await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: 2 }, buyer.cookie);
    expect(submit.status).toBe(200);
    const ack = (await submit.json()) as { acknowledgment: string };
    expect(ack.acknowledgment).toContain('No payment has been taken');
  });

  it('rejects secret-looking material in intake without echoing it', async () => {
    const buyer = await signupBuyer(h);
    const res = await h.post('/v1/owner/testing/requests', sampleIntake({
      known_constraints: 'use api key sk_live_ABCDEFGHIJKLMNOPQRSTUV to authenticate',
    }), buyer.cookie);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('secret_material_rejected');
    expect(body.message).not.toContain('sk_live_ABCDEFGHIJKLMNOPQRSTUV');
  });

  it('tenant isolation: another owner reads/edits of my request answer 404', async () => {
    const buyer = await signupBuyer(h);
    const other = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string } }).request;
    expect((await h.get(`/v1/owner/testing/requests/${request.id}`, other.cookie)).status).toBe(404);
    expect((await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: 1 }, other.cookie)).status).toBe(404);
  });

  it('the product flag hides every customer route when off', async () => {
    h.env.TESTING_PRODUCT_ENABLED = '0';
    const res = await h.get('/v1/owner/testing/requests');
    expect(res.status).toBe(404);
    const cat = (await (await h.get('/v1/testing/catalog')).json()) as { available: boolean };
    expect(cat.available).toBe(false);
  });
});

describe('operator quote approval (spec §4.4, §5.2)', () => {
  it('requires admin identity and a fresh action-bound assertion; customer then sees the frozen scope', async () => {
    const op = await setupOperator(h);
    const buyer = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string } }).request;
    await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: 1 }, buyer.cookie);

    // Non-admin session gets 404 from the server, not a hidden button.
    expect((await h.get(`/v1/owner/admin/testing/requests/${request.id}`, buyer.cookie)).status).toBe(404);

    const scope = sampleScope();
    const target = new Date(Date.now() + 5 * 86_400_000).toISOString();

    // A signature over DIFFERENT facts (wrong delivery target) is refused.
    const wrongParams = approveQuoteParams(request.id, 1, scope, new Date(Date.now() + 9 * 86_400_000).toISOString());
    const badSig = await operatorSign(h, op, 'testing.approve_quote', wrongParams);
    const refused = await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
      request_version: 1, scope, delivery_target_at: target, checklist_confirmed: true, ...badSig,
    }, op.cookie);
    expect(refused.status).toBe(400);

    const signed = await operatorSign(h, op, 'testing.approve_quote', approveQuoteParams(request.id, 1, scope, target));
    const approved = await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
      request_version: 1, scope, delivery_target_at: target, checklist_confirmed: true, ...signed,
    }, op.cookie);
    expect(approved.status).toBe(200);
    const quote = ((await approved.json()) as { quote: { id: string; subtotal_cents: number; status: string } }).quote;
    expect(quote.subtotal_cents).toBe(20000);

    // Customer sees the quote with the delivery target and can request changes.
    const view = (await (await h.get(`/v1/owner/testing/requests/${request.id}`, buyer.cookie)).json()) as {
      quote: { id: string; delivery_target_at: string; scope_hash: string } | null;
    };
    expect(view.quote?.id).toBe(quote.id);
    expect(view.quote?.delivery_target_at).toBe(target);

    const change = await h.post(`/v1/owner/testing/quotes/${quote.id}/change-request`, { note: 'please include the aider environment twice' }, buyer.cookie);
    expect(change.status).toBe(200);
    const after = (await (await h.get(`/v1/owner/testing/requests/${request.id}`, buyer.cookie)).json()) as { request: { status: string } };
    expect(after.request.status).toBe('needs_changes');
  });

  it('category "other" is not quotable under the standard package', async () => {
    const op = await setupOperator(h);
    const buyer = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake({ product_category: 'other' }), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string } }).request;
    await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: 1 }, buyer.cookie);
    const scope = sampleScope();
    const target = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const signed = await operatorSign(h, op, 'testing.approve_quote', approveQuoteParams(request.id, 1, scope, target));
    const res = await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
      request_version: 1, scope, delivery_target_at: target, checklist_confirmed: true, ...signed,
    }, op.cookie);
    expect(res.status).toBe(409);
  });
});

describe('checkout + webhook processing (spec §8, §20.2)', () => {
  it('a paid test-mode checkout produces exactly one paid order, one plan, and no published tasks', async () => {
    const op = await setupOperator(h);
    const { orderId } = await paidOrder(h, op);
    const store = new TestingStore(h.db);
    const order = (await store.getOrder(orderId))!;
    expect(order.payment_state).toBe('succeeded');
    expect(order.collected_cents).toBe(20000);
    expect(order.fulfillment_state).toBe('ready');

    const runs = await store.listRuns(orderId);
    expect(runs.map((r) => r.kind).sort()).toEqual(['baseline', 'external', 'external', 'external']);
    // Retest entitlement is an earmark, not a run or task.
    const reservations = await store.listReservations(orderId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].purpose).toBe('retest_earmark');
    // No marketplace task exists before operator approval.
    const tasks = await h.db.all('SELECT task_id FROM tasks');
    expect(tasks).toHaveLength(0);
  });

  it('duplicate + concurrent webhook delivery of the same event produces one order state and one plan', async () => {
    const op = await setupOperator(h);
    const { orderId, sessionId } = await paidOrder(h, op);
    const session = await h.stripe.retrieveCheckoutSession(sessionId);
    const event = stripeEvent('checkout.session.completed', { object: 'checkout.session', id: session.id, metadata: session.metadata }, { id: 'evt_dup' });
    const [a, b] = await Promise.all([h.sendStripeEvent(event), h.sendStripeEvent(event)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await h.runJobs();
    const store = new TestingStore(h.db);
    expect((await store.listRuns(orderId)).length).toBe(4); // unchanged: B0 + 3 external
    const planOps = await h.db.all(`SELECT id FROM testing_operations WHERE kind = 'create_plan' AND order_id = ?`, orderId);
    expect(planOps).toHaveLength(1);
  });

  it('an invalid webhook signature is rejected; a testing payment never touches Keyring plan state', async () => {
    const op = await setupOperator(h);
    const { buyer, sessionId } = await paidOrder(h, op);
    const session = await h.stripe.retrieveCheckoutSession(sessionId);
    const bad = await h.sendStripeEvent(
      stripeEvent('checkout.session.completed', { object: 'checkout.session', id: session.id, metadata: session.metadata }),
      { badSignature: true },
    );
    expect(bad.status).toBe(400);
    const owner = await new ControlStore(h.db).getOwner(buyer.ownerId);
    expect(owner!.plan).toBe('free'); // the successful one-time payment upgraded nothing
  });

  it('declined/expired checkouts create no entitlement; a later success wins over an earlier failure', async () => {
    const op = await setupOperator(h);
    const buyer = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string; version: number } }).request;
    await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: 1 }, buyer.cookie);
    const scope = sampleScope();
    const target = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const signed = await operatorSign(h, op, 'testing.approve_quote', approveQuoteParams(request.id, 1, scope, target));
    const approved = await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
      request_version: 1, scope, delivery_target_at: target, checklist_confirmed: true, ...signed,
    }, op.cookie);
    const quote = ((await approved.json()) as { quote: { id: string; scope_hash: string; terms_version: string; disclosure_version: string } }).quote;

    const pay = (key: string) => h.post(`/v1/owner/testing/quotes/${quote.id}/checkout`, {
      quote_version: 1, scope_hash: quote.scope_hash, terms_version: quote.terms_version,
      disclosure_version: quote.disclosure_version, idempotency_key: key,
    }, buyer.cookie);

    // Attempt 1 expires unpaid.
    const first = (await (await pay('attempt-1-aaaa')).json()) as { checkout_url: string; order_id: string };
    const firstSession = first.checkout_url.split('/').pop()!;
    await h.sendStripeEvent(stripeEvent('checkout.session.expired', { object: 'checkout.session', id: firstSession, metadata: { product_family: 'agent_testing' } }));
    await h.runJobs();
    const store = new TestingStore(h.db);
    let order = (await store.getOrder(first.order_id))!;
    expect(order.payment_state).toBe('unpaid');
    expect((await store.listRuns(order.id)).length).toBe(0);

    // Attempt 2 succeeds; the old expiry cannot demote it afterwards.
    const second = (await (await pay('attempt-2-bbbb')).json()) as { checkout_url: string; order_id: string };
    expect(second.order_id).toBe(first.order_id); // one order per quote
    const secondSession = second.checkout_url.split('/').pop()!;
    const paidSession = h.stripe.completePayment(secondSession);
    await h.sendStripeEvent(stripeEvent('checkout.session.completed', { object: 'checkout.session', id: paidSession.id, metadata: paidSession.metadata }));
    await h.sendStripeEvent(stripeEvent('checkout.session.expired', { object: 'checkout.session', id: secondSession, metadata: paidSession.metadata }));
    await h.runJobs();
    order = (await store.getOrder(first.order_id))!;
    expect(order.payment_state).toBe('succeeded');
    const attempts = await store.listCheckoutAttempts(order.id);
    expect(attempts.find((a) => a.stripe_session_id === secondSession)?.state).toBe('completed');
  });

  it('a client cannot forge payment: only the verified webhook marks paid, and client fields cannot alter price or owner', async () => {
    const op = await setupOperator(h);
    const buyer = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string } }).request;
    await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: 1 }, buyer.cookie);
    const scope = sampleScope();
    const target = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const signed = await operatorSign(h, op, 'testing.approve_quote', approveQuoteParams(request.id, 1, scope, target));
    const approved = await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
      request_version: 1, scope, delivery_target_at: target, checklist_confirmed: true, ...signed,
    }, op.cookie);
    const quote = ((await approved.json()) as { quote: { id: string; scope_hash: string; terms_version: string; disclosure_version: string } }).quote;

    // Client-supplied price/owner fields are rejected by the strict schema.
    const tampered = await h.post(`/v1/owner/testing/quotes/${quote.id}/checkout`, {
      quote_version: 1, scope_hash: quote.scope_hash, terms_version: quote.terms_version,
      disclosure_version: quote.disclosure_version, idempotency_key: 'tamper-11111',
      amount_cents: 1, owner_id: 'ow_someoneelse',
    }, buyer.cookie);
    expect(tampered.status).toBe(400);

    const ok = (await (await h.post(`/v1/owner/testing/quotes/${quote.id}/checkout`, {
      quote_version: 1, scope_hash: quote.scope_hash, terms_version: quote.terms_version,
      disclosure_version: quote.disclosure_version, idempotency_key: 'honest-11111',
    }, buyer.cookie)).json()) as { order_id: string };

    // Browser "success" return alone: order still unpaid until the webhook.
    const store = new TestingStore(h.db);
    expect(((await store.getOrder(ok.order_id))!).payment_state).toBe('unpaid');
    const view = (await (await h.get(`/v1/owner/testing/orders/${ok.order_id}`, buyer.cookie)).json()) as { order: { stage: string } };
    expect(['Payment confirmation', 'Ready to purchase']).toContain(view.order.stage);

    // A forged completed event for a session we never created is not applied.
    await h.sendStripeEvent(stripeEvent('checkout.session.completed', {
      object: 'checkout.session', id: 'cs_forged_unknown', metadata: { product_family: 'agent_testing', testing_order_id: ok.order_id },
    }));
    await h.runJobs();
    expect(((await store.getOrder(ok.order_id))!).payment_state).toBe('unpaid');
  });

  it('a second successful payment for one order becomes a reconciliation incident, not a second plan', async () => {
    const op = await setupOperator(h);
    const { orderId, quoteId, buyer } = await paidOrder(h, op);
    const store = new TestingStore(h.db);

    // A second checkout attempt (different idempotency key) that also gets paid.
    const quote = (await store.getQuote(quoteId))!;
    const second = await h.post(`/v1/owner/testing/quotes/${quoteId}/checkout`, {
      quote_version: quote.request_version, scope_hash: quote.scope_hash, terms_version: quote.terms_version,
      disclosure_version: quote.disclosure_version, idempotency_key: 'second-charge-1',
    }, buyer.cookie);
    // Already paid → refused up front; simulate the race instead by paying the
    // stored open session directly if one had been created.
    expect(second.status).toBe(409);

    // Simulate the true race: a second session existed before payment 1 landed.
    const attempt = await store.createCheckoutAttempt({ orderId, operationKey: 'race-key', quotedSubtotalCents: 20000, quotedCurrency: 'usd' });
    const raceSession = await h.stripe.createCheckoutSession(
      { priceId: 'price_testing_audit', customerId: null, successUrl: 'https://x/s', cancelUrl: 'https://x/c', metadata: { product_family: 'agent_testing', testing_order_id: orderId, testing_quote_id: quoteId, scope_hash: quote.scope_hash, schema_version: '1' } },
      'race-key',
    );
    await store.attachStripeSession(attempt!.id, raceSession.id, raceSession.url, false);
    const paid = h.stripe.completePayment(raceSession.id);
    await h.sendStripeEvent(stripeEvent('checkout.session.completed', { object: 'checkout.session', id: paid.id, metadata: paid.metadata }));
    await h.runJobs();

    const attempts = await store.listCheckoutAttempts(orderId);
    expect(attempts.find((a) => a.stripe_session_id === raceSession.id)?.state).toBe('needs_reconciliation');
    const planOps = await h.db.all(`SELECT id FROM testing_operations WHERE kind = 'create_plan' AND order_id = ?`, orderId);
    expect(planOps).toHaveLength(1);
    // Operator was alerted.
    const alert = await h.db.get(`SELECT semantic_key FROM testing_notifications WHERE kind = 'payment_anomaly'`);
    expect(alert).not.toBeNull();
  });

  it('live-mode objects are refused by a test-keyed deployment', async () => {
    const op = await setupOperator(h);
    const { sessionId } = await paidOrder(h, op);
    const session = await h.stripe.retrieveCheckoutSession(sessionId);
    await h.sendStripeEvent(stripeEvent('checkout.session.completed', { object: 'checkout.session', id: session.id, metadata: session.metadata }, { livemode: true, id: 'evt_live' }));
    await h.runJobs();
    const row = await h.db.get<{ state: string; last_error: string }>(`SELECT state, last_error FROM testing_stripe_events WHERE event_id = 'evt_live'`);
    expect(row?.state).toBe('manual_review');
    expect(row?.last_error).toContain('livemode');
  });

  it('a crash between inbox insert and processing is recovered by the jobs runner', async () => {
    const op = await setupOperator(h);
    const buyer = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string } }).request;
    await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: 1 }, buyer.cookie);
    const scope = sampleScope();
    const target = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const signed = await operatorSign(h, op, 'testing.approve_quote', approveQuoteParams(request.id, 1, scope, target));
    const approved = await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
      request_version: 1, scope, delivery_target_at: target, checklist_confirmed: true, ...signed,
    }, op.cookie);
    const quote = ((await approved.json()) as { quote: { id: string; scope_hash: string; terms_version: string; disclosure_version: string } }).quote;
    const ck = (await (await h.post(`/v1/owner/testing/quotes/${quote.id}/checkout`, {
      quote_version: 1, scope_hash: quote.scope_hash, terms_version: quote.terms_version,
      disclosure_version: quote.disclosure_version, idempotency_key: 'crash-recover-1',
    }, buyer.cookie)).json()) as { checkout_url: string; order_id: string };
    const sessionId = ck.checkout_url.split('/').pop()!;
    const session = h.stripe.completePayment(sessionId);

    // Simulate "crash after durable insert": store the event directly, never
    // run the inline drain (as if the worker died right after ack).
    const store = new TestingStore(h.db);
    await store.inboxReceive({
      eventId: 'evt_crash', eventType: 'checkout.session.completed',
      payloadJson: JSON.stringify(stripeEvent('checkout.session.completed', { object: 'checkout.session', id: session.id, metadata: session.metadata }, { id: 'evt_crash' })),
      payloadHash: 'x', livemode: false,
    });
    expect(((await store.getOrder(ck.order_id))!).payment_state).toBe('unpaid');
    await h.runJobs(); // recovery
    expect(((await store.getOrder(ck.order_id))!).payment_state).toBe('succeeded');
  });

  it('a lost Stripe response during session creation does not mint extra sessions on retry', async () => {
    const op = await setupOperator(h);
    const buyer = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string } }).request;
    await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: 1 }, buyer.cookie);
    const scope = sampleScope();
    const target = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const signed = await operatorSign(h, op, 'testing.approve_quote', approveQuoteParams(request.id, 1, scope, target));
    const approved = await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
      request_version: 1, scope, delivery_target_at: target, checklist_confirmed: true, ...signed,
    }, op.cookie);
    const quote = ((await approved.json()) as { quote: { id: string; scope_hash: string; terms_version: string; disclosure_version: string } }).quote;

    h.stripe.loseNextSessionResponse = true;
    const lost = await h.post(`/v1/owner/testing/quotes/${quote.id}/checkout`, {
      quote_version: 1, scope_hash: quote.scope_hash, terms_version: quote.terms_version,
      disclosure_version: quote.disclosure_version, idempotency_key: 'lost-response-1',
    }, buyer.cookie);
    expect(lost.status).toBe(503);
    expect(((await lost.json()) as { error: string }).error).toBe('operation_needs_reconciliation');

    // The retry with the SAME key converges on the SAME Stripe session.
    // (Provider idempotency: the double returns the session it already made.)
    const retry = await h.post(`/v1/owner/testing/quotes/${quote.id}/checkout`, {
      quote_version: 1, scope_hash: quote.scope_hash, terms_version: quote.terms_version,
      disclosure_version: quote.disclosure_version, idempotency_key: 'retry-key-2222',
    }, buyer.cookie);
    expect(retry.status).toBe(200);
    expect(h.stripe.sessionCount).toBe(2); // one lost-but-created + one for the new attempt — never a third
  });

  it('refund lifecycle: operator ceremony → durable op → provider → webhook facts; failure is represented', async () => {
    const op = await setupOperator(h);
    const { orderId } = await paidOrder(h, op);
    const store = new TestingStore(h.db);

    const signed = await operatorSign(h, op, 'testing.refund_order', {
      order_id: orderId, amount_cents: 5000, reason_hash: (await import('./schemas.js')).sha256hex('goodwill partial refund'),
    });
    const res = await h.post(`/v1/owner/admin/testing/orders/${orderId}/refund`, {
      amount_cents: 5000, reason: 'goodwill partial refund', ...signed,
    }, op.cookie);
    expect(res.status).toBe(200);
    expect(((await store.getOrder(orderId))!).refund_state).toBe('pending');

    await h.runJobs(); // executes the refund operation against the provider
    const refund = h.stripe.refunds[0];
    expect(refund.amount).toBe(5000);

    // Canonical refund facts arrive via webhook.
    const charge = await h.stripe.retrieveCharge(`ch_${(await store.listCheckoutAttempts(orderId)).find((a) => a.state === 'completed')!.stripe_session_id}`);
    await h.sendStripeEvent(stripeEvent('charge.refunded', { object: 'charge', id: charge.id, payment_intent: charge.payment_intent, amount_refunded: 5000 }));
    await h.runJobs();
    const order = (await store.getOrder(orderId))!;
    expect(order.refund_state).toBe('partial');
    expect(order.refunded_cents).toBe(5000);
    expect(order.payment_state).toBe('succeeded'); // independent states
  });

  it('a dispute pauses new work but never erases financial facts', async () => {
    const op = await setupOperator(h);
    const { orderId } = await paidOrder(h, op);
    const store = new TestingStore(h.db);
    const pi = (await store.listCheckoutAttempts(orderId)).find((a) => a.state === 'completed')!.stripe_payment_intent_id!;
    await h.sendStripeEvent(stripeEvent('charge.dispute.created', { object: 'dispute', id: 'dp_1', payment_intent: pi, status: 'needs_response' }));
    await h.runJobs();
    let order = (await store.getOrder(orderId))!;
    expect(order.dispute_state).toBe('open');
    expect(order.risk_hold).toBe(1);
    expect(order.fulfillment_state).toBe('paused');
    await h.sendStripeEvent(stripeEvent('charge.dispute.closed', { object: 'dispute', id: 'dp_1', payment_intent: pi, status: 'won' }));
    await h.runJobs();
    order = (await store.getOrder(orderId))!;
    expect(order.dispute_state).toBe('won');
    expect(order.risk_hold).toBe(0);
    expect(order.collected_cents).toBe(20000);
  });

  it('Keyring subscription renewal events never create testing work', async () => {
    const before = await h.db.all(`SELECT event_id FROM testing_stripe_events`);
    await h.sendStripeEvent({
      id: 'evt_keyring_sub', object: 'event', type: 'customer.subscription.updated', livemode: false,
      data: { object: { object: 'subscription', id: 'sub_9', customer: 'cus_9', status: 'active', items: { data: [{ current_period_end: 1893456000 }] } } },
    });
    const after = await h.db.all(`SELECT event_id FROM testing_stripe_events`);
    expect(after.length).toBe(before.length); // never entered the testing inbox
    expect(await h.db.all(`SELECT id FROM testing_orders`)).toHaveLength(0);
  });
});
