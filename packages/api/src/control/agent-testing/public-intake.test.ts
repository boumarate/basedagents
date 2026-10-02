/**
 * Agent Testing — public (no-account) intake and email-verified adoption.
 *
 * Every audit request is operator-reviewed before any quote or payment, so
 * the intake form is open: a visitor submits with an email address, the
 * payload waits in the pre-auth inbox, a sign-in link goes out, and the
 * request attaches to the account the moment that address signs in — the
 * exact §2.1 promise that a buyer returns to the testing surface, never
 * agent setup.
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  approveQuoteParams, makeHarness, operatorSign, sampleIntake, sampleScope, sessionCookieOf,
  setupOperator, signupBuyer, type Harness,
} from './test-harness.js';
import { TestingStore } from './store.js';

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

afterEach(() => h.teardown());

const EMAIL = 'visitor@example.com';

async function publicSubmit(email = EMAIL, intake = sampleIntake()): Promise<Response> {
  return h.post('/v1/testing/intake', { email, intake });
}

/** The sign-in token from the most recent intake email to `to`. */
function intakeToken(to: string): string {
  const mail = h.email.latest(to, /#t=/);
  expect(mail.text).toContain('r=%2Ftesting'); // lands back on the testing pages
  return /#t=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
}

describe('public intake (no account)', () => {
  it('accepts a submission, emails a sign-in link, and keeps it invisible until the email is verified', async () => {
    const res = await publicSubmit();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain('Check your email');

    // No owned request exists yet — only the inbox row.
    const store = new TestingStore(h.db);
    expect(await store.countPendingInbox(h.now())).toBe(1);
    expect(await h.db.get('SELECT id FROM testing_requests')).toBeNull();

    // The operator queue shows the pending-verification count.
    const op = await setupOperator(h);
    const queue = (await (await h.get('/v1/owner/admin/testing/queue', op.cookie)).json()) as {
      intake_review: unknown[]; awaiting_email_verification: number;
    };
    expect(queue.awaiting_email_verification).toBe(1);
    expect(queue.intake_review).toHaveLength(0);
  });

  it('adopts the submission into a submitted request when the new email signs in as a buyer, and alerts the operator once', async () => {
    await publicSubmit();
    const token = intakeToken(EMAIL);

    // The emailed link finishes on /start: a brand-new address gets a start
    // code, and the console's testing return path takes the BUYER branch.
    const finish = await h.post('/v1/owner/start/finish', { token });
    expect(finish.status).toBe(200);
    const finishBody = (await finish.json()) as { has_account: boolean; start_code?: string };
    expect(finishBody.has_account).toBe(false);
    const buyer = await h.post('/v1/owner/start/buyer', { start_code: finishBody.start_code });
    expect(buyer.status).toBe(200);
    const cookie = sessionCookieOf(buyer);

    // Landing on the testing pages lists requests → adoption.
    const list = (await (await h.get('/v1/owner/testing/requests', cookie)).json()) as {
      requests: Array<{ id: string; status: string; intake: { product_name: string } }>;
    };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0].status).toBe('submitted');
    expect(list.requests[0].intake.product_name).toBe(sampleIntake().product_name);

    // Idempotent under reloads: still exactly one request, inbox claimed.
    const again = (await (await h.get('/v1/owner/testing/requests', cookie)).json()) as { requests: unknown[] };
    expect(again.requests).toHaveLength(1);
    const store = new TestingStore(h.db);
    expect(await store.countPendingInbox(h.now())).toBe(0);

    // Exactly one operator alert for the adopted request.
    const alerts = await h.db.all<{ semantic_key: string; recipient: string }>(
      `SELECT semantic_key, recipient FROM testing_notifications WHERE kind = 'request_submitted'`,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].semantic_key).toBe(`op:submitted:${list.requests[0].id}:v1`);
    expect(alerts[0].recipient).toBe('ops@example.com');

    // And it lands in the operator queue as ordinary intake review.
    const op = await setupOperator(h);
    const queue = (await (await h.get('/v1/owner/admin/testing/queue', op.cookie)).json()) as {
      intake_review: Array<{ id: string }>; awaiting_email_verification: number;
    };
    expect(queue.intake_review.map((r) => r.id)).toEqual([list.requests[0].id]);
    expect(queue.awaiting_email_verification).toBe(0);
  });

  it('adopts into an EXISTING account on its next visit — and never touches its Keyring shape', async () => {
    const buyer = await signupBuyer(h, 'returning@example.com');
    await publicSubmit('Returning@Example.com'); // case-insensitive match

    const list = (await (await h.get('/v1/owner/testing/requests', buyer.cookie)).json()) as {
      requests: Array<{ status: string }>;
    };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0].status).toBe('submitted');

    const me = (await (await h.get('/v1/owner/me', buyer.cookie)).json()) as { delegations: unknown[]; vault_key: unknown };
    expect(me.delegations).toEqual([]);
    expect(me.vault_key).toBeNull();
  });

  it('rejects invalid payloads, secret material, and unverifiable emails without creating anything', async () => {
    const badEmail = await h.post('/v1/testing/intake', { email: 'not-an-email', intake: sampleIntake() });
    expect(badEmail.status).toBe(422);
    const secret = await publicSubmit(EMAIL, sampleIntake({
      known_constraints: 'use api key sk_live_ABCDEFGHIJKLMNOPQRSTUV to authenticate',
    }));
    expect(secret.status).toBe(422);
    expect(((await secret.json()) as { message: string }).message).not.toContain('ABCDEFGHIJKLMNOPQRSTUV');
    const badShape = await h.post('/v1/testing/intake', { email: EMAIL, intake: { nope: true } });
    expect(badShape.status).toBe(422);
    expect(await new TestingStore(h.db).countPendingInbox(h.now())).toBe(0);
    expect(h.email.messages).toHaveLength(0);
  });

  it('caps unclaimed submissions per address', async () => {
    for (let i = 0; i < 3; i++) expect((await publicSubmit()).status).toBe(200);
    const fourth = await publicSubmit();
    expect(fourth.status).toBe(429);
    expect(((await fourth.json()) as { message: string }).message).toContain('awaiting sign-in');
  });

  it('expires stale inbox rows via the jobs sweep instead of adopting them', async () => {
    await publicSubmit();
    await h.db.run(`UPDATE testing_intake_inbox SET expires_at = '2000-01-01T00:00:00.000Z'`);

    const summary = await h.runJobs();
    expect(summary.intake_inbox_expired).toBe(1);

    // A later sign-in with that email adopts nothing.
    const buyer = await signupBuyer(h, EMAIL);
    const list = (await (await h.get('/v1/owner/testing/requests', buyer.cookie)).json()) as { requests: unknown[] };
    expect(list.requests).toHaveLength(0);
  });

  it('quote-ready email deep-links the request page (never the routeless /testing/orders)', async () => {
    const buyer = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string; version: number } }).request;
    expect((await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: request.version }, buyer.cookie)).status).toBe(200);

    const op = await setupOperator(h);
    const scope = sampleScope();
    const deliveryTarget = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const signed = await operatorSign(h, op, 'testing.approve_quote', approveQuoteParams(request.id, 1, scope, deliveryTarget));
    expect((await h.post(`/v1/owner/admin/testing/requests/${request.id}/approve-quote`, {
      request_version: 1, scope, delivery_target_at: deliveryTarget, checklist_confirmed: true, ...signed,
    }, op.cookie)).status).toBe(200);

    const note = await h.db.get<{ body: string }>(
      `SELECT body FROM testing_notifications WHERE kind = 'quote_ready'`,
    );
    expect(note?.body).toContain(`/testing/requests/${request.id}`);
    expect(note?.body).not.toMatch(/\/testing\/orders(\s|$)/m);
  });

  it('alerts the operator on authenticated submissions too', async () => {
    const buyer = await signupBuyer(h);
    const created = await h.post('/v1/owner/testing/requests', sampleIntake(), buyer.cookie);
    const request = ((await created.json()) as { request: { id: string; version: number } }).request;
    expect((await h.post(`/v1/owner/testing/requests/${request.id}/submit`, { expected_version: request.version }, buyer.cookie)).status).toBe(200);

    const alerts = await h.db.all<{ semantic_key: string }>(
      `SELECT semantic_key FROM testing_notifications WHERE kind = 'request_submitted'`,
    );
    expect(alerts.map((a) => a.semantic_key)).toEqual([`op:submitted:${request.id}:v${request.version}`]);

    // Delivery rides the ordinary notification job.
    await h.runJobs();
    expect(h.email.latest('ops@example.com', /submitted for scope review/).subject).toContain('[testing-ops]');
  });
});
