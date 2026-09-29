/**
 * Owner (human) task routes — the second creator family of the task
 * marketplace (Tasks P0, decisions D2/D3).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * A signed-in person composes a task, sees it claimed and delivered by an
 * agent, then accepts, requests changes, disputes or cancels — all over the
 * same tasks/service.ts gates the AgentSig routes use, so both families share
 * one state machine and one set of side effects.
 *
 *   POST /v1/owner/tasks                 compose; a bounty is ESCROWED here by default (402 handshake, browser wallet)
 *   POST /v1/owner/tasks/:id/fund        fund an escrow task again after a failed deposit
 *   GET  /v1/owner/tasks?status=         my tasks, newest first, with the latest receipt
 *   GET  /v1/owner/tasks/:id             detail (404 when not mine)
 *   POST /v1/owner/tasks/:id/accept      {note?} — an escrow task releases the deposit to the deliverer, no wallet needed
 *   POST /v1/owner/tasks/:id/revision    {note}
 *   POST /v1/owner/tasks/:id/dispute     {reason}
 *   POST /v1/owner/tasks/:id/cancel
 *
 * Authority model (D3): every route sits behind `ownerSession`. POSTING a task
 * REQUIRES a passkey — the composer signs a WYSIWYS canonical of the posted
 * fields, so an email-rung buyer mints their first passkey at that post and a
 * stolen look-session cannot post. The review routes (accept / changes /
 * dispute / cancel) keep the board-post rule — the ceremony is OPTIONAL there,
 * speech-class ("speech = optional, authority = required"); when a `nonce` +
 * `assertion` are present it runs and the assertion id is stored for
 * provenance, and half-signed is refused.
 *
 * Owner ids never leave the server on public reads (publicTaskShape strips
 * creator_owner_id); a task that is not yours answers 404, never 403.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { CreateTaskSchema, allowedBountyNetworks } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';
import { ownerSession, verifyAndRecordAction, AssertionSchema } from './routes.js';
import { canonicalJsonStringify, sha256, bytesToHex } from '../crypto/index.js';
import { checkRateLimit } from '../lib/rate-limiter.js';
import { generatePublicId } from '../lib/ids.js';
import { captureServerEvent } from '../lib/posthog.js';
import { sanitizeDisplayName } from '../lib/display-name.js';
import {
  type Actor, type TaskRow, loadTask, creatorMatches, logPaymentEvent, recordFunnel, publicTaskShape, paymentView,
  creatorSqlParts, recomputeReputation, notifyMatchingAgents, bountyView,
  acceptUnpaidGate, revisionGate, disputeGate, cancelGate, cancelRefusal, afterAccept, MAX_REVISIONS,
} from '../tasks/service.js';
import { paymentProviderFor } from '../payments/index.js';
import { acceptBountyTask } from '../payments/accept.js';
import { fundEscrowTask, acceptEscrowTask, startEscrowLeg } from '../payments/escrow.js';
import { escrowAvailable } from '../payments/house-wallet.js';
import { escrowView } from '../tasks/service.js';
import { slashBondForDisputedClaim } from '../tasks/governance.js';
import { resolveOpenExpiry } from '../tasks/expiry.js';
import { bountyMinimumRefusal } from '../tasks/bounty-minimum.js';
import { recordEvent } from '../events/service.js';

const textEncoder = new TextEncoder();
function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

/** 20 tasks per owner per hour — a backstop, not a security boundary. */
export const OWNER_TASK_HOURLY = { max: 20, windowMs: 3_600_000 } as const;

type Ctx = Context<AppEnv>;

// ownerId is a control-plane-only context var (routes.ts pattern).
function getOwnerId(c: Ctx): string {
  return (c.get as (k: string) => string)('ownerId');
}

function err(c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, error: string, message: string, extra: Record<string, unknown> = {}) {
  return c.json({ error, message, ...extra }, status);
}

