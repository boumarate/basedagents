/**
 * Shared bounty accept-and-settle core (x402), used by BOTH the agent route
 * (routes/tasks.ts, AgentSig creator) and the owner route (control/tasks.ts,
 * a human who signs the EIP-3009 authorization in their browser wallet). The
 * money path must be identical for both — duplicating it once caused drift, so
 * it lives here once and each route supplies only its own auth + the raw
 * PAYMENT-SIGNATURE header.
 *
 * Decoupled from Hono: returns a plain { status, body, headers } outcome the
 * caller turns into a Response (setting PAYMENT-REQUIRED / PAYMENT-RESPONSE).
 */
import type { DBAdapter } from '../db/adapter.js';
import type { Bindings } from '../types/index.js';
import { allowedBountyNetworks } from '../types/index.js';
import type { Actor, TaskRow } from '../tasks/service.js';
import { afterAccept, loadTask, logPaymentEvent, bountyView } from '../tasks/service.js';
import { paymentProviderFor } from './index.js';
import { encryptPaymentSignature } from './crypto.js';
import {
  decodePaymentHeader, buildRequirements, buildPaymentRequired, encodeB64Json, localPrechecks, PaymentMalformed, isNetwork,
} from './x402.js';
import { settleTask, reauthPermitted, wireSettleResponse, REAUTH_CLASSES } from './settle.js';

export const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/** The deliverer's on-file receiving wallet (the bounty's payTo). */
export async function delivererWallet(db: DBAdapter, agentId: string | null): Promise<{ address: string; network: string | null } | null> {
  if (!agentId) return null;
  const row = await db.get<{ wallet_address: string | null; wallet_network: string | null }>(
    'SELECT wallet_address, wallet_network FROM agents WHERE id = ?', agentId,
  );
  if (!row?.wallet_address || !WALLET_RE.test(row.wallet_address)) return null;
  return { address: row.wallet_address, network: row.wallet_network };
}

