/**
 * Claim bonds — refundable USDC that buys additional claim-budget slots
 * (migration 0044, tasks/governance.ts computes the effect).
 *
 * DEPOSIT rides the same x402 dance as escrow funding: no payment header →
 * 402 with exact requirements; signed header → local prechecks, facilitator
 * verify + settle into the registry's house wallet, then a ledger credit.
 * Nonce reuse is refused via the ledger (one deposit per authorization).
 *
 * WITHDRAWAL is a durable row: the balance is debited up front (guarded),
 * and the cron settles a house-signed transfer to the agent's wallet with a
 * per-row nonce. Retries back off; a terminal failure re-credits the
 * balance ('withdraw_reverted'), so no crash window strands money silently.
 */
import type { DBAdapter } from '../db/adapter.js';
import type { Bindings } from '../types/index.js';
import {
  buildRequirements, buildPaymentRequired, decodePaymentHeader, encodeB64Json, localPrechecks,
  PaymentMalformed, isNetwork, atomicToDisplay,
} from '../payments/x402.js';
import { paymentProviderFor } from '../payments/index.js';
import { houseWalletFor } from '../payments/house-wallet.js';
import { bondBalanceAtomic, claimBudget, claimGovernanceConfig, creditBond, debitBond } from './governance.js';

const WITHDRAW_MAX_ATTEMPTS = 6;
const WITHDRAW_BACKOFF_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];

