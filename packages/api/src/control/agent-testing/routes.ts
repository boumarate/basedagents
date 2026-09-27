/**
 * Agent Testing — public catalog, customer service-order routes, worker brief.
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * Customer actions here are bounded service-order actions (spec §5.1): they
 * ride the authenticated owner session (httpOnly, SameSite=Strict) plus an
 * explicit Origin allowlist check on every mutation — a TESTING-ONLY policy
 * that does not loosen any existing credential/delegation/task ceremony.
 * Tenant isolation: every resource is owner-checked server-side; not-yours
 * answers 404. Reports and exports are `Cache-Control: private, no-store`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../types/index.js';
import { ownerSession } from '../routes.js';
import { ControlStore } from '../store.js';
import { agentAuth } from '../../middleware/auth.js';
import { checkRateLimit } from '../../lib/rate-limiter.js';
import { rpConfig } from '../config.js';
import { consoleOrigin, emailSenderFromEnv, type EmailSender } from '../email.js';
import { base64urlEncode } from '../webauthn.js';
import { queueOperatorNotification } from './notify.js';
import { TestingStore, type OrderRow, type QuoteRow, type RequestRow } from './store.js';
import {
  IntakeSchema, intakeSecretFindings, QuoteScopeSchema, sha256hex, WORKER_RESULT_JSON_SCHEMA, WorkerBriefSchema,
} from './schemas.js';
import { activePackage, checkoutDisabledReason, retentionDays, supportEmail, testingFlags } from './catalog.js';
import { startCheckout, testingStripeFor } from './checkout.js';
import { parseReportRow, renderReportMarkdown } from './reports.js';

type Ctx = Context<AppEnv>;

function getOwnerId(c: Ctx): string {
  return (c.get as (k: string) => string)('ownerId');
}

function getStore(c: Ctx): TestingStore {
  return new TestingStore(c.get('db'));
}

function requestId(c: Ctx): string {
  return c.req.header('CF-Ray') ?? c.res.headers.get('X-Request-Id') ?? crypto.randomUUID();
}

function err(c: Ctx, status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 503, error: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, message, request_id: requestId(c), ...extra }, status);
}

async function readJson(c: Ctx): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text.length > 128 * 1024) return { ok: false };
  try {
    return { ok: true, body: text.trim() ? JSON.parse(text) : {} };
  } catch {
    return { ok: false };
  }
}

/** Product flag gate: disabled product → routes do not exist. */
function productEnabled(c: Ctx): boolean {
  return testingFlags(c.env).productEnabled;
}

/**
 * Origin allowlist for state-changing customer calls (testing-only policy,
 * spec §5.1). Browsers always send Origin on cross-site and same-site POSTs
 * with fetch; non-browser clients (tests, curl with the cookie) may omit it.
 */
function originAllowed(c: Ctx): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true;
  return rpConfig(c.env).origins.includes(origin);
}

function emailConfiguredFor(c: Ctx): boolean {
  // A deployment without a real provider cannot deliver purchase email —
  // checkout is then disabled (spec §16). Tests inject a recording sender;
  // E2E/dev may explicitly allow the log-only sender.
  const injected = (c.get as (k: string) => unknown)('emailSender');
  if (injected) return true;
  const e = (c.env ?? {}) as Record<string, string | undefined>;
  return !!e.RESEND_API_KEY || e.TESTING_ALLOW_LOG_EMAIL === '1' || e.E2E === '1';
}

const app = new Hono<AppEnv>();

// ─── public catalog (mounted at /v1/testing) ───