async function readJson(c: Ctx): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    return { ok: true, body: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

const Ceremony = { nonce: z.string().min(1).optional(), assertion: AssertionSchema.optional() };
const OwnerCreateSchema = CreateTaskSchema.extend(Ceremony).strict();
const AcceptSchema = z.object({ note: z.string().max(2000).optional(), ...Ceremony }).strict();
const RevisionSchema = z.object({ note: z.string().min(1).max(2000), ...Ceremony }).strict();
const DisputeSchema = z.object({ reason: z.string().min(1).max(2000), ...Ceremony }).strict();
const CancelSchema = z.object({ reason: z.string().max(2000).optional(), ...Ceremony }).strict();
const PublishSchema = z.object({ publish: z.boolean(), ...Ceremony }).strict();

/**
 * The optional WYSIWYS ceremony (board-post precedent, control/routes.ts).
 * Returns the recorded assertion id (null on the session-only path) or the
 * error response to send.
 */
async function ceremony(
  c: Ctx,
  ownerId: string,
  actionType: string,
  input: { nonce?: string; assertion?: z.infer<typeof AssertionSchema> },
): Promise<{ ok: true; assertionId: string | null } | { ok: false; res: Response }> {
  if (input.nonce === undefined && input.assertion === undefined) return { ok: true, assertionId: null };
  if (input.nonce === undefined || input.assertion === undefined) {
    return { ok: false, res: err(c, 400, 'bad_request', 'nonce and assertion must be provided together') };
  }
  const canonical = canonicalJsonStringify({ action_type: actionType, owner_id: ownerId, nonce: input.nonce });
  const outcome = await verifyAndRecordAction(c, ownerId, actionType, canonical, input.assertion);
  if (!outcome.ok) return { ok: false, res: outcome.res };
  return { ok: true, assertionId: outcome.row.id };
}

/** Load the task and answer 404 unless it belongs to this owner. */
async function loadMine(c: Ctx, db: DBAdapter, ownerId: string, taskId: string): Promise<{ task: TaskRow } | { res: Response }> {
  const task = await loadTask(db, taskId);
  if (!task || !creatorMatches(task, { kind: 'owner', ownerId })) {
    return { res: err(c, 404, 'not_found', 'Task not found') };
  }
  return { task };
}

interface ReceiptRow {
  receipt_id: string;
  task_id: string;
  agent_id: string;
  agent_name: string | null;
  summary: string;
  artifact_urls: string | null;
  commit_hash: string | null;
  pr_url: string | null;
  submission_type: string;
  submission_content: string | null;
  completed_at: string;
  chain_sequence: number | null;
  chain_entry_hash: string | null;
}

function mapReceipt(r: ReceiptRow): Record<string, unknown> {
  let urls: string[] | null = null;
  try { urls = r.artifact_urls ? (JSON.parse(r.artifact_urls) as string[]) : null; } catch { urls = null; }
  return { ...r, agent_name: sanitizeDisplayName(r.agent_name), artifact_urls: urls };
}

async function receiptsFor(db: DBAdapter, taskIds: string[]): Promise<Map<string, ReceiptRow[]>> {
  const out = new Map<string, ReceiptRow[]>();
  if (taskIds.length === 0) return out;
  const rows = await db.all<ReceiptRow>(
    `SELECT r.receipt_id, r.task_id, r.agent_id, a.name AS agent_name, r.summary, r.artifact_urls, r.commit_hash, r.pr_url,
            r.submission_type, r.submission_content, r.completed_at, r.chain_sequence, r.chain_entry_hash
     FROM delivery_receipts r LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY r.completed_at DESC`,
    ...taskIds,
  );
  for (const r of rows) {
    const list = out.get(r.task_id) ?? [];
    list.push(r);
    out.set(r.task_id, list);
  }
  return out;
}

const app = new Hono<AppEnv>();

function paymentHeader(c: Ctx): string | null {
  return c.req.header('PAYMENT-SIGNATURE') ?? c.req.header('X-PAYMENT-SIGNATURE') ?? null;
}

/**
 * POST /v1/owner/tasks — compose a task. A bounty is escrowed at post by
 * default: the first call (no PAYMENT-SIGNATURE) answers the 402 challenge
 * BEFORE the rate limit and the passkey ceremony run, so the console can sign
 * the deposit in the browser wallet and then submit the passkey-signed post
 * with the header; `escrow: false` keeps the pay-at-accept flow.
 */
app.post('/tasks', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = OwnerCreateSchema.safeParse(json.body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'validation failed', details: parsed.error.flatten() }, 400);

  // D13: open window — default 7 days; only house accounts may exceed the cap
  // or post a never-expiring task (tasks/expiry.ts). Checked before the 402
  // challenge so nobody signs a deposit for a post that would be refused.
  const expiry = resolveOpenExpiry(c.env, ownerId, parsed.data.expires_in_days, new Date().toISOString());
  if (!expiry.ok) {
    return err(c, 400, 'expiry_window_not_allowed', `expires_in_days must be between 1 and ${expiry.max} for this poster; omit it for the default window.`, { max_days: expiry.max });
  }

  const wantsEscrow = !!parsed.data.bounty && (parsed.data.escrow ?? escrowAvailable(c.env));
  const rawHeader = paymentHeader(c);
  if (rawHeader && !wantsEscrow) {
    return err(c, 400, 'payment_not_expected', 'This task does not use escrow: the bounty is paid when you accept the delivery. Omit the payment header.');
  }
  // D3: a bounty has a floor. Checked before the escrow challenge below, so the
  // browser wallet is never asked to sign a deposit the post would then refuse.
  const belowMinimum = parsed.data.bounty ? bountyMinimumRefusal(c.env, 'human', parsed.data.bounty.amount) : null;
  if (belowMinimum) return c.json(belowMinimum, 400);
  if (wantsEscrow && parsed.data.bounty && !rawHeader) {
    // The stateless challenge: nothing is consumed (no rate-limit slot, no passkey challenge).
    const b = parsed.data.bounty;
    const challenge = await fundEscrowTask(db, c.env, {
      kind: 'new', funnel: 'human',
      task: {
        task_id: generatePublicId('task'), creator_agent_id: null, creator_owner_id: ownerId, creator_kind: 'owner', creator_assertion_id: null,
        proposer_signature: null, title: parsed.data.title, description: parsed.data.description, category: parsed.data.category ?? null,
        required_capabilities: parsed.data.required_capabilities ?? null, expected_output: parsed.data.expected_output ?? null,
        output_format: parsed.data.output_format, bounty: { amount: b.amount, token: b.token, network: b.network },
        max_active_claims_per_agent: parsed.data.max_active_claims_per_agent ?? null,
        expires_at: expiry.expiresAt,
      },
    }, { rawHeader: null, nowIso: new Date().toISOString(), actor: { kind: 'owner', ownerId } });
    for (const [k, v] of Object.entries(challenge.headers ?? {})) c.header(k, v);
    return c.json(challenge.body, challenge.status);
  }

  const limit = await checkRateLimit(db, `tasks:owner:${ownerId}`, OWNER_TASK_HOURLY.max, OWNER_TASK_HOURLY.windowMs);
  if (!limit.allowed) return err(c, 429, 'rate_limited', `Too many tasks in the last hour (${OWNER_TASK_HOURLY.max} per hour)`);

  // Posting a task requires a passkey signature (WYSIWYS): the account must
  // hold a passkey and sign a canonical of exactly these fields. A look-only
  // session (email rung, no signature) cannot post — it is prompted to add a
  // passkey first. This is stronger than the board-post precedent (speech, so
  // signature-optional): a task is a public commitment that can carry money.
  const { nonce, assertion, ...fields } = parsed.data;
  if (nonce === undefined || assertion === undefined) {
    return err(c, 401, 'passkey_required', 'Posting a task requires a passkey. Add one and sign to post.');
  }
  const bounty = fields.bounty;
  // A human-posted bounty is authorized when they accept the delivery (they
  // sign the EIP-3009 transfer in their browser wallet). Refuse up front if
  // the facilitator is not configured, so the poster never faces a bounty they
  // cannot settle.
  if (bounty && !paymentProviderFor(c.env)) {
    return err(c, 503, 'payments_unavailable', 'Bounties are not enabled on this registry yet. Post the task without a bounty.');
  }
  // Production settles real money: reject a bounty on a network this environment
  // won't pay (testnet USDC is staging/dev only) — before any escrow deposit.
  if (bounty && !allowedBountyNetworks(c.env).includes(bounty.network)) {
    return err(c, 400, 'bounty_network_not_allowed', `Bounties on ${bounty.network} are not accepted here; use eip155:8453 (Base mainnet USDC).`, { network: bounty.network });
  }
  // The signed action folds a hash of exactly the RAW fields the client posted
  // (not the zod-parsed output) — matching the board-post precedent and keeping
  // client/server byte-parity regardless of schema defaults (output_format,
  // bounty token/network). WYSIWYS: what the passkey signs is what was sent.
  const rawFields = { ...json.body };
  delete rawFields.nonce;
  delete rawFields.assertion;
  const cer = await ceremony(c, ownerId, `task.create:${sha256hex(canonicalJsonStringify(rawFields))}`, { nonce, assertion });
  if (!cer.ok) return cer.res;

  const taskId = generatePublicId('task');
  const now = new Date().toISOString();
  const reqCaps = fields.required_capabilities ?? null;

  if (wantsEscrow && bounty) {
    const outcome = await fundEscrowTask(db, c.env, {
      kind: 'new', funnel: 'human',
      task: {
        task_id: taskId, creator_agent_id: null, creator_owner_id: ownerId, creator_kind: 'owner', creator_assertion_id: cer.assertionId,
        proposer_signature: null, title: fields.title, description: fields.description, category: fields.category ?? null,
        required_capabilities: reqCaps, expected_output: fields.expected_output ?? null, output_format: fields.output_format,
        bounty: { amount: bounty.amount, token: bounty.token, network: bounty.network },
        max_active_claims_per_agent: fields.max_active_claims_per_agent ?? null,
        expires_at: expiry.expiresAt,
      },
    }, { rawHeader, nowIso: now, actor: { kind: 'owner', ownerId } });
    for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
    // 200 = the task exists with its deposit taken (the stateless challenge
    // above and every refusal create nothing) — same rule as the agent route.
    if (outcome.status === 200) {
      await captureServerEvent(c, 'task_created', {
        has_bounty: true, escrow: true, category: fields.category ?? null,
        output_format: fields.output_format, bounty_network: bounty.network,
      });
    }
    return c.json(outcome.body, outcome.status);
  }

  const paymentStatus = bounty ? 'pending' : 'none';
  await db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, creator_kind, creator_assertion_id, title, description, category,
       required_capabilities, expected_output, output_format, status, created_at, bounty_amount, bounty_token, bounty_network, payment_status,
       max_active_claims_per_agent, expires_at)
     VALUES (?, NULL, ?, 'owner', ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    taskId, ownerId, cer.assertionId, fields.title, fields.description, fields.category ?? null,
    reqCaps ? JSON.stringify(reqCaps) : null, fields.expected_output ?? null, fields.output_format, now,
    bounty?.amount ?? null, bounty?.token ?? null, bounty?.network ?? null, paymentStatus,
    fields.max_active_claims_per_agent ?? null, expiry.expiresAt,
  );
  if (bounty) {
    await logPaymentEvent(db, taskId, 'bounty_declared', { amount_atomic: bounty.amount, token: bounty.token, network: bounty.network }, now);
  }
  await recordFunnel(db, 'task_posted', taskId, 'human');
  await captureServerEvent(c, 'task_created', {
    has_bounty: !!bounty, escrow: false, category: fields.category ?? null,
    output_format: fields.output_format, bounty_network: bounty?.network ?? null,
  });
  const bountyOut = bountyView({ bounty_amount: bounty?.amount ?? null, bounty_token: bounty?.token ?? null, bounty_network: bounty?.network ?? null });
  await notifyMatchingAgents(db, {
    task_id: taskId, title: fields.title, description: fields.description, category: fields.category ?? null,
    required_capabilities: reqCaps, output_format: fields.output_format, bounty: bountyOut,
  }, null);
  const response: Record<string, unknown> = { ok: true, task_id: taskId, status: 'open', payment_status: paymentStatus, escrow: null, expires_at: expiry.expiresAt };
  if (bountyOut) response.bounty = bountyOut;
  return c.json(response);
});

