/**
 * Escrow for task bounties (Tasks P1) — the DEFAULT money model for a bounty.
 *
 *   post    the buyer signs an EIP-3009 transfer of the bounty to the
 *           registry's HOUSE WALLET (the same 402 handshake /accept uses,
 *           at POST /v1/tasks); the task exists from that moment but is
 *           claimable only once the deposit has settled (`escrow_status =
 *           funded`) — the deliverer never works against a promise.
 *   accept  the house signs a transfer to the deliverer's wallet and settles
 *           it through the facilitator; nobody has to come back and sign.
 *           The 7-day auto-accept releases the same way — silence pays.
 *   cancel  the house signs a transfer back to the buyer's paying address.
 *
 * `escrow: false` on POST keeps the sign-at-accept flow (payments/accept.ts),
 * so a buyer who would rather not trust the registry with their USDC can opt
 * out per task. Everything money-shaped still goes through ONE machine:
 * settle.ts settles every leg; only who signs and who receives differs.
 *
 * Custody makes the registry a party to the funds — SECURITY.md and SPEC.md
 * "Escrow" spell out the operator duties (house key custody, balance
 * monitoring, reconciliation of `unknown` outcomes).
 */
import type { DBAdapter } from '../db/adapter.js';
import type { Bindings } from '../types/index.js';
import { allowedBountyNetworks } from '../types/index.js';
import type { Actor, TaskRow, EscrowLeg } from '../tasks/service.js';
import {
  loadTask, logPaymentEvent, recordFunnel, bountyView, escrowView, acceptUnpaidGate, afterAccept, type BountyView,
} from '../tasks/service.js';
import { paymentProviderFor } from './index.js';
import { encryptPaymentSignature } from './crypto.js';
import {
  decodePaymentHeader, buildRequirements, buildPaymentRequired, encodeB64Json, localPrechecks, PaymentMalformed, isNetwork,
  TASK_RESOURCE_BASE, type PaymentRequirementsV2,
} from './x402.js';
import { settleTask, reauthPermitted, wireSettleResponse, REAUTH_CLASSES, type SettleTrigger, type SettleResult } from './settle.js';
import { houseWalletFor, escrowDisabledReason, sameAddress } from './house-wallet.js';
import { delivererWallet, PAYMENT_HEADER, type AcceptOutcome } from './accept.js';

/** House-signed legs started per task before the cron stops re-signing and a human looks. */
export const ESCROW_MAX_LEG_ATTEMPTS = 5;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ─── Funding (the deposit leg) ───

/** Everything the INSERT of a new escrow task needs, as the route parsed it. */
export interface NewEscrowTask {
  task_id: string;
  creator_agent_id: string | null;
  creator_owner_id: string | null;
  creator_kind: 'agent' | 'owner';
  creator_assertion_id: string | null;
  proposer_signature: string | null;
  title: string;
  description: string;
  category: string | null;
  required_capabilities: string[] | null;
  expected_output: string | null;
  output_format: string;
  bounty: { amount: string; token: string; network: string };
  /** Campaign cap (migration 0044): max claimed+submitted per agent across this poster's tasks. */
  max_active_claims_per_agent?: number | null;
  /** Open window (0045, decision D13): expires_at to stamp; null = never (house standing tasks). */
  expires_at: string | null;
}

export type FundTarget =
  | { kind: 'new'; task: NewEscrowTask; funnel: 'agent' | 'human' }
  /** Re-fund an existing task whose deposit definitively failed (`escrow_status = unfunded`). */
  | { kind: 'existing'; task: TaskRow };

export interface FundOpts {
  /** The raw PAYMENT-SIGNATURE header, or null to get the 402 challenge. */
  rawHeader: string | null;
  nowIso: string;
  actor: Actor;
}

function fundResource(target: FundTarget): { url: string; description: string } {
  return target.kind === 'new'
    ? { url: TASK_RESOURCE_BASE, description: 'BasedAgents escrow deposit for a new task' }
    : { url: `${TASK_RESOURCE_BASE}/${target.task.task_id}/fund`, description: `BasedAgents escrow deposit for task ${target.task.task_id}` };
}

/**
 * The escrow deposit handshake, shared by POST /v1/tasks (agent), POST
 * /v1/owner/tasks (human) and POST /v1/tasks/:id/fund (re-fund). Without a
 * header returns the 402 `PaymentRequired` whose `payTo` is the house wallet;
 * with one, verifies it, writes the task (or re-arms the existing one) with
 * the deposit leg in ONE statement, and settles immediately. The task is
 * created with `escrow_status = funding` and becomes `funded` — claimable —
 * when the deposit settles (settle.ts), usually inside this same request.
 */