export interface AcceptOutcome {
  status: 200 | 400 | 402 | 409 | 503;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface AcceptBountyOpts {
  note: string | null;
  /** The raw PAYMENT-SIGNATURE header value, or null to get the 402 challenge. */
  rawHeader: string | null;
  /** Who is accepting — agent creator or the human owner. */
  actor: Actor;
  nowIso: string;
  /** Owner WYSIWYS assertion to record on the paid task (owner route only). */
  assertionId?: string | null;
}

/**
 * Accept a DELIVERED bounty task and settle the USDC. `task` must already be
 * loaded, creator-authorized by the caller, and in `submitted`/`verified`
 * status with a `bounty_amount`. Without `rawHeader` returns the 402 x402
 * challenge; with it, verifies + records acceptance/authorization atomically +
 * settles.
 */
export async function acceptBountyTask(
  db: DBAdapter, env: Bindings, task: TaskRow, opts: AcceptBountyOpts,
): Promise<AcceptOutcome> {
  const { note, rawHeader, actor, nowIso: now, assertionId } = opts;
  const taskId = task.task_id;
  const bountyOut = bountyView(task);

  if (!isNetwork(task.bounty_network)) {
    // A pre-0035 row declared on a network the facilitator does not support.
    return { status: 409, body: { error: 'bounty_unsupported_network', message: `This bounty is on ${task.bounty_network}, which cannot be settled; cancel the task or contact support.`, network: task.bounty_network } };
  }
  // Defense-in-depth: never move money on a network this environment disallows
  // (prod pays mainnet USDC only). Blocks paying a legacy/testnet bounty in prod.
  if (!allowedBountyNetworks(env).includes(task.bounty_network)) {
    return { status: 409, body: { error: 'bounty_network_not_allowed', message: `This bounty is on ${task.bounty_network}, which is not settled in this environment.`, network: task.bounty_network } };
  }
  const provider = paymentProviderFor(env);
  const wallet = await delivererWallet(db, task.claimed_by_agent_id);

  if (!rawHeader) {
    if (!provider) return { status: 503, body: { error: 'payments_unavailable', message: 'Payments are not enabled on this registry.' } };
    if (!wallet) return { status: 409, body: { error: 'payee_wallet_missing', message: 'The deliverer has no wallet on record; they must set one before the bounty can be paid.' } };
    const requirements = buildRequirements(task, wallet.address, env);
    const paymentRequired = buildPaymentRequired(task, requirements);
    return {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': encodeB64Json(paymentRequired) },
      body: {
        error: 'payment_required',
        message: `Sign an EIP-3009 USDC transfer of ${bountyOut?.amount_display} USDC to the deliverer's wallet and retry with the ${PAYMENT_HEADER} header.`,
        ...paymentRequired,
        task_id: taskId,
        bounty: bountyOut,
        accept_endpoint: `POST /v1/tasks/${taskId}/accept`,
        payment_header: PAYMENT_HEADER,
      },
    };
  }

  if (!wallet) return { status: 409, body: { error: 'payee_wallet_missing', message: 'The deliverer has no wallet on record; they must set one before the bounty can be paid.' } };
  const requirements = buildRequirements(task, wallet.address, env);

  let payload: ReturnType<typeof decodePaymentHeader>;
  try {
    payload = decodePaymentHeader(rawHeader);
  } catch (err) {
    return { status: 400, body: { error: 'payment_malformed', message: 'The payment header is not a valid x402 v2 payment payload.', detail: err instanceof PaymentMalformed ? err.detail : String(err), payment_requirements: requirements } };
  }

  const nowSec = Math.floor(Date.parse(now) / 1000);
  const pre = localPrechecks(payload, requirements, nowSec);
  if (!pre.ok) {
    return { status: 402, body: { error: 'payment_invalid', reason: pre.reason, expected: pre.expected, got: pre.got, message: "The signed authorization does not match this task's payment requirements.", payment_requirements: requirements } };
  }

  // Re-authorization guard (N11): never replace a payload that may have reached the chain.
  if (!reauthPermitted(task)) {
    return { status: 409, body: { error: 'settlement_in_progress', message: 'A previous authorization for this task is still being settled; check GET /v1/tasks/:id/payment.', payment_status: task.payment_status } };
  }

  if (!provider) return { status: 503, body: { error: 'payments_unavailable', message: 'Payments are not enabled on this registry.' } };

  const verify = await provider.verify(payload, requirements);
  if (verify.kind === 'invalid') {
    return { status: 402, body: { error: verify.reason === 'insufficient_funds' ? 'insufficient_funds' : 'payment_invalid', reason: verify.reason, message: verify.message ?? 'The facilitator rejected the authorization.', payer: verify.payer ?? null, payment_requirements: requirements } };
  }
  if (verify.kind === 'unavailable') {
    if (verify.cause === 'auth') console.error('[payments] CDP auth rejected — check CDP_API_KEY_ID/CDP_API_KEY_SECRET');
    return { status: 503, body: { error: 'facilitator_unavailable', cause: verify.cause, message: 'The payment facilitator is unavailable; retry shortly.' } };
  }

  const encKey = env?.PAYMENT_ENCRYPTION_KEY as string; // guaranteed by paymentProviderFor
  const encrypted = await encryptPaymentSignature(rawHeader, encKey);
  const auth = payload.payload.authorization;
  const expiresAt = new Date(Number(auth.validBefore) * 1000).toISOString();

  // THE GATE (T4-P): acceptance + authorization in ONE statement. Two predicates
  // tried in turn so we KNOW which edge we consumed (the cron may have
  // auto-accepted while the facilitator verify was in flight).
  const gateSql = (statusPredicate: string) => `
      UPDATE tasks SET
         status = 'verified', verified_at = COALESCE(verified_at, ?), accepted_by = COALESCE(accepted_by, 'creator'),
         review_note = COALESCE(?, review_note), auto_release_at = NULL,
         payment_signature = ?, payment_requirements = ?, payment_payer = ?, payment_nonce = ?, payment_expires_at = ?,
         payment_verified = 1, payment_status = 'authorized', settle_attempts = 0, settle_broadcast = 0,
         settle_started_at = NULL, settle_next_at = ?, last_settle_error = NULL, last_settle_class = NULL
       WHERE task_id = ? AND ${statusPredicate}
         AND payment_status IN ('pending','failed','expired')
         AND (settle_broadcast = 0 OR payment_status = 'expired' OR last_settle_class IN (${REAUTH_CLASSES.map((cls) => `'${cls}'`).join(',')}))`;
  const gateParams = [now, note, encrypted, JSON.stringify(requirements), verify.payer ?? auth.from, auth.nonce.toLowerCase(), expiresAt, now, taskId];
  let wasSubmitted = false;
  let changes = 0;
  try {
    const first = await db.run(gateSql(`status = 'submitted'`), ...gateParams);
    if (first.changes === 1) {
      wasSubmitted = true;
      changes = 1;
    } else {
      changes = (await db.run(gateSql(`status = 'verified'`), ...gateParams)).changes;
    }
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) {
      return { status: 409, body: { error: 'authorization_reused', message: 'This authorization nonce was already used for another task.' } };
    }
    throw err;
  }
  if (changes !== 1) {
    return { status: 409, body: { error: 'conflict', message: 'Task changed while you were accepting it; reload and retry. Your signature was not used.' } };
  }
  if (assertionId) {
    await db.run('UPDATE tasks SET review_assertion_id = COALESCE(review_assertion_id, ?) WHERE task_id = ?', assertionId, taskId);
  }

  const fresh = (await loadTask(db, taskId)) as TaskRow;
  let side: { chain: { sequence: number; entry_hash: string } | null } = { chain: null };
  if (wasSubmitted) {
    side = await afterAccept(db, fresh, { acceptedBy: 'creator', by: actor, nowIso: now, paymentStatus: 'authorized' });
  }
  await logPaymentEvent(db, taskId, 'authorized', {
    payer: verify.payer ?? auth.from, nonce: auth.nonce, valid_before: expiresAt, amount_atomic: task.bounty_amount, pay_to: wallet.address, trigger: 'accept',
  }, now);

  const settle = await settleTask(db, env, taskId, 'accept', now);
  const after = (await loadTask(db, taskId)) as TaskRow;
  const headers: Record<string, string> = {};
  if (!settle.skipped && settle.facilitator) headers['PAYMENT-RESPONSE'] = encodeB64Json(wireSettleResponse(settle.facilitator, task.bounty_network));

  const body: Record<string, unknown> = {
    ok: true, task_id: taskId, status: 'verified', accepted_by: after.accepted_by,
    payment_status: after.payment_status,
    chain_sequence: side.chain?.sequence ?? null, chain_entry_hash: side.chain?.entry_hash ?? null,
  };
  if (after.payment_tx_hash) body.payment_tx_hash = after.payment_tx_hash;
  if (after.payment_status !== 'settled' && after.last_settle_error) body.settle_error = after.last_settle_error;
  return { status: 200, body, headers };
}