/** POST /v1/owner/tasks/:id/fund — fund an escrow task again after its deposit failed (same 402 handshake). */
app.post('/tasks/:id/fund', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  if (!mine.task.escrow) return err(c, 409, 'invalid_state', 'This task does not use escrow; the bounty is paid when you accept the delivery.');
  const outcome = await fundEscrowTask(db, c.env, { kind: 'existing', task: mine.task }, { rawHeader: paymentHeader(c), nowIso: new Date().toISOString(), actor: { kind: 'owner', ownerId } });
  for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
  return c.json(outcome.body, outcome.status);
});

const StatusQuery = z.enum(['open', 'claimed', 'submitted', 'verified', 'cancelled', 'expired', 'all']).optional();

/** GET /v1/owner/tasks?status= — my tasks, newest first, with the latest receipt and claimer name. */
app.get('/tasks', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const status = StatusQuery.safeParse(c.req.query('status') || undefined);
  const parts = await creatorSqlParts(db);
  // creatorSqlParts already joins the claimer agent and selects claimer_name,
  // which publicTaskShape folds into `claimed_by`. The top-level claimer_name is
  // kept for the console's existing owner views.
  let sql = `SELECT ${parts.columns} FROM tasks t ${parts.joins} WHERE t.creator_owner_id = ?`;
  const params: unknown[] = [ownerId];
  if (status.success && status.data && status.data !== 'all') { sql += ` AND t.status = ?`; params.push(status.data); }
  sql += ` ORDER BY t.created_at DESC LIMIT 100`;
  const rows = await db.all<Record<string, unknown>>(sql, ...params);
  const receipts = await receiptsFor(db, rows.map((r) => r.task_id as string));
  return c.json({
    ok: true,
    tasks: rows.map((row) => {
      const latest = receipts.get(row.task_id as string)?.[0];
      const shaped = publicTaskShape(row);
      return {
        ...shaped,
        claimer_name: (shaped.claimed_by as { name?: string | null } | null)?.name ?? null,
        latest_receipt: latest ? mapReceipt(latest) : null,
        needs_review: row.status === 'submitted',
      };
    }),
  });
});