function nowIsoStr(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function randomNonceHex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface BondOutcome {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** The x402 deposit dance for `slots` additional claim-budget slots. */
export async function depositClaimBond(
  db: DBAdapter,
  env: Bindings,
  agentId: string,
  slots: number,
  rawHeader: string | null,
): Promise<BondOutcome> {
  const cfg = claimGovernanceConfig(env);
  const provider = paymentProviderFor(env);
  const house = houseWalletFor(env);
  if (!provider || !house) {
    return { status: 503, body: { error: 'payments_unavailable', message: 'Claim bonds are not accepting deposits on this deployment (payments are not configured).' } };
  }
  const amount = String(Number(cfg.bondPerSlotAtomic) * slots);
  const network = 'eip155:8453';
  if (!isNetwork(network)) return { status: 500, body: { error: 'config', message: 'bond network misconfigured' } };
  const bondRef = { task_id: `claim-bond:${agentId}`, bounty_amount: amount, bounty_network: network };
  const requirements = buildRequirements(bondRef, house.address, env);
  const resource = {
    url: 'https://api.basedagents.ai/v1/agents/me/claim-bond',
    description: `Refundable claim bond: ${slots} additional claim-budget slot${slots === 1 ? '' : 's'}.`,
  };

  if (!rawHeader) {
    const paymentRequired = buildPaymentRequired(bondRef, requirements, undefined, resource);
    return {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': encodeB64Json(paymentRequired) },
      body: {
        error: 'payment_required',
        message: `Sign an EIP-3009 USDC transfer of ${atomicToDisplay(amount)} USDC to the registry's house wallet ${house.address} and retry with the payment header. The bond is refundable via POST /v1/agents/me/claim-bond/withdraw; letting a claim expire slashes ${atomicToDisplay(cfg.slashPerExpiryAtomic)} USDC from it.`,
        payment_requirements: requirements,
        slots,
        amount_atomic: amount,
      },
    };
  }

  let payload;
  try {
    payload = decodePaymentHeader(rawHeader);
  } catch (err) {
    return { status: 400, body: { error: 'payment_malformed', message: 'The payment header is not a valid x402 v2 payment payload.', detail: err instanceof PaymentMalformed ? err.detail : String(err) } };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const pre = localPrechecks(payload, requirements, nowSec);
  if (!pre.ok) {
    return { status: 402, body: { error: 'payment_invalid', reason: pre.reason, expected: pre.expected, got: pre.got, payment_requirements: requirements } };
  }

  // One deposit per authorization: the ledger remembers every nonce it credited.
  const nonce = (payload as { payload?: { authorization?: { nonce?: string } } }).payload?.authorization?.nonce ?? null;
  if (nonce) {
    const seen = await db.get<{ id: string }>(
      `SELECT id FROM agent_claim_bond_events WHERE kind = 'deposit' AND ref = ?`, `nonce:${nonce}`,
    );
    if (seen) return { status: 409, body: { error: 'authorization_reused', message: 'This authorization was already credited to a bond.' } };
  }

  const verify = await provider.verify(payload, requirements);
  if (verify.kind !== 'valid') {
    return { status: 402, body: { error: 'payment_invalid', reason: 'facilitator_rejected', detail: verify, payment_requirements: requirements } };
  }
  const settle = await provider.settle(payload, requirements);
  if (settle.kind === 'settled' || settle.kind === 'pending') {
    await creditBond(db, agentId, amount, 'deposit', nonce ? `nonce:${nonce}` : `tx:${settle.transaction}`, nowIsoStr());
    const budget = await claimBudget(db, env, agentId);
    return { status: 200, body: { ok: true, credited_atomic: amount, transaction: settle.transaction, budget } };
  }
  if (settle.kind === 'rejected') {
    return { status: 402, body: { error: 'payment_rejected', reason: settle.reason, message: settle.message ?? 'The facilitator rejected the transfer.' } };
  }
  return { status: 502, body: { error: 'facilitator_unavailable', message: 'The transfer could not be settled right now; nothing was charged. Retry with a fresh authorization.', detail: settle.detail } };
}

/** Debit the balance and queue a durable payout to the agent's wallet. */
export async function requestBondWithdrawal(
  db: DBAdapter,
  env: Bindings,
  agentId: string,
  amountAtomic: string,
): Promise<BondOutcome> {
  if (!/^[1-9][0-9]{0,14}$/.test(amountAtomic)) {
    return { status: 400, body: { error: 'bad_request', message: 'amount_atomic must be a positive digit string of USDC atomic units' } };
  }
  const wallet = await db.get<{ wallet_address: string | null; wallet_network: string | null }>(
    'SELECT wallet_address, wallet_network FROM agents WHERE id = ?', agentId,
  );
  if (!wallet?.wallet_address) {
    return { status: 409, body: { error: 'wallet_required', message: 'Set a wallet before withdrawing a bond — the payout needs a destination.' } };
  }
  const network = wallet.wallet_network ?? 'eip155:8453';
  if (!isNetwork(network)) {
    return { status: 409, body: { error: 'wallet_network_unsupported', message: `Bond payouts cannot settle on ${network}.` } };
  }
  const now = nowIsoStr();
  const id = randomId('bwd');
  if (!(await debitBond(db, agentId, amountAtomic, 'withdraw', id, now))) {
    const balance = await bondBalanceAtomic(db, agentId);
    return { status: 409, body: { error: 'insufficient_bond', message: `Your bond balance is ${atomicToDisplay(balance)} USDC.`, balance_atomic: balance } };
  }
  await db.run(
    `INSERT INTO agent_claim_bond_withdrawals (id, agent_id, amount_atomic, to_address, to_network, nonce, state, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    id, agentId, amountAtomic, wallet.wallet_address, network, randomNonceHex(), now, now, now,
  );
  return {
    status: 200,
    body: { ok: true, withdrawal_id: id, amount_atomic: amountAtomic, to: wallet.wallet_address, state: 'pending', note: 'The payout settles from the cron within a few minutes; a terminal failure re-credits your bond.' },
  };
}

/** Cron: settle due withdrawals with house-signed transfers. */
export async function settleDueBondWithdrawals(
  db: DBAdapter,
  env: Bindings,
  nowIso: string,
  limit = 10,
): Promise<{ settled: number; failed: number; refunded: number }> {
  const out = { settled: 0, failed: 0, refunded: 0 };
  const due = await db.all<{ id: string; agent_id: string; amount_atomic: string; to_address: string; to_network: string; nonce: string; attempts: number }>(
    `SELECT id, agent_id, amount_atomic, to_address, to_network, nonce, attempts FROM agent_claim_bond_withdrawals
      WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC LIMIT ?`,
    nowIso, limit,
  );
  if (due.length === 0) return out;
  const provider = paymentProviderFor(env);
  const house = houseWalletFor(env);

  for (const row of due) {
    const fail = async (error: string, terminal: boolean): Promise<void> => {
      const attempts = row.attempts + 1;
      if (terminal || attempts >= WITHDRAW_MAX_ATTEMPTS) {
        // Give the money back — a payout that cannot land must not evaporate.
        await creditBond(db, row.agent_id, row.amount_atomic, 'withdraw_reverted', row.id, nowIso);
        await db.run(
          `UPDATE agent_claim_bond_withdrawals SET state = 'refunded', attempts = ?, last_error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND state = 'pending'`,
          attempts, error.slice(0, 300), nowIso, row.id,
        );
        out.refunded++;
        return;
      }
      const backoff = WITHDRAW_BACKOFF_MS[Math.min(attempts - 1, WITHDRAW_BACKOFF_MS.length - 1)];
      await db.run(
        `UPDATE agent_claim_bond_withdrawals SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
        attempts, error.slice(0, 300), new Date(Date.parse(nowIso) + backoff).toISOString(), nowIso, row.id,
      );
      out.failed++;
    };

    if (!provider || !house) {
      await fail('payments not configured', false);
      continue;
    }
    if (!isNetwork(row.to_network)) {
      await fail(`unsupported network ${row.to_network}`, true);
      continue;
    }
    try {
      const requirements = buildRequirements(
        { task_id: `bond-withdrawal:${row.id}`, bounty_amount: row.amount_atomic, bounty_network: row.to_network },
        row.to_address, env,
      );
      // The SAME nonce every attempt: a retry after a lost response cannot
      // double-pay — the chain refuses a reused authorization.
      const payload = house.signTransfer(requirements, Math.floor(Date.parse(nowIso) / 1000), row.nonce);
      const settle = await provider.settle(payload, requirements);
      if (settle.kind === 'settled' || settle.kind === 'pending') {
        await db.run(
          `UPDATE agent_claim_bond_withdrawals SET state = 'settled', tx_hash = ?, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND state = 'pending'`,
          settle.transaction ?? null, nowIso, row.id,
        );
        out.settled++;
      } else if (settle.kind === 'rejected' && /nonce|reused|already/i.test(settle.reason ?? '')) {
        // Our own earlier broadcast landed — the reuse answer is the receipt.
        await db.run(
          `UPDATE agent_claim_bond_withdrawals SET state = 'settled', next_attempt_at = NULL, last_error = 'settled_inferred_authorization_reused', updated_at = ? WHERE id = ? AND state = 'pending'`,
          nowIso, row.id,
        );
        out.settled++;
      } else if (settle.kind === 'rejected') {
        await fail(`rejected: ${settle.reason}`, true);
      } else {
        await fail(`unavailable: ${settle.detail}`, false);
      }
    } catch (err) {
      await fail(String(err), false);
    }
  }
  return out;
}