export async function fundEscrowTask(db: DBAdapter, env: Bindings, target: FundTarget, opts: FundOpts): Promise<AcceptOutcome> {
  const { rawHeader, nowIso: now } = opts;
  const taskId = target.task.task_id;
  /** The row being re-funded (null when creating). */
  const existing: TaskRow | null = target.kind === 'existing' ? target.task : null;
  const bounty = target.kind === 'new'
    ? target.task.bounty
    : { amount: existing!.bounty_amount ?? '', token: existing!.bounty_token ?? 'USDC', network: existing!.bounty_network ?? '' };
  if (!bounty.amount || !isNetwork(bounty.network)) {
    return { status: 409, body: { error: 'bounty_unsupported_network', message: `This bounty is on ${bounty.network || 'an unknown network'}, which cannot be settled.`, network: bounty.network } };
  }
  // Defense-in-depth: production takes escrow deposits in mainnet USDC only; a
  // testnet deposit is refused before any house-wallet custody begins.
  if (!allowedBountyNetworks(env).includes(bounty.network)) {
    return { status: 409, body: { error: 'bounty_network_not_allowed', message: `This bounty is on ${bounty.network}, which is not settled in this environment.`, network: bounty.network } };
  }
  const bountyOut = bountyView({ bounty_amount: bounty.amount, bounty_token: bounty.token, bounty_network: bounty.network }) as BountyView;

  const reason = escrowDisabledReason(env);
  const house = houseWalletFor(env);
  const provider = paymentProviderFor(env);
  if (reason || !house || !provider) {
    return {
      status: 503,
      body: {
        error: 'escrow_unavailable',
        message: `Escrow is not available on this registry (${reason ?? 'house wallet not configured'}). Post with "escrow": false to pay the bounty when you accept the delivery, or post without a bounty.`,
        reason: reason ?? 'house wallet not configured',
      },
    };
  }
  if (existing && (existing.status !== 'open' || !existing.escrow || existing.escrow_status !== 'unfunded')) {
    return { status: 409, body: { error: 'invalid_state', message: 'Only an open escrow task whose deposit failed can be funded again.', status: existing.status, escrow: escrowView(existing) } };
  }

  const requirements = buildRequirements({ task_id: taskId, bounty_amount: bounty.amount, bounty_network: bounty.network }, house.address, env);
  const resource = fundResource(target);

  if (!rawHeader) {
    const paymentRequired = buildPaymentRequired({ task_id: taskId }, requirements, undefined, resource);
    return {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': encodeB64Json(paymentRequired) },
      body: {
        error: 'payment_required',
        message: `Escrow: sign an EIP-3009 USDC transfer of ${bountyOut.amount_display} USDC to the registry's escrow wallet ${house.address} and retry this request with the ${PAYMENT_HEADER} header. The deposit is held until you accept the delivery (released to the deliverer) or cancel the task (refunded to the wallet that paid).`,
        ...paymentRequired,
        ...(target.kind === 'existing' ? { task_id: taskId } : {}),
        bounty: bountyOut,
        escrow: { wallet: house.address },
        fund_endpoint: target.kind === 'new' ? 'POST /v1/tasks' : `POST /v1/tasks/${taskId}/fund`,
        payment_header: PAYMENT_HEADER,
      },
    };
  }

  let payload: ReturnType<typeof decodePaymentHeader>;
  try {
    payload = decodePaymentHeader(rawHeader);
  } catch (err) {
    return { status: 400, body: { error: 'payment_malformed', message: 'The payment header is not a valid x402 v2 payment payload.', detail: err instanceof PaymentMalformed ? err.detail : String(err), payment_requirements: requirements } };
  }
  const nowSec = Math.floor(Date.parse(now) / 1000);
  const pre = localPrechecks(payload, requirements, nowSec);
  if (!pre.ok) {
    return { status: 402, body: { error: 'payment_invalid', reason: pre.reason, expected: pre.expected, got: pre.got, message: "The signed authorization does not match this task's escrow deposit requirements.", payment_requirements: requirements } };
  }
  const auth = payload.payload.authorization;
  if (sameAddress(auth.from, house.address)) {
    return { status: 402, body: { error: 'payment_invalid', reason: 'self_send', message: 'The escrow wallet cannot fund its own task.', payment_requirements: requirements } };
  }
  if (existing && !reauthPermitted(existing)) {
    return { status: 409, body: { error: 'settlement_in_progress', message: 'A previous deposit for this task is still being settled; check GET /v1/tasks/:id/payment.', payment_status: existing.payment_status } };
  }
  // A deposit nonce is spent once, on one task — before the facilitator call and again by the index.
  const nonce = auth.nonce.toLowerCase();
  const reused = await db.get<{ task_id: string }>('SELECT task_id FROM tasks WHERE payment_nonce = ? OR escrow_deposit_nonce = ?', nonce, nonce);
  if (reused) {
    return { status: 409, body: { error: 'authorization_reused', message: 'This authorization nonce was already used for a task.', task_id: reused.task_id } };
  }

  const verify = await provider.verify(payload, requirements);
  if (verify.kind === 'invalid') {
    return { status: 402, body: { error: verify.reason === 'insufficient_funds' ? 'insufficient_funds' : 'payment_invalid', reason: verify.reason, message: verify.message ?? 'The facilitator rejected the authorization.', payer: verify.payer ?? null, payment_requirements: requirements } };
  }
  if (verify.kind === 'unavailable') {
    if (verify.cause === 'auth') console.error('[payments] CDP auth rejected — check CDP_API_KEY_ID/CDP_API_KEY_SECRET');
    return { status: 503, body: { error: 'facilitator_unavailable', cause: verify.cause, message: 'The payment facilitator is unavailable; retry shortly.' } };
  }

  const encKey = env.PAYMENT_ENCRYPTION_KEY as string; // guaranteed by paymentProviderFor
  const encrypted = await encryptPaymentSignature(rawHeader, encKey);
  const payer = verify.payer ?? auth.from;
  const expiresAt = new Date(Number(auth.validBefore) * 1000).toISOString();

  if (target.kind === 'new') {
    const n = target.task;
    try {
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, creator_kind, creator_assertion_id, proposer_signature,
           title, description, category, required_capabilities, expected_output, output_format, status, created_at,
           bounty_amount, bounty_token, bounty_network,
           escrow, escrow_status, escrow_leg, escrow_leg_attempts, escrow_wallet,
           payment_status, payment_signature, payment_requirements, payment_payer, payment_nonce, payment_expires_at, payment_verified,
           settle_attempts, settle_broadcast, settle_next_at, max_active_claims_per_agent, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 1, 'funding', 'deposit', 0, ?, 'authorized', ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`,
        n.task_id, n.creator_agent_id, n.creator_owner_id, n.creator_kind, n.creator_assertion_id, n.proposer_signature,
        n.title, n.description, n.category, n.required_capabilities ? JSON.stringify(n.required_capabilities) : null,
        n.expected_output, n.output_format, now, bounty.amount, bounty.token, bounty.network, house.address,
        encrypted, JSON.stringify(requirements), payer, nonce, expiresAt, now,
        n.max_active_claims_per_agent ?? null, n.expires_at,
      );
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) {
        const other = await db.get<{ task_id: string }>('SELECT task_id FROM tasks WHERE payment_nonce = ? OR escrow_deposit_nonce = ?', nonce, nonce);
        return { status: 409, body: { error: 'authorization_reused', message: 'This authorization nonce was already used for a task.', task_id: other?.task_id ?? null } };
      }
      throw err;
    }
    await logPaymentEvent(db, taskId, 'bounty_declared', { amount_atomic: bounty.amount, token: bounty.token, network: bounty.network, escrow: true }, now);
    await recordFunnel(db, 'task_posted', taskId, target.funnel);
  } else {
    // Re-fund: the failed deposit is replaced in ONE statement, guarded by the same re-auth predicate as /accept.
    let changes = 0;
    try {
      changes = (await db.run(
        `UPDATE tasks SET escrow_status = 'funding', escrow_leg = 'deposit', escrow_wallet = ?,
           payment_status = 'authorized', payment_signature = ?, payment_requirements = ?, payment_payer = ?, payment_nonce = ?,
           payment_expires_at = ?, payment_verified = 1, payment_settled = 0, payment_tx_hash = NULL, settled_at = NULL,
           settle_attempts = 0, settle_broadcast = 0, settle_started_at = NULL, settle_next_at = ?, last_settle_error = NULL, last_settle_class = NULL
         WHERE task_id = ? AND status = 'open' AND escrow = 1 AND escrow_status = 'unfunded'
           AND payment_status IN ('pending','failed','expired')
           AND (settle_broadcast = 0 OR payment_status = 'expired' OR last_settle_class IN (${REAUTH_CLASSES.map((cls) => `'${cls}'`).join(',')}))`,
        house.address, encrypted, JSON.stringify(requirements), payer, nonce, expiresAt, now, taskId,
      )).changes;
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) {
        return { status: 409, body: { error: 'authorization_reused', message: 'This authorization nonce was already used for a task.' } };
      }
      throw err;
    }
    if (changes !== 1) {
      return { status: 409, body: { error: 'conflict', message: 'Task changed while you were funding it; reload and retry. Your signature was not used.' } };
    }
  }
  await logPaymentEvent(db, taskId, 'escrow_deposit_authorized', {
    payer, nonce, valid_before: expiresAt, amount_atomic: bounty.amount, pay_to: house.address, trigger: 'fund',
  }, now);

  const settle = await settleTask(db, env, taskId, 'fund', now);
  const after = (await loadTask(db, taskId)) as TaskRow;
  const headers: Record<string, string> = {};
  if (!settle.skipped && settle.facilitator) headers['PAYMENT-RESPONSE'] = encodeB64Json(wireSettleResponse(settle.facilitator, bounty.network));
  const view = escrowView(after);
  const body: Record<string, unknown> = {
    ok: true, task_id: taskId, status: after.status, payment_status: after.payment_status,
    bounty: bountyOut, escrow: view, claimable: after.escrow_status === 'funded',
  };
  if (view?.deposit_tx_hash) body.deposit_tx_hash = view.deposit_tx_hash;
  if (after.escrow_status !== 'funded' && after.last_settle_error) body.settle_error = after.last_settle_error;
  return { status: 200, body, headers };
}

// ─── House-signed legs (release / refund) ───

export type LegStart =
  | { started: false; reason: 'no_row' | 'not_escrow' | 'not_funded' | 'wrong_status' | 'max_attempts' | 'escrow_unavailable' | 'wallet_mismatch' | 'payee_wallet_missing' | 'refund_address_missing' | 'self_send' | 'lost_race' }
  | { started: true; settle: SettleResult };

/**
 * Start the payout leg of a funded escrow task: `release` (task `verified`,
 * house → deliverer's live wallet) or `refund` (task `cancelled`, house →
 * the address that paid the deposit). Signs a fresh EIP-3009 authorization
 * with the house key, arms it in ONE conditional UPDATE (`escrow_status =
 * funded` is the gate, so two callers never sign twice), then settles.
 *
 * Every refusal is retried by the cron's sweep (`escrowSweep`) while the task
 * stays `funded`; a definitive on-chain failure of the leg drops it back to
 * `funded` too (settle.ts), bounded by ESCROW_MAX_LEG_ATTEMPTS.
 */
export async function startEscrowLeg(
  db: DBAdapter, env: Bindings, taskId: string, leg: Exclude<EscrowLeg, 'deposit'>, trigger: SettleTrigger, nowIso: string,
): Promise<LegStart> {
  const task = await loadTask(db, taskId);
  if (!task) return { started: false, reason: 'no_row' };
  if (!task.escrow) return { started: false, reason: 'not_escrow' };
  // A refund follows a cancel OR an open-window expiry (0045) — both return
  // the deposit to the buyer; a release only ever follows acceptance.
  const statusOk = leg === 'release' ? task.status === 'verified' : task.status === 'cancelled' || task.status === 'expired';
  if (!statusOk) return { started: false, reason: 'wrong_status' };
  if (task.escrow_status !== 'funded') return { started: false, reason: 'not_funded' };
  if (task.escrow_leg_attempts >= ESCROW_MAX_LEG_ATTEMPTS) return { started: false, reason: 'max_attempts' };
  if (!isNetwork(task.bounty_network) || !task.bounty_amount) return { started: false, reason: 'not_escrow' };

  const house = houseWalletFor(env);
  const provider = paymentProviderFor(env);
  const encKey = env.PAYMENT_ENCRYPTION_KEY;
  if (!house || !provider || !encKey) {
    console.error(`[escrow] ${taskId}: cannot ${leg} — house wallet/payments not configured; the cron retries`);
    return { started: false, reason: 'escrow_unavailable' };
  }
  if (task.escrow_wallet && !sameAddress(task.escrow_wallet, house.address)) {
    // The key was rotated: only the wallet that holds the deposit can move it.
    console.error(`[escrow] ${taskId}: deposit is held by ${task.escrow_wallet} but the configured house wallet is ${house.address} — manual ${leg} required`);
    return { started: false, reason: 'wallet_mismatch' };
  }

  let recipient: string | null;
  if (leg === 'release') {
    const wallet = await delivererWallet(db, task.claimed_by_agent_id);
    if (!wallet) {
      console.warn(`[escrow] ${taskId}: cannot release — the deliverer has no wallet on record; the cron retries`);
      return { started: false, reason: 'payee_wallet_missing' };
    }
    recipient = wallet.address;
  } else {
    recipient = task.escrow_deposit_payer && ADDR_RE.test(task.escrow_deposit_payer) ? task.escrow_deposit_payer : null;
    if (!recipient) {
      console.error(`[escrow] ${taskId}: cannot refund — no deposit payer on record; manual refund required`);
      return { started: false, reason: 'refund_address_missing' };
    }
  }
  if (sameAddress(recipient, house.address)) {
    console.error(`[escrow] ${taskId}: ${leg} recipient is the house wallet itself — refusing`);
    return { started: false, reason: 'self_send' };
  }

  const requirements = buildRequirements(task, recipient, env);
  const nowSec = Math.floor(Date.parse(nowIso) / 1000);
  const payload = house.signTransfer(requirements, nowSec);
  const auth = payload.payload.authorization;
  const rawHeader = encodeB64Json(payload);
  const encrypted = await encryptPaymentSignature(rawHeader, encKey);
  const expiresAt = new Date(Number(auth.validBefore) * 1000).toISOString();

  // THE GATE: arm the leg iff the task is still funded in an expected status
  // (release: verified; refund: cancelled or expired — 0045).
  const statusPredicate = leg === 'release' ? `status = 'verified'` : `status IN ('cancelled','expired')`;
  const res = await db.run(
    `UPDATE tasks SET escrow_leg = ?, escrow_status = ?, escrow_leg_attempts = escrow_leg_attempts + 1,
       payment_status = 'authorized', payment_signature = ?, payment_requirements = ?, payment_payer = ?, payment_nonce = ?,
       payment_expires_at = ?, payment_verified = 1, payment_settled = 0, payment_tx_hash = NULL, settled_at = NULL,
       settle_attempts = 0, settle_broadcast = 0, settle_started_at = NULL, settle_next_at = ?, last_settle_error = NULL, last_settle_class = NULL
     WHERE task_id = ? AND escrow = 1 AND escrow_status = 'funded' AND ${statusPredicate}`,
    leg, leg === 'release' ? 'releasing' : 'refunding', encrypted, JSON.stringify(requirements), house.address, auth.nonce.toLowerCase(),
    expiresAt, nowIso, taskId,
  );
  if (res.changes !== 1) return { started: false, reason: 'lost_race' };

  await logPaymentEvent(db, taskId, `escrow_${leg}_authorized`, {
    from: house.address, pay_to: recipient, nonce: auth.nonce, valid_before: expiresAt, amount_atomic: task.bounty_amount,
    trigger, attempt: task.escrow_leg_attempts + 1,
  }, nowIso);

  const settle = await settleTask(db, env, taskId, trigger, nowIso);
  return { started: true, settle };
}

/**
 * The cron's escrow sweep: every funded task that has been accepted or
 * cancelled but whose payout leg is not running — an accept/cancel whose
 * signing failed (config), or a leg that ended in a definitive failure —
 * gets (re-)signed. Bounded per task by ESCROW_MAX_LEG_ATTEMPTS; beyond that
 * a human reconciles (`GET /v1/tasks/:id/payment` shows the last error).
 */
export async function escrowSweep(
  db: DBAdapter, env: Bindings, nowIso: string, limit = 50,
): Promise<{ attempted: number; released: number; refunded: number; stuck: number }> {
  const out = { attempted: 0, released: 0, refunded: 0, stuck: 0 };
  const rows = await db.all<{ task_id: string; status: string; escrow_leg_attempts: number }>(
    `SELECT task_id, status, escrow_leg_attempts FROM tasks
      WHERE escrow = 1 AND escrow_status = 'funded' AND status IN ('verified','cancelled','expired') LIMIT ?`,
    limit,
  );
  for (const row of rows) {
    if (row.escrow_leg_attempts >= ESCROW_MAX_LEG_ATTEMPTS) {
      out.stuck++;
      console.error(`[escrow] ${row.task_id}: ${row.status === 'verified' ? 'release' : 'refund'} gave up after ${row.escrow_leg_attempts} attempts — manual reconciliation required`);
      continue;
    }
    try {
      out.attempted++;
      const leg = row.status === 'verified' ? 'release' : 'refund';
      const r = await startEscrowLeg(db, env, row.task_id, leg, 'cron', nowIso);
      if (r.started && !r.settle.skipped && (r.settle.payment_status === 'settled' || r.settle.payment_status === 'refunded')) {
        if (leg === 'release') out.released++; else out.refunded++;
      }
    } catch (err) {
      console.error(`[cron] escrow ${row.status === 'verified' ? 'release' : 'refund'} failed for ${row.task_id}:`, err);
    }
  }
  return out;
}

// ─── Acceptance of an escrow task (shared by the agent and owner routes) ───

export interface AcceptEscrowOpts {
  note: string | null;
  actor: Actor;
  nowIso: string;
  /** Owner WYSIWYS assertion to record (owner route only). */
  assertionId?: string | null;
}

/**
 * Accept a delivered escrow task: the review gate (T4-U — acceptance never
 * touches the payment columns) followed by the house-signed release. No
 * PAYMENT-SIGNATURE is needed: the deposit already sits in the house wallet.
 * Idempotent on an accepted task, and re-attempts a release that has not
 * started yet (the cron would too).
 */
export async function acceptEscrowTask(db: DBAdapter, env: Bindings, task: TaskRow, opts: AcceptEscrowOpts): Promise<AcceptOutcome> {
  const { note, actor, nowIso: now, assertionId } = opts;
  const taskId = task.task_id;

  const respond = async (extra: Record<string, unknown>, leg: LegStart | null): Promise<AcceptOutcome> => {
    const after = (await loadTask(db, taskId)) as TaskRow;
    const headers: Record<string, string> = {};
    if (leg?.started && !leg.settle.skipped && leg.settle.facilitator) {
      headers['PAYMENT-RESPONSE'] = encodeB64Json(wireSettleResponse(leg.settle.facilitator, after.bounty_network));
    }
    const body: Record<string, unknown> = {
      ok: true, task_id: taskId, status: 'verified', accepted_by: after.accepted_by,
      payment_status: after.payment_status, escrow: escrowView(after), ...extra,
    };
    if (after.payment_tx_hash) body.payment_tx_hash = after.payment_tx_hash;
    if (after.payment_status !== 'settled' && after.last_settle_error) body.settle_error = after.last_settle_error;
    if (leg && !leg.started && leg.reason !== 'lost_race') body.release_deferred = leg.reason;
    return { status: 200, body, headers };
  };

  if (task.status === 'verified') {
    const leg = task.escrow_status === 'funded' ? await startEscrowLeg(db, env, taskId, 'release', 'accept', now) : null;
    return respond({}, leg);
  }
  if (task.status !== 'submitted') {
    return { status: 409, body: { error: 'invalid_state', message: `Task is ${task.status}; only a submitted task can be accepted`, status: task.status } };
  }
  if (!(await acceptUnpaidGate(db, taskId, note, assertionId ?? null, now))) {
    return { status: 409, body: { error: 'conflict', message: 'Task was accepted or cancelled by another action' } };
  }
  const fresh = (await loadTask(db, taskId)) as TaskRow;
  const side = await afterAccept(db, fresh, { acceptedBy: 'creator', by: actor, nowIso: now, paymentStatus: fresh.payment_status });
  const leg = await startEscrowLeg(db, env, taskId, 'release', 'accept', now);
  return respond({ chain_sequence: side.chain?.sequence ?? null, chain_entry_hash: side.chain?.entry_hash ?? null }, leg);
}

/** The x402 requirements a buyer signs to fund an escrow task (for GET /v1/tasks/:id/payment). */
export function escrowDepositRequirements(env: Bindings, task: Pick<TaskRow, 'task_id' | 'bounty_amount' | 'bounty_network'>): PaymentRequirementsV2 | null {
  const house = houseWalletFor(env);
  if (!house || !task.bounty_amount || !isNetwork(task.bounty_network)) return null;
  return buildRequirements(task, house.address, env);
}