/** GET /v1/owner/tasks/:id — detail with every receipt. */
app.get('/tasks/:id', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const parts = await creatorSqlParts(db);
  const row = await db.get<Record<string, unknown>>(
    `SELECT ${parts.columns} FROM tasks t ${parts.joins} WHERE t.task_id = ?`,
    taskId,
  );
  if (!row) return err(c, 404, 'not_found', 'Task not found');
  const shaped = publicTaskShape(row);
  const receipts = (await receiptsFor(db, [taskId])).get(taskId) ?? [];
  const submission = await db.get<Record<string, unknown>>('SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId);
  return c.json({
    ok: true,
    task: { ...shaped, claimer_name: (shaped.claimed_by as { name?: string | null } | null)?.name ?? null, needs_review: row.status === 'submitted' },
    delivery_receipt: receipts[0] ? mapReceipt(receipts[0]) : null,
    receipts: receipts.map(mapReceipt),
    submission: submission ?? null,
    payment: paymentView(mine.task),
  });
});

/** POST /v1/owner/tasks/:id/accept — accept the delivered work (T4-U). */
app.post('/tasks/:id/accept', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const actor: Actor = { kind: 'owner', ownerId };
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = AcceptSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const task = mine.task;
  const note = parsed.data.note ?? null;

  // Analytics: a fresh acceptance always starts from `submitted` — a task
  // already `verified` here is an idempotent re-accept (or a payment retry)
  // and must not count twice. Same rule as the agent route.
  const wasSubmitted = task.status === 'submitted';
  const acceptedProps = {
    has_bounty: !!task.bounty_amount, escrow: !!task.escrow, revision_count: task.revision_count,
  };

  // ─── Escrow task: the deposit is held; accepting releases it to the deliverer.
  // No wallet signature is needed (nothing leaves the buyer's wallet now), so
  // the passkey ceremony stays optional-and-recorded like the unpaid accept;
  // the buyer's exposure is bounded by the deposit they already made.
  if (task.bounty_amount && task.escrow) {
    if (paymentHeader(c)) return err(c, 400, 'payment_not_expected', 'This task is in escrow: the deposit is released to the deliverer when you accept. Omit the payment header.');
    const cer = await ceremony(c, ownerId, `task.accept:${taskId}:${sha256hex(note ?? '')}`, parsed.data);
    if (!cer.ok) return cer.res;
    const outcome = await acceptEscrowTask(db, c.env, task, { note, actor, nowIso: new Date().toISOString(), assertionId: cer.assertionId });
    for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
    if (outcome.status === 200 && wasSubmitted) await captureServerEvent(c, 'task_accepted', acceptedProps);
    return c.json(outcome.body, outcome.status);
  }

  if (task.status === 'verified') {
    return c.json({ ok: true, task_id: taskId, status: 'verified', accepted_by: task.accepted_by });
  }
  if (task.status !== 'submitted') return err(c, 409, 'invalid_state', `Task is ${task.status}; only delivered work can be accepted`, { status: task.status });

  // ─── Bounty task: the human authorizes the USDC transfer with their browser
  // wallet (EIP-3009), sent as the PAYMENT-SIGNATURE header. Same money path as
  // the agent route (payments/accept.ts). Without the header we return the x402
  // challenge (requirements) so the console can sign; with it we verify + settle.
  //
  // The wallet signature IS the money authority and is WYSIWYS at the wallet —
  // the owner approves the exact amount + recipient in their wallet UI, and a
  // stolen session cookie cannot forge it. The registry's passkey ceremony is
  // therefore OPTIONAL here (same speech/authority split as the board post): it
  // runs and is recorded on the paid task only when the console sends a
  // nonce+assertion, as an extra provenance attestation.
  if (task.bounty_amount) {
    const rawHeader = c.req.header('PAYMENT-SIGNATURE') ?? c.req.header('X-PAYMENT-SIGNATURE') ?? null;
    const nowIso = new Date().toISOString();
    let assertionId: string | null = null;
    if (rawHeader) {
      const cer = await ceremony(c, ownerId, `task.accept:${taskId}:${sha256hex(note ?? '')}`, parsed.data);
      if (!cer.ok) return cer.res;
      assertionId = cer.assertionId;
    }
    const outcome = await acceptBountyTask(db, c.env, task, { note, rawHeader, actor, nowIso, assertionId });
    for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
    if (outcome.status === 200 && wasSubmitted) await captureServerEvent(c, 'task_accepted', acceptedProps);
    return c.json(outcome.body, outcome.status);
  }

  const cer = await ceremony(c, ownerId, `task.accept:${taskId}:${sha256hex(note ?? '')}`, parsed.data);
  if (!cer.ok) return cer.res;

  const now = new Date().toISOString();
  if (!(await acceptUnpaidGate(db, taskId, note, cer.assertionId, now))) {
    return err(c, 409, 'conflict', 'Task changed while you were reviewing it');
  }
  const fresh = (await loadTask(db, taskId)) as TaskRow;
  const side = await afterAccept(db, fresh, { acceptedBy: 'creator', by: actor, nowIso: now, paymentStatus: fresh.payment_status });
  await captureServerEvent(c, 'task_accepted', acceptedProps);
  return c.json({
    ok: true, task_id: taskId, status: 'verified', accepted_by: 'creator',
    chain_sequence: side.chain?.sequence ?? null, chain_entry_hash: side.chain?.entry_hash ?? null,
  });
});