app.get('/catalog', async (c) => {
  const flags = testingFlags(c.env);
  const pkg = activePackage(c.env);
  const store = getStore(c);
  if (!flags.productEnabled) {
    return c.json({
      available: false,
      message: 'Agent testing is not available on this deployment yet.',
    });
  }
  // Published coverage: operator-reviewed eligibility only; labels, never
  // identities or capacity counts (spec §4.1.6).
  let coverage: Array<{ client: string; transport: string }> = [];
  try {
    const rows = await store.listApprovedEligibility(new Date().toISOString());
    const seen = new Set<string>();
    for (const row of rows.filter((r) => r.provenance === 'operator_reviewed')) {
      for (const env of JSON.parse(row.environments_json) as Array<{ client?: string; transport?: string }>) {
        const key = `${(env.client ?? '').toLowerCase()}|${(env.transport ?? '').toLowerCase()}`;
        if (env.client && env.transport && !seen.has(key)) {
          seen.add(key);
          coverage.push({ client: env.client, transport: env.transport });
        }
      }
    }
    coverage = coverage.slice(0, 20);
  } catch {
    coverage = [];
  }
  const disabled = checkoutDisabledReason(c.env, {
    emailConfigured: emailConfiguredFor(c),
    stripeConfigured: testingStripeFor(c) !== null,
  });
  await store.metricEvent('testing_page_viewed');
  return c.json({
    available: true,
    checkout_available: disabled === null,
    checkout_unavailable_reason: disabled,
    package: {
      package_key: pkg.package_key,
      package_version: pkg.package_version,
      currency: pkg.currency,
      price_cents: pkg.price_cents,
      billing: pkg.billing,
      workflows: pkg.workflows,
      external_runs: pkg.initial_external_run_slots,
      internal_baseline_runs: pkg.internal_baseline_runs,
      included_targeted_retests: pkg.included_targeted_retest_slots,
      retest_request_window_days: pkg.retest_request_window_days,
      quote_validity_days: pkg.quote_validity_days,
      minimum_distinct_operator_groups: pkg.minimum_distinct_operator_groups,
      minimum_distinct_environment_fingerprints: pkg.minimum_distinct_environment_fingerprints,
    },
    coverage: {
      environments: coverage,
      note: coverage.length >= pkg.minimum_distinct_environment_fingerprints
        ? 'Coverage reflects operator-reviewed environments available today.'
        : 'Coverage is being established: request a scoped agent compatibility audit and we will confirm before you pay.',
    },
    disclosures: {
      terms_version: activePackage(c.env).terms_version,
      disclosure_version: activePackage(c.env).disclosure_version,
      worker_disclosure: 'Approved test materials (workflow, documentation links, synthetic fixture) are shared with the independent operators who execute assignments.',
      no_guarantee: 'You buy observed execution and a reviewed report — not a favorable verdict, certification, or universal compatibility claim.',
      retention: `Execution evidence is retained ${retentionDays(c.env).evidence} days after the final report; reports ${retentionDays(c.env).reports} days.`,
    },
    support_email: supportEmail(c.env),
  });
});

/** The worker result contract as JSON Schema (public, versioned). */
app.get('/schemas/worker-result-1.0.json', (c) =>
  c.json(WORKER_RESULT_JSON_SCHEMA, 200, { 'Cache-Control': 'public, max-age=3600' }));

// ─── public intake (no account; every request is operator-reviewed) ───
//
// The form asks for an email instead of a sign-in: the payload lands in the
// pre-auth inbox (migration 0043) and a sign-in magic link goes to that
// address — the same 'start' token the /start door mints, landing on
// /start#t=…&r=/testing so the console returns the verified visitor straight
// to their audit status page. Adoption into a real owned request happens the
// moment that owner loads their testing pages (adoptPublicIntake below). An
// unverified email never creates an account or a reviewable request.

/** Same resolution order as the ladder: injected → E2E outbox → env. */
function publicEmailSender(c: Ctx): EmailSender {
  const injected = (c.get as (k: string) => EmailSender | undefined)('emailSender');
  if (injected) return injected;
  if (((c.env ?? {}) as Record<string, string | undefined>).E2E === '1') {
    const store = new ControlStore(c.get('db'));
    return { send: async (m) => store.appendTestOutbox(m.to, m.subject, m.text) };
  }
  return emailSenderFromEnv(c.env);
}

const PublicIntakeBody = z.object({ email: z.string().email().max(320), intake: IntakeSchema }).strict();
const INBOX_TTL_DAYS = 14;
const INBOX_PENDING_PER_EMAIL_MAX = 3;
const START_LINK_TTL_SECONDS = 900; // matches the ladder's magic-link TTL

