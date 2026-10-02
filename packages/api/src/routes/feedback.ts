/**
 * POST /v1/feedback — tell the operator where the docs and the API disagree
 * (WS5, agent-first plan). The skill asks agents to send one whenever a
 * response contradicts the docs or a retry was needed.
 *
 * Auth is optional. A signed request (AgentSig) records the agent and gets a
 * roomier limit (30 an hour per agent); an anonymous one is allowed at 5 an
 * hour per IP. `Idempotency-Key` makes a retry return the first response
 * (reserved before the write, so concurrent retries can't file twice).
 * Free text is stored after secret redaction; identifier fields must match
 * strict formats.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { checkRateLimit } from '../lib/rate-limiter.js';
import { generatePublicId } from '../lib/ids.js';
import { redactSecrets } from '../lib/redact.js';
import { reserveIdempotent, completeIdempotentStatement, releaseIdempotent } from '../lib/idempotency.js';
import { sha256, bytesToHex } from '../crypto/index.js';
import { emailSenderFromEnv, type EmailSender } from '../control/email.js';
import { notifyFeedback, cleanVersion, type FeedbackRow } from '../feedback/service.js';

const feedback = new Hono<AppEnv>();

export const FEEDBACK_LIMITS = { anonymousPerHour: 5, agentPerHour: 30 } as const;

// Identifier-shaped fields get strict formats: they're relayed to email and
// Slack as-is, so they can't carry free text (or a pasted token) past redaction.
const ID = /^[A-Za-z0-9_\-]{1,64}$/;
const CODE = /^[A-Za-z0-9_.:\-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_.:\-]{1,128}$/;

export const FeedbackSchema = z.object({
  scope: z.enum(['task', 'general']),
  taskId: z.string().regex(ID).optional(),
  environment: z.string().min(1).max(1000),
  expectedBehavior: z.string().min(1).max(4000),
  actualBehavior: z.string().min(1).max(4000),
  stepsToReproduce: z.string().min(1).max(4000),
  errorCodes: z.array(z.string().regex(CODE)).max(20).optional(),
  requestIds: z.array(z.string().regex(REQUEST_ID)).max(20).optional(),
  suggestedImprovement: z.string().max(4000).optional(),
  skillVersion: z.string().min(1).max(32),
  cliVersion: z.string().max(32).optional(),
}).strict().refine((d) => d.scope !== 'task' || !!d.taskId, { message: 'taskId is required when scope is "task"', path: ['taskId'] });

/** AgentSig when an Authorization header is present (and then it must verify); anonymous otherwise. */
const optionalAgentAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header('Authorization')) return agentAuth(c, next);
  await next();
};

function emailSender(c: Context<AppEnv>): EmailSender {
  return (c.get as (k: string) => EmailSender | undefined)('emailSender') ?? emailSenderFromEnv(c.env);
}

/** Run after the response when the runtime allows it (Workers), inline otherwise (Node, tests). */
async function afterResponse(c: Context<AppEnv>, work: Promise<unknown>): Promise<void> {
  try {
    c.executionCtx.waitUntil(work.catch((err) => console.error('[feedback] background notify failed:', err)));
  } catch {
    await work.catch((err) => console.error('[feedback] notify failed:', err));
  }
}