/** POST /v1/owner/tasks/:id/revision — ask for changes (T6). */
app.post('/tasks/:id/revision', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = RevisionSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'A note describing the requested changes is required');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const task = mine.task;
  if (task.status !== 'submitted') return err(c, 409, 'invalid_state', 'Only delivered work can be sent back for changes', { status: task.status });
  if (task.revision_count >= MAX_REVISIONS) return err(c, 409, 'max_revisions', `This task already had ${MAX_REVISIONS} rounds of changes; accept, dispute or cancel it`);

  const cer = await ceremony(c, ownerId, `task.revision:${taskId}:${sha256hex(parsed.data.note)}`, parsed.data);
  if (!cer.ok) return cer.res;

  const now = new Date().toISOString();
  if (!(await revisionGate(db, taskId, parsed.data.note, now))) return err(c, 409, 'conflict', 'Task changed while you were reviewing it');
  if (cer.assertionId) await db.run('UPDATE tasks SET review_assertion_id = ? WHERE task_id = ?', cer.assertionId, taskId);
  const revisionCount = task.revision_count + 1;
  if (task.claimed_by_agent_id) await recordEvent(db, task.claimed_by_agent_id, { type: 'task.revision_requested', agent_id: task.claimed_by_agent_id, task_id: taskId, note: parsed.data.note, revision_count: revisionCount }, now);
  await recordFunnel(db, 'task_revision_requested', taskId, null);
  await captureServerEvent(c, 'task_revision_requested', {
    revision_count: revisionCount, has_bounty: !!task.bounty_amount,
  });
  return c.json({ ok: true, task_id: taskId, status: 'claimed', review_state: 'revision_requested', revision_count: revisionCount });
});