app.post('/intake', async (c) => {
  if (!productEnabled(c)) return err(c, 404, 'not_found', 'Not found');
  if (!originAllowed(c)) return err(c, 403, 'forbidden', 'Cross-origin request refused');
  const db = c.get('db');
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = PublicIntakeBody.safeParse(json.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return err(c, 422, 'validation_failed', `Intake invalid at ${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'}`, { details: parsed.error.flatten() });
  }
  const secrets = intakeSecretFindings(parsed.data.intake);
  if (secrets.length > 0) {
    return err(c, 422, 'secret_material_rejected',
      `The intake appears to contain secret material (${secrets.join(', ')}). Remove all credentials — tests never use customer secrets.`);
  }
  const email = parsed.data.email.trim().toLowerCase();

  // Abuse brakes on an unauthenticated write that also sends email: a global
  // cap, a per-address cap, and a ceiling on unclaimed submissions per
  // address. Responses stay uniform about ACCOUNTS (nothing here reveals
  // whether an address has one); the 429s only describe the caller's own volume.
  const global = await checkRateLimit(db, 'testing:pubintake:global', 200, 3_600_000);
  if (!global.allowed) return err(c, 429, 'rate_limited', 'Too many requests right now — please try again in a little while.');
  const per = await checkRateLimit(db, `testing:pubintake:${sha256hex(email)}`, 5, 3_600_000);
  if (!per.allowed) return err(c, 429, 'rate_limited', 'Too many submissions for this email this hour. Use the sign-in link we already sent.');

  const store = getStore(c);
  const now = new Date().toISOString();
  if ((await store.countPendingInboxByEmail(email, now)) >= INBOX_PENDING_PER_EMAIL_MAX) {
    return err(c, 429, 'rate_limited', 'You already have submissions awaiting sign-in. Click the link we emailed you — they attach to your account the moment you sign in.');
  }

  const row = await store.createInboxSubmission({ email, intakeJson: JSON.stringify(parsed.data.intake), ttlDays: INBOX_TTL_DAYS });

  const controlStore = new ControlStore(db);
  const owner = await controlStore.getOwnerByEmail(email);
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = base64urlEncode(tokenBytes);
  await controlStore.createMagicLinkToken({
    tokenHash: sha256hex(token),
    purpose: 'start',
    email,
    ownerId: owner?.id, // resolved at finish for a first-time address
    ttlSeconds: START_LINK_TTL_SECONDS,
  });
  await publicEmailSender(c).send({
    to: email,
    subject: 'Your audit request was received — sign in to track it',
    text:
      `We received your agent compatibility audit request. An operator reviews every request ` +
      `and confirms coverage and an exact price before any payment is requested — nothing has been charged.\n\n` +
      `Click within 15 minutes to sign in and see its status:\n\n` +
      `${consoleOrigin(c.env)}/start#t=${token}&r=%2Ftesting\n\n` +
      `Your request attaches to your account the moment you sign in with this address. ` +
      `Link expired? Request a fresh one at ${consoleOrigin(c.env)}/start using the same email.\n\n` +
      `If you didn't submit this, ignore this email — nothing happens without this link.`,
  });
  await store.metricEvent('public_intake_submitted', { requestId: row.requestId });
  return c.json({
    ok: true,
    message: 'Check your email — we sent a sign-in link. Your request is attached to your account the moment you sign in; an operator reviews it and confirms coverage before any payment.',
  });
});

// ─── worker private brief (agent-authenticated; spec §7.3, §5.4) ───

app.get('/assignments/:taskId/brief', agentAuth, async (c) => {
  if (!productEnabled(c)) return err(c, 404, 'not_found', 'Not found');
  const agentId = (c.get as (k: string) => string)('agentId');
  const taskId = c.req.param('taskId');
  const db = c.get('db');
  const store = getStore(c);

  const attempt = await store.getAttemptByTask(taskId);
  if (!attempt || !attempt.active) return err(c, 404, 'not_found', 'No such assignment');
  // The CURRENT claimant only — rechecked on every request; a cancelled or
  // reassigned claim revokes access immediately.
  const task = await db.get<{ claimed_by_agent_id: string | null; status: string }>(
    'SELECT claimed_by_agent_id, status FROM tasks WHERE task_id = ?', taskId,
  );
  if (!task || task.claimed_by_agent_id !== agentId || !['claimed', 'submitted'].includes(task.status)) {
    return err(c, 404, 'not_found', 'No such assignment');
  }
  const eligibility = await store.getEligibility(agentId);
  const nowIso = new Date().toISOString();
  if (!eligibility || eligibility.status !== 'approved' || (eligibility.expires_at && eligibility.expires_at <= nowIso)) {
    return err(c, 403, 'worker_ineligible', 'Your testing eligibility is not active for this assignment.');
  }
  const run = await store.getRun(attempt.run_id);
  if (!run) return err(c, 404, 'not_found', 'No such assignment');
  const brief = WorkerBriefSchema.parse(JSON.parse(attempt.brief_json));
  if (brief.scope_hash !== run.scope_hash) {
    return err(c, 409, 'scope_changed', 'The assignment scope changed; contact the platform before executing.');
  }
  return c.json({
    brief,
    result_contract: 'https://api.basedagents.ai/v1/testing/schemas/worker-result-1.0.json',
    submit: `POST /v1/tasks/${taskId}/deliver with submission_type "json" and the worker-result document as submission_content`,
  }, 200, { 'Cache-Control': 'private, no-store' });
});