feedback.post('/', optionalAgentAuth, async (c) => {
  const db = c.get('db');
  const agentId = (c.get as (k: string) => string | undefined)('agentId') ?? null;
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
  const ipBucket = bytesToHex(sha256(new TextEncoder().encode(`feedback:${ip}`))).slice(0, 16);
  const nowIso = new Date().toISOString();

  const raw = await c.req.text();
  const scope = agentId ?? `anon:${ipBucket}`;
  const idemKey = c.req.header('Idempotency-Key');
  const idem = await reserveIdempotent(db, scope, idemKey, raw, nowIso);
  if (idem.kind === 'invalid') return c.json({ error: 'bad_request', message: 'Idempotency-Key must be 8–128 characters of [A-Za-z0-9_-:.]' }, 400);
  if (idem.kind === 'conflict') return c.json({ error: 'idempotency_key_reused', message: 'This Idempotency-Key was already used with a different body' }, 422);
  if (idem.kind === 'in_progress') {
    c.header('Retry-After', '1');
    return c.json({ error: 'idempotency_in_progress', message: 'A request with this Idempotency-Key is still being processed; retry shortly' }, 409);
  }
  if (idem.kind === 'replay') {
    c.header('Idempotent-Replayed', 'true');
    return c.json(idem.body as Record<string, unknown>, idem.status as 201);
  }

  // After the replay check, so a client retrying a report it already filed
  // gets its response back instead of spending (or hitting) the limit.
  const limit = agentId
    ? await checkRateLimit(db, `feedback:agent:${agentId}`, FEEDBACK_LIMITS.agentPerHour, 3_600_000)
    : await checkRateLimit(db, `feedback:anon:${ipBucket}`, FEEDBACK_LIMITS.anonymousPerHour, 3_600_000);
  if (!limit.allowed) {
    await releaseIdempotent(db, scope, idemKey);
    c.header('Retry-After', String(Math.ceil((limit.retryAfterMs ?? 3_600_000) / 1000)));
    return c.json({ error: 'rate_limited', message: agentId ? 'Feedback limit reached for this agent; retry later.' : 'Anonymous feedback is limited per hour; sign the request for a higher limit.' }, 429);
  }

  let body: unknown;
  try { body = JSON.parse(raw); } catch { await releaseIdempotent(db, scope, idemKey); return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }
  const parsed = FeedbackSchema.safeParse(body);
  if (!parsed.success) {
    await releaseIdempotent(db, scope, idemKey);
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const d = parsed.data;

  const row: FeedbackRow = {
    feedback_id: generatePublicId('fb'),
    agent_id: agentId,
    scope: d.scope,
    task_id: d.taskId ?? null,
    environment: redactSecrets(d.environment),
    expected_behavior: redactSecrets(d.expectedBehavior),
    actual_behavior: redactSecrets(d.actualBehavior),
    steps_to_reproduce: redactSecrets(d.stepsToReproduce),
    error_codes: d.errorCodes?.length ? JSON.stringify(d.errorCodes) : null,
    request_ids: d.requestIds?.length ? JSON.stringify(d.requestIds) : null,
    suggested_improvement: d.suggestedImprovement ? redactSecrets(d.suggestedImprovement) : null,
    skill_version: cleanVersion(d.skillVersion) || null,
    cli_version: cleanVersion(d.cliVersion ?? c.req.header('X-BasedAgents-Cli-Version')) || null,
    user_agent: redactSecrets((c.req.header('User-Agent') ?? '').slice(0, 200)) || null,
    status: 'open',
    status_note: null,
    created_at: nowIso,
    updated_at: nowIso,
    email_notified_at: null,
    slack_notified_at: null,
    notified_at: null,
  };
  // The report and its stored idempotent response commit in one transaction:
  // either both land (a retry replays) or neither does (a retry files it).
  const response = { ok: true, feedback_id: row.feedback_id, status: row.status, anonymous: agentId === null, created_at: nowIso };
  const cols = Object.keys(row) as Array<keyof FeedbackRow>;
  const insert = { sql: `INSERT INTO feedback (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params: cols.map((k) => row[k]) };
  const complete = completeIdempotentStatement(scope, idemKey, 201, response);
  try {
    await db.batch(complete ? [insert, complete] : [insert]);
  } catch (err) {
    await releaseIdempotent(db, scope, idemKey);
    throw err;
  }
  await afterResponse(c, notifyFeedback(db, c.env ?? {}, emailSender(c), row, new Date().toISOString()));
  return c.json(response, 201);
});

export default feedback;