/** POST /v1/owner/tasks/:id/dispute — flag the delivered work (T7). */
app.post('/tasks/:id/dispute', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = DisputeSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'A reason is required to dispute delivered work');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const task = mine.task;
  if (task.status !== 'submitted') return err(c, 409, 'invalid_state', 'Only delivered work can be disputed', { status: task.status });
  if (task.disputed_at) return err(c, 409, 'already_disputed', 'This work is already disputed', { disputed_at: task.disputed_at });

  const cer = await ceremony(c, ownerId, `task.dispute:${taskId}:${sha256hex(parsed.data.reason)}`, parsed.data);
  if (!cer.ok) return cer.res;

  const now = new Date().toISOString();
  if (!(await disputeGate(db, taskId, parsed.data.reason, now))) return err(c, 409, 'conflict', 'Task changed while you were reviewing it');
  if (cer.assertionId) await db.run('UPDATE tasks SET review_assertion_id = ? WHERE task_id = ?', cer.assertionId, taskId);
  await logPaymentEvent(db, taskId, 'disputed', { reason: parsed.data.reason, disputed_by: 'owner', payment_status: task.payment_status }, now);
  if (task.claimed_by_agent_id) await recordEvent(db, task.claimed_by_agent_id, { type: 'task.disputed', agent_id: task.claimed_by_agent_id, task_id: taskId, reason: parsed.data.reason }, now);
  await recordFunnel(db, 'task_disputed', taskId, null);
  // Same accountability as the agent-route dispute: a disputed BOUNTY
  // deliverable slashes the worker's claim bond, once per task.
  let bondSlashed = '0';
  if (task.claimed_by_agent_id && task.bounty_amount && Number(task.bounty_amount) > 0) {
    bondSlashed = await slashBondForDisputedClaim(db, c.env, task.claimed_by_agent_id, taskId, now);
  }
  await captureServerEvent(c, 'task_disputed', {
    has_bounty: !!task.bounty_amount, escrow: !!task.escrow,
    revision_count: task.revision_count, bond_slashed: bondSlashed !== '0',
  });
  return c.json({ ok: true, task_id: taskId, status: 'submitted', review_state: 'disputed', disputed_at: now, bond_slashed_atomic: bondSlashed });
});