export const testingPublicRoutes = app;

// ─── customer routes (mounted at /v1/owner/testing) ───

const customer = new Hono<AppEnv>();

/** Session + product flag + origin gate for every customer route. */
customer.use('*', async (c, next) => {
  if (!productEnabled(c)) return err(c, 404, 'not_found', 'Not found');
  if (c.req.method !== 'GET' && !originAllowed(c)) {
    return err(c, 403, 'forbidden', 'Cross-origin request refused');
  }
  return ownerSession(c, next);
});

const CUSTOMER_WRITE_HOURLY = { max: 30, windowMs: 3_600_000 } as const;

async function writeLimit(c: Ctx, ownerId: string): Promise<Response | null> {
  const limit = await checkRateLimit(c.get('db'), `testing:owner:${ownerId}`, CUSTOMER_WRITE_HOURLY.max, CUSTOMER_WRITE_HOURLY.windowMs);
  if (!limit.allowed) return err(c, 429, 'rate_limited', 'Too many testing requests this hour. Please slow down.');
  return null;
}

// ── intake drafts ──

customer.post('/requests', async (c) => {
  const ownerId = getOwnerId(c);
  const limited = await writeLimit(c, ownerId);
  if (limited) return limited;
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = IntakeSchema.safeParse(json.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return err(c, 422, 'validation_failed', `Intake invalid at ${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'}`, { details: parsed.error.flatten() });
  }
  const secrets = intakeSecretFindings(parsed.data);
  if (secrets.length > 0) {
    return err(c, 422, 'secret_material_rejected',
      `The intake appears to contain secret material (${secrets.join(', ')}). Remove all credentials — tests never use customer secrets.`);
  }
  const store = getStore(c);
  const row = await store.createRequest({ ownerId, intakeJson: JSON.stringify(parsed.data) });
  await store.metricEvent('intake_started', { requestId: row.id });
  return c.json({ request: shapeRequest(row) });
});

/**
 * Attach any verified-email public submissions to this owner (idempotent;
 * safe under races via the pre-minted request id). Runs on the list the
 * testing pages land on, so a fresh sign-in from the intake email sees the
 * request immediately — and it must never break the list itself.
 */
async function adoptPublicIntake(c: Ctx, store: TestingStore, ownerId: string): Promise<void> {
  try {
    const owner = await new ControlStore(c.get('db')).getOwner(ownerId);
    if (!owner?.email) return;
    const now = new Date().toISOString();
    for (const row of await store.listPendingInboxByEmail(owner.email, now)) {
      if (!(await store.adoptInboxRow(row, ownerId, now))) continue;
      await store.metricEvent('intake_submitted', { requestId: row.request_id });
      await queueOperatorNotification(store, c.env, {
        semanticKey: `op:submitted:${row.request_id}:v1`,
        kind: 'request_submitted',
        orderId: null,
        subject: 'New audit request submitted',
        body: `Request ${row.request_id} was submitted for scope review (email-verified public intake).`,
      });
    }
  } catch {
    // adoption is a convenience pass — pending rows stay for the next load
  }
}

customer.get('/requests', async (c) => {
  const store = getStore(c);
  await adoptPublicIntake(c, store, getOwnerId(c));
  const rows = await store.listRequestsByOwner(getOwnerId(c));
  const out = [];
  for (const row of rows) {
    const quote = await store.getQuoteForRequest(row.id);
    out.push({ ...shapeRequest(row), quote: quote ? shapeQuote(quote) : null });
  }
  return c.json({ requests: out });
});

customer.get('/requests/:id', async (c) => {
  const store = getStore(c);
  const row = await store.getOwnRequest(c.req.param('id'), getOwnerId(c));
  if (!row) return err(c, 404, 'not_found', 'Request not found');
  const quote = await store.getQuoteForRequest(row.id);
  const order = quote ? await store.getOrderByQuote(quote.id) : null;
  return c.json({ request: shapeRequest(row), quote: quote ? shapeQuote(quote) : null, order_id: order?.id ?? null });
});

customer.patch('/requests/:id', async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = z.object({ expected_version: z.number().int().min(1), intake: IntakeSchema }).strict().safeParse(json.body);
  if (!body.success) {
    const first = body.error.issues[0];
    return err(c, 422, 'validation_failed', `Invalid at ${first?.path.join('.') || 'root'}: ${first?.message ?? 'invalid'}`, { details: body.error.flatten() });
  }
  const secrets = intakeSecretFindings(body.data.intake);
  if (secrets.length > 0) {
    return err(c, 422, 'secret_material_rejected', `The intake appears to contain secret material (${secrets.join(', ')}).`);
  }
  const row = await store.getOwnRequest(c.req.param('id'), ownerId);
  if (!row) return err(c, 404, 'not_found', 'Request not found');
  const updated = await store.updateRequestIntake(row.id, ownerId, body.data.expected_version, JSON.stringify(body.data.intake));
  if (!updated) {
    return err(c, 409, 'version_conflict', 'The request changed since you loaded it (or is no longer editable). Reload and try again.');
  }
  // An edit invalidates any approved quote for the old version (spec §4.4).
  const quote = await store.getQuoteForRequest(row.id);
  if (quote && quote.status === 'approved') await store.supersedeQuote(quote.id, 'superseded');
  return c.json({ request: shapeRequest((await store.getRequest(row.id))!) });
});

customer.post('/requests/:id/submit', async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = z.object({ expected_version: z.number().int().min(1) }).strict().safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'expected_version required');
  const row = await store.getOwnRequest(c.req.param('id'), ownerId);
  if (!row) return err(c, 404, 'not_found', 'Request not found');
  if (!(await store.submitRequest(row.id, ownerId, body.data.expected_version))) {
    return err(c, 409, 'version_conflict', 'The request changed or is not in a submittable state.');
  }
  await store.metricEvent('intake_submitted', { requestId: row.id });
  await queueOperatorNotification(store, c.env, {
    semanticKey: `op:submitted:${row.id}:v${body.data.expected_version}`,
    kind: 'request_submitted',
    orderId: null,
    subject: 'New audit request submitted',
    body: `Request ${row.id} was submitted for scope review.`,
  });
  return c.json({
    request: shapeRequest((await store.getRequest(row.id))!),
    acknowledgment: 'No payment has been taken. We will confirm coverage before you pay.',
  });
});

// ── quotes ──

customer.post('/quotes/:id/change-request', async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = z.object({ note: z.string().min(1).max(2000) }).strict().safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'a note describing the change is required');
  const quote = await store.getQuote(c.req.param('id'));
  if (!quote) return err(c, 404, 'not_found', 'Quote not found');
  const request = await store.getOwnRequest(quote.request_id, ownerId);
  if (!request) return err(c, 404, 'not_found', 'Quote not found');
  if (!(await store.supersedeQuote(quote.id, 'withdrawn'))) {
    return err(c, 409, 'invalid_state', 'This quote can no longer be changed.');
  }
  await c.get('db').run(
    `UPDATE testing_requests SET status = 'needs_changes', operator_note = ?, updated_at = ? WHERE id = ?`,
    `customer change request: ${body.data.note}`.slice(0, 2000), new Date().toISOString(), request.id,
  );
  await store.audit({ actor: `owner:${ownerId}`, action: 'quote_change_requested', objectKind: 'quote', objectId: quote.id, reason: body.data.note.slice(0, 300) });
  return c.json({ ok: true, request: shapeRequest((await store.getRequest(request.id))!) });
});

const CheckoutBody = z.object({
  quote_version: z.number().int().min(1),
  scope_hash: z.string().min(1),
  terms_version: z.string().min(1),
  disclosure_version: z.string().min(1),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_\-:.]{8,64}$/),
}).strict();

customer.post('/quotes/:id/checkout', async (c) => {
  const ownerId = getOwnerId(c);
  const limited = await writeLimit(c, ownerId);
  if (limited) return limited;
  const store = getStore(c);
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = CheckoutBody.safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'checkout body must carry quote version, scope hash, disclosure versions and an idempotency key — nothing else');
  const quote = await store.getQuote(c.req.param('id'));
  if (!quote) return err(c, 404, 'not_found', 'Quote not found');
  const request = await store.getOwnRequest(quote.request_id, ownerId);
  if (!request) return err(c, 404, 'not_found', 'Quote not found');
  if (body.data.quote_version !== quote.request_version) {
    return err(c, 409, 'scope_changed', 'The quote was revised since you reviewed it.');
  }
  const result = await startCheckout({
    store,
    controlStore: new ControlStore(c.get('db')),
    stripe: testingStripeFor(c),
    env: c.env,
    emailConfigured: emailConfiguredFor(c),
    ownerId,
    quote,
    acceptedScopeHash: body.data.scope_hash,
    acceptedTermsVersion: body.data.terms_version,
    acceptedDisclosureVersion: body.data.disclosure_version,
    idempotencyKey: body.data.idempotency_key,
  });
  if (!result.ok) return err(c, result.status, result.error, result.message);
  return c.json({ checkout_url: result.url, order_id: result.orderId, reused: result.reused });
});