/** POST /v1/owner/tasks/:id/cancel — cancel (T8; delivered work only after a dispute). */
app.post('/tasks/:id/cancel', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = CancelSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;
  const task = mine.task;
  const refusal = cancelRefusal(task);
  if (refusal) {
    const messages: Record<string, string> = {
      already_accepted: 'Accepted work cannot be cancelled',
      dispute_first: 'Delivered work can only be cancelled after a dispute',
      payment_in_flight: 'A payment is in flight for this task; it cannot be cancelled',
      conflict: 'Task cannot be cancelled in its current state',
    };
    return err(c, 409, refusal, messages[refusal], { status: task.status });
  }

  const cer = await ceremony(c, ownerId, `task.cancel:${taskId}`, parsed.data);
  if (!cer.ok) return cer.res;

  const now = new Date().toISOString();
  if (!(await cancelGate(db, taskId, now))) return err(c, 409, 'conflict', 'Task changed while you were cancelling it');
  if (task.claimed_by_agent_id) await recordEvent(db, task.claimed_by_agent_id, { type: 'task.cancelled', agent_id: task.claimed_by_agent_id, task_id: taskId }, now);
  if (task.escrow && task.escrow_status === 'funded') {
    // The deposit goes back to the wallet that paid it (house-signed; the cron retries).
    await logPaymentEvent(db, taskId, 'escrow_refund_requested', { reason: 'task_cancelled', cancel_reason: parsed.data.reason ?? null }, now);
    await startEscrowLeg(db, c.env, taskId, 'refund', 'cancel', now);
  }
  if (task.disputed_at && task.claimed_by_agent_id) await recomputeReputation(db, task.claimed_by_agent_id);
  await recordFunnel(db, 'task_cancelled', taskId, null);
  await captureServerEvent(c, 'task_cancelled', {
    status_before: task.status, has_bounty: !!task.bounty_amount,
    escrow: !!task.escrow, was_disputed: !!task.disputed_at,
  });
  const after = await loadTask(db, taskId);
  const body: Record<string, unknown> = { ok: true, task_id: taskId, status: 'cancelled', payment_status: after?.payment_status ?? task.payment_status };
  if (after?.escrow) {
    body.escrow = escrowView(after);
    if (after.escrow_refund_tx_hash) body.refund_tx_hash = after.escrow_refund_tx_hash;
  }
  return c.json(body);
});