// ── orders ──

customer.get('/orders', async (c) => {
  const store = getStore(c);
  const before = c.req.query('before') || undefined;
  const rows = await store.listOrdersByOwner(getOwnerId(c), 25, before);
  const out = [];
  for (const order of rows) out.push(await shapeOrderForCustomer(store, order));
  return c.json({
    orders: out,
    next_before: rows.length === 25 ? rows[rows.length - 1].created_at : null,
  });
});

customer.get('/orders/:id', async (c) => {
  const store = getStore(c);
  const order = await store.getOwnOrder(c.req.param('id'), getOwnerId(c));
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  return c.json({ order: await shapeOrderForCustomer(store, order, true) }, 200, { 'Cache-Control': 'private, no-store' });
});

customer.post('/orders/:id/cancel-request', async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = z.object({ reason: z.string().max(2000).optional() }).strict().safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'validation failed');
  const order = await store.getOwnOrder(c.req.param('id'), ownerId);
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  await store.recordCancelRequest(order.id, ownerId, body.data.reason ?? null);
  await store.audit({ actor: `owner:${ownerId}`, action: 'cancel_requested', objectKind: 'order', objectId: order.id, reason: body.data.reason ?? null });
  return c.json({ ok: true, message: 'Cancellation requested. An operator reviews it — no refund has been issued yet.' });
});

customer.post('/orders/:id/retest-request', async (c) => {
  const ownerId = getOwnerId(c);
  const limited = await writeLimit(c, ownerId);
  if (limited) return limited;
  const store = getStore(c);
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = z.object({
    finding_id: z.string().min(1).max(64),
    change_description: z.string().min(1).max(2000),
    updated_target: z.string().min(1).max(500),
  }).strict().safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'finding_id, change_description and updated_target are required');
  const order = await store.getOwnOrder(c.req.param('id'), ownerId);
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  const nowIso = new Date().toISOString();
  if (!order.initial_report_published_at) {
    return err(c, 409, 'retest_not_available', 'The retest entitlement starts when your initial report is published.');
  }
  if (!order.retest_deadline_at || order.retest_deadline_at <= nowIso) {
    return err(c, 409, 'retest_not_available', 'The retest window for this order has expired.');
  }
  const quote = await store.getQuote(order.quote_id);
  if (!quote || quote.retest_slots < 1) return err(c, 409, 'retest_not_available', 'This package includes no retest.');
  const runs = await store.listRuns(order.id);
  if (runs.some((r) => r.kind === 'retest')) {
    return err(c, 409, 'retest_not_available', 'The included retest for this order has already been requested.');
  }
  // The referenced finding must exist in the published report, and the retest
  // reuses the affected run's environment (targeted, not a new workflow).
  const report = await store.getLatestPublishedReport(order.id);
  if (!report) return err(c, 409, 'retest_not_available', 'No published report found.');
  const doc = parseReportRow(report);
  const finding = doc.findings.find((f) => f.finding_id === body.data.finding_id);
  if (!finding) return err(c, 404, 'not_found', 'That finding is not in your report.');
  const affectedRun = runs.find((r) => finding.affected_run_ids.includes(r.id));
  if (!affectedRun) return err(c, 409, 'retest_not_available', 'The finding does not reference a retestable run.');

  const run = await store.createRun({
    orderId: order.id,
    kind: 'retest',
    slot: 1,
    scopeHash: quote.scope_hash,
    environmentJson: affectedRun.environment_json,
    parentFindingId: finding.finding_id,
    parentRunId: affectedRun.id,
  });
  await store.enqueueOperation({
    kind: 'retest_request',
    semanticKey: `retest-req:${order.id}`,
    orderId: order.id,
    payloadJson: JSON.stringify({ ...body.data, run_id: run?.id ?? null, requested_at: nowIso }),
  });
  await store.metricEvent('retest_requested', { orderId: order.id });
  await store.audit({ actor: `owner:${ownerId}`, action: 'retest_requested', objectKind: 'order', objectId: order.id, reason: `finding ${finding.finding_id}` });
  return c.json({ ok: true, run_id: run?.id ?? null, message: 'Retest requested. An operator confirms it is a targeted retest before any work is published.' });
});