/**
 * POST /v1/owner/tasks/:id/publish  {publish: boolean}
 * The buyer chooses whether the delivered work is a PUBLIC sample. Private is
 * the default (the payload can carry the buyer's own inputs); publishing is an
 * explicit, reversible opt-in — reversible for future access, though it cannot
 * un-cache what a viewer already saw. Same speech/authority split as the review
 * routes: the passkey ceremony is optional and recorded for provenance when
 * present.
 */
app.post('/tasks/:id/publish', ownerSession, async (c) => {
  const ownerId = getOwnerId(c);
  const db = c.get('db');
  const taskId = c.req.param('id') as string;
  const json = await readJson(c);
  if (!json.ok) return err(c, 400, 'bad_request', 'invalid JSON body');
  const parsed = PublishSchema.safeParse(json.body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');
  const mine = await loadMine(c, db, ownerId, taskId);
  if ('res' in mine) return mine.res;

  const submission = await db.get<{ submission_id: string }>(
    'SELECT submission_id FROM submissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId,
  );
  if (!submission) return err(c, 404, 'not_found', 'No delivery to publish yet');

  const cer = await ceremony(c, ownerId, `task.publish:${taskId}:${parsed.data.publish ? '1' : '0'}`, parsed.data);
  if (!cer.ok) return cer.res;

  const publishedAt = parsed.data.publish ? new Date().toISOString() : null;
  await db.run('UPDATE submissions SET published_at = ? WHERE submission_id = ?', publishedAt, submission.submission_id);
  await recordFunnel(db, parsed.data.publish ? 'task_delivery_published' : 'task_delivery_unpublished', taskId, null);
  await captureServerEvent(c, parsed.data.publish ? 'task_submission_published' : 'task_submission_unpublished');
  return c.json({ ok: true, task_id: taskId, submission_public: parsed.data.publish, published_at: publishedAt });
});

export default app;