customer.post('/orders/:id/repeat', async (c) => {
  const ownerId = getOwnerId(c);
  const limited = await writeLimit(c, ownerId);
  if (limited) return limited;
  const store = getStore(c);
  const order = await store.getOwnOrder(c.req.param('id'), ownerId);
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  const request = await store.getRequest(order.request_id);
  if (!request) return err(c, 404, 'not_found', 'Original request not found');
  // Copies non-secret inputs into a NEW draft: no consent reuse, no charge,
  // no publication; a fresh quote and checkout are required (spec §17.2).
  const draft = await store.createRequest({
    ownerId,
    intakeJson: request.intake_json,
    source: request.source as 'external_customer' | 'founder_sample' | 'test_fixture',
    previousOrderId: order.id,
  });
  await store.metricEvent('repeat_audit_requested', { orderId: order.id, requestId: draft.id });
  return c.json({ request: shapeRequest(draft), message: 'A new draft was created from your previous scope. Review it, submit, and approve the fresh quote — nothing is charged until you pay the new checkout.' });
});

customer.post('/orders/:id/feedback', async (c) => {
  const ownerId = getOwnerId(c);
  const store = getStore(c);
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const body = z.object({
    useful: z.enum(['yes', 'partial', 'no']).optional(),
    action_taken: z.string().max(2000).optional(),
    incremental: z.enum(['baseline_only', 'external_only', 'both', 'none', 'unsure']).optional(),
    comment: z.string().max(4000).optional(),
  }).strict().safeParse(json.body);
  if (!body.success) return err(c, 400, 'bad_request', 'validation failed');
  const order = await store.getOwnOrder(c.req.param('id'), ownerId);
  if (!order) return err(c, 404, 'not_found', 'Order not found');
  await store.addFeedback({
    orderId: order.id, ownerId,
    useful: body.data.useful ?? null,
    actionTaken: body.data.action_taken ?? null,
    incremental: body.data.incremental ?? null,
    comment: body.data.comment ?? null,
  });
  await store.metricEvent('feedback_submitted', { orderId: order.id });
  return c.json({ ok: true });
});

// ── reports ──

async function loadOwnPublishedReport(c: Ctx, store: TestingStore): Promise<{ report: ReturnType<typeof parseReportRow>; row: NonNullable<Awaited<ReturnType<TestingStore['getReport']>>> } | Response> {
  const row = await store.getReport(c.req.param('id') ?? '');
  if (!row || row.status !== 'published') return err(c, 404, 'not_found', 'Report not found');
  const order = await store.getOwnOrder(row.order_id, getOwnerId(c));
  if (!order) return err(c, 404, 'not_found', 'Report not found');
  return { report: parseReportRow(row), row };
}

customer.get('/reports/:id', async (c) => {
  const store = getStore(c);
  const loaded = await loadOwnPublishedReport(c, store);
  if (loaded instanceof Response) return loaded;
  await store.metricEvent('report_viewed', { orderId: loaded.row.order_id });
  return c.json({ report: loaded.report, published_at: loaded.row.published_at }, 200, { 'Cache-Control': 'private, no-store' });
});

customer.get('/reports/:id/export', async (c) => {
  const store = getStore(c);
  const format = c.req.query('format') ?? 'json';
  if (format !== 'md' && format !== 'json') return err(c, 400, 'bad_request', 'format must be md or json');
  const loaded = await loadOwnPublishedReport(c, store);
  if (loaded instanceof Response) return loaded;
  await store.metricEvent('report_exported', { orderId: loaded.row.order_id });
  const safeName = `agent-testing-report-${loaded.row.order_id}-v${loaded.row.version}.${format}`.replace(/[^A-Za-z0-9._-]/g, '');
  const headers = {
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${safeName}"`,
  };
  if (format === 'md') {
    return c.body(renderReportMarkdown(loaded.report), 200, { ...headers, 'Content-Type': 'text/markdown; charset=utf-8' });
  }
  return c.body(JSON.stringify(loaded.report, null, 2), 200, { ...headers, 'Content-Type': 'application/json' });
});

export const testingCustomerRoutes = customer;

// ─── shapes (customer-safe serializations) ───

function shapeRequest(row: RequestRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    intake: JSON.parse(row.intake_json),
    operator_note: row.operator_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function shapeQuote(quote: QuoteRow): Record<string, unknown> {
  return {
    id: quote.id,
    request_id: quote.request_id,
    request_version: quote.request_version,
    status: quote.status,
    scope: QuoteScopeSchema.parse(JSON.parse(quote.scope_json)),
    scope_hash: quote.scope_hash,
    package_key: quote.package_key,
    package_version: quote.package_version,
    subtotal_cents: quote.subtotal_cents,
    currency: quote.currency,
    tax_mode: quote.tax_mode,
    external_run_slots: quote.external_run_slots,
    retest_slots: quote.retest_slots,
    retest_window_days: quote.retest_window_days,
    min_operator_groups: quote.min_operator_groups,
    terms_version: quote.terms_version,
    disclosure_version: quote.disclosure_version,
    delivery_target_at: quote.delivery_target_at,
    delivery_target_note: 'A target, not a guarantee.',
    expires_at: quote.expires_at,
    approved_at: quote.approved_at,
  };
}

/** Customer-readable stage (spec §4.5): "Testing" requires ACTIVE assignments, never payment alone. */
async function customerStage(store: TestingStore, order: OrderRow): Promise<{ stage: string; blocker: string | null }> {
  if (order.fulfillment_state === 'delivered') return { stage: 'Report ready', blocker: null };
  if (order.fulfillment_state === 'cancelled') return { stage: 'Cancelled', blocker: null };
  if (order.fulfillment_state === 'cannot_fulfill') return { stage: 'Blocked', blocker: 'We cannot fulfill the approved scope. Our team will contact you about an adjustment or refund.' };
  if (order.fulfillment_state === 'paused') return { stage: 'Paused', blocker: order.dispute_state === 'open' ? 'A payment dispute paused this order.' : 'This order is paused pending review.' };
  if (order.payment_state !== 'succeeded') {
    const attempts = await store.listCheckoutAttempts(order.id);
    const open = attempts.some((a) => ['creating', 'open'].includes(a.state));
    return open
      ? { stage: 'Payment confirmation', blocker: null }
      : { stage: 'Ready to purchase', blocker: order.payment_state === 'failed' ? 'The last payment attempt failed. You can try again.' : null };
  }
  if (order.fulfillment_state === 'reviewing') return { stage: 'Reviewing evidence', blocker: null };
  if (order.fulfillment_state === 'running') {
    // Only count runs with a genuinely active published/claimed assignment.
    const runs = await store.listRuns(order.id);
    for (const run of runs) {
      const attempt = await store.getActiveAttempt(run.id);
      if (attempt && ['published', 'claimed', 'submitted'].includes(attempt.state)) {
        return { stage: 'Testing', blocker: null };
      }
    }
    return { stage: 'Preparing tests', blocker: null };
  }
  return { stage: 'Preparing tests', blocker: null };
}

async function shapeOrderForCustomer(store: TestingStore, order: OrderRow, detailed = false): Promise<Record<string, unknown>> {
  const quote = await store.getQuote(order.quote_id);
  const { stage, blocker } = await customerStage(store, order);
  const runs = await store.listRuns(order.id);
  const external = runs.filter((r) => r.kind === 'external');
  // "3/3 complete" means three VALID REVIEWED initial runs (spec §4.5).
  const completed = external.filter((r) => ['product_success', 'product_failure'].includes(r.result_state)).length;
  const latestReport = await store.getLatestPublishedReport(order.id);
  const base: Record<string, unknown> = {
    id: order.id,
    stage,
    blocker,
    payment_state: order.payment_state,
    refund_state: order.refund_state,
    fulfillment_state: order.fulfillment_state,
    collected_cents: order.collected_cents,
    refunded_cents: order.refunded_cents,
    currency: quote?.currency ?? 'usd',
    delivery_target_at: quote?.delivery_target_at ?? null,
    external_runs_planned: quote?.external_run_slots ?? null,
    external_runs_complete: completed,
    report_id: latestReport?.id ?? null,
    report_version: latestReport?.version ?? null,
    retest_deadline_at: order.retest_deadline_at,
    cancel_requested_at: order.cancel_requested_at,
    created_at: order.created_at,
  };
  if (detailed && quote) {
    base.quote = shapeQuote(quote);
    base.runs = runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      slot: r.slot,
      environment: JSON.parse(r.environment_json),
      // Customer-safe result view; operator internals stay private.
      result: ['product_success', 'product_failure', 'inconclusive'].includes(r.result_state) ? r.result_state : 'in_progress',
    }));
    const retest = runs.find((r) => r.kind === 'retest');
    base.retest_requested = !!retest;
  }
  return base;
}
