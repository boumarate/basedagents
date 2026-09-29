/**
 * Task cron — runs every 5 minutes from the Worker's `scheduled` handler.
 *
 *   1. Auto-accept: delivered tasks nobody reviewed for 7 days become
 *      `verified` / accepted_by='auto' (N3). A sign-at-accept bounty is never
 *      moved by the buyer's silence (the creator gets `task.payment_due`); an
 *      ESCROW bounty is already held, so the house releases it to the deliverer.
 *   1b. Claim expiry: a claimed task not delivered within 7 days returns to
 *      `open` for anyone to re-claim (the claimer is notified; matching agents
 *      are re-pinged). Never touches payment columns — a funded escrow stays funded.
 *   2. Settle retry: authorized/failed/settling rows that are due — accepted
 *      tasks and escrow deposit/refund legs alike.
 *   3. Expiry sweep: un-broadcast authorizations past validBefore.
 *   4. Crash recovery: `settling` rows whose attempt died mid-flight.
 *   5. Unknown-outcome cap: broadcast rows still undetermined 24 h after expiry.
 *   5b. Escrow sweep: funded tasks accepted/cancelled without a running payout
 *      leg get (re-)signed by the house wallet (payments/escrow.ts).
 *
 * Every query is bounded (LIMIT 50) and every row is isolated in try/catch so
 * one bad row never stalls the loop. Exported for tests with an injected clock.
 */
import type { DBAdapter } from '../db/adapter.js';
import type { Bindings } from '../types/index.js';
import { paymentProviderFor } from '../payments/index.js';
import { settleTask, UNKNOWN_OUTCOME_MAX_MS, escrowLegFailedSql } from '../payments/settle.js';
import { startEscrowLeg, escrowSweep } from '../payments/escrow.js';
import {
  loadTask, autoAcceptGate, claimExpiryGate, openExpiryGate, afterAccept, logPaymentEvent, agentTarget, creatorTarget, isoPlus,
  bountyView, notifyMatchingAgents, recordFunnel,
} from '../tasks/service.js';
import { defaultOpenExpiresAt } from '../tasks/expiry.js';
// Owner expiry email (best-effort; proprietary control plane — absent tables skip).
import { ControlStore } from '../control/store.js';
import { emailSenderFromEnv } from '../control/email.js';
import { recordEvent, drainOutbox } from '../events/service.js';
import { slashBondForExpiredClaim } from '../tasks/governance.js';
import { settleDueBondWithdrawals } from '../tasks/bonds.js';

export interface TaskCronSummary {
  auto_accepted: number;
  claims_expired: number;
  /** Open-task expiry (0047): `open` tasks whose window lapsed unclaimed this tick. */
  open_expired: number;
  settle_attempted: number;
  settled: number;
  expired: number;
  recovered: number;
  capped: number;
  settle_skipped_reason: string | null;
  /** Claim-bond governance: expired-claim slashes and withdrawal payouts this tick. */
  bonds_slashed: number;
  bond_withdrawals_settled: number;
  bond_withdrawals_refunded: number;
  /** Escrow sweep: payout legs (re-)started this tick, and funded tasks that gave up (manual). */
  escrow_swept: number;
  escrow_stuck: number;
}

const BATCH = 50;

export async function runTaskCron(db: DBAdapter, env: Bindings, nowIso: string = new Date().toISOString()): Promise<TaskCronSummary> {
  const summary: TaskCronSummary = {
    auto_accepted: 0, claims_expired: 0, open_expired: 0, settle_attempted: 0, settled: 0, expired: 0, recovered: 0, capped: 0, settle_skipped_reason: null,
    bonds_slashed: 0, bond_withdrawals_settled: 0, bond_withdrawals_refunded: 0,
    escrow_swept: 0, escrow_stuck: 0,
  };

  // 1. Auto-accept
  const due = await db.all<{ task_id: string }>(
    `SELECT task_id FROM tasks WHERE status = 'submitted' AND disputed_at IS NULL
       AND auto_release_at IS NOT NULL AND auto_release_at <= ? LIMIT ?`,
    nowIso, BATCH,
  );
  for (const { task_id } of due) {
    try {
      if (!(await autoAcceptGate(db, task_id, nowIso))) continue;
      const task = await loadTask(db, task_id);
      if (!task) continue;
      summary.auto_accepted++;
      await afterAccept(db, task, { acceptedBy: 'auto', by: { kind: 'auto' }, nowIso, paymentStatus: task.payment_status });
      if (task.bounty_amount && task.escrow) {
        // The deposit is held: silence pays the deliverer (house-signed release; the sweep retries).
        await logPaymentEvent(db, task_id, 'auto_accepted', { payment_status: task.payment_status, escrow_status: task.escrow_status }, nowIso);
        await startEscrowLeg(db, env, task_id, 'release', 'cron', nowIso);
      } else if (task.bounty_amount) {
        await logPaymentEvent(db, task_id, 'auto_accepted', { payment_status: task.payment_status }, nowIso);
        const creator = await creatorTarget(db, task);
        if (creator) await recordEvent(db, creator.id, { type: 'task.payment_due', agent_id: creator.id, task_id, amount_atomic: task.bounty_amount }, nowIso);
      }
    } catch (err) {
      console.error(`[cron] auto-accept failed for ${task_id}:`, err);
    }
  }

  // 1b. Claim expiry: a claimed task whose claimer never delivered within the
  // claim window returns to `open` for anyone to re-claim. The former claimer is
  // told their claim lapsed; matching agents are re-notified the work is available
  // again (event-driven, one-shot — excluding the ex-claimer so they don't just
  // re-grab and sit on it). Never touches payment columns (nothing was authorized).
  const staleClaims = await db.all<{ task_id: string }>(
    `SELECT task_id FROM tasks WHERE status = 'claimed'
       AND claim_expires_at IS NOT NULL AND claim_expires_at <= ? LIMIT ?`,
    nowIso, BATCH,
  );
  for (const { task_id } of staleClaims) {
    try {
      const task = await loadTask(db, task_id);
      const exClaimer = task?.claimed_by_agent_id ?? null;
      // Gate is authoritative: false if the claimer delivered between SELECT and now.
      // The reopened task gets a fresh open window (a NULL/never window stays NULL).
      if (!(await claimExpiryGate(db, task_id, nowIso, defaultOpenExpiresAt(env, nowIso)))) continue;
      summary.claims_expired++;
      if (exClaimer) await recordEvent(db, exClaimer, { type: 'task.claim_expired', agent_id: exClaimer, task_id }, nowIso);
      // Sitting on a claim until it expires is the one abuse a bond exists
      // to price: slash it (no-op without a bond).
      if (exClaimer) {
        try {
          const slashed = await slashBondForExpiredClaim(db, env, exClaimer, task_id, nowIso);
          if (slashed !== '0') summary.bonds_slashed++;
        } catch { /* the reopen must never fail on ledger trouble */ }
      }
      if (task) {
        let reqCaps: string[] | null = null;
        try { reqCaps = task.required_capabilities ? JSON.parse(task.required_capabilities) as string[] : null; } catch { reqCaps = null; }
        await notifyMatchingAgents(db, {
          task_id: task.task_id, title: task.title, description: task.description, category: task.category,
          required_capabilities: reqCaps, output_format: task.output_format, bounty: bountyView(task),
        }, exClaimer);
      }
    } catch (err) {
      console.error(`[cron] claim-expiry failed for ${task_id}:`, err);
    }
  }

  // 1c. Open-task expiry (0047, decision D13): an `open` task nobody claimed
  // within its window becomes `expired` (terminal). The creator is told; a
  // FUNDED escrow deposit goes back to the buyer (house-signed refund leg —
  // the same money path as cancel; escrowSweep retries a refused start), and
  // the gate voids a never-settled declared bounty. The window is part of the
  // gate's predicate, so a claim racing the sweep wins cleanly.
  // The SELECT repeats the gate's blocking predicates so a deposit still
  // moving in never occupies the batch: 50 rows the gate refuses every tick
  // would starve every other due task behind them.
  const staleOpen = await db.all<{ task_id: string }>(
    `SELECT task_id FROM tasks WHERE status = 'open'
       AND expires_at IS NOT NULL AND expires_at <= ?
       AND payment_status NOT IN ('authorized','settling','settled')
       AND NOT (escrow = 1 AND escrow_status = 'funding' AND settle_broadcast = 1)
     LIMIT ?`,
    nowIso, BATCH,
  );
  for (const { task_id } of staleOpen) {
    try {
      const task = await loadTask(db, task_id);
      if (!task) continue;
      const creator = await creatorTarget(db, task);
      const expired = await openExpiryGate(db, task_id, nowIso, {
        recipientAgentId: creator?.id ?? null,
        event: { type: 'task.expired', agent_id: creator?.id ?? '', task_id },
      });
      if (!expired) continue;
      summary.open_expired++;
      if (task.escrow && task.escrow_status === 'funded') {
        await logPaymentEvent(db, task_id, 'escrow_refund_requested', { reason: 'task_expired' }, nowIso);
        await startEscrowLeg(db, env, task_id, 'refund', 'cron', nowIso);
      } else if (task.bounty_amount && ['pending', 'failed'].includes(task.payment_status)) {
        await logPaymentEvent(db, task_id, 'expired', { reason: 'task_expired' }, nowIso);
      }
      // A human poster has no agent inbox: tell them by email, best-effort
      // (LogEmailSender in dev; OSS deploys without the owners table skip).
      if (task.creator_kind === 'owner' && task.creator_owner_id) {
        try {
          const owner = await new ControlStore(db).getOwner(task.creator_owner_id);
          if (owner?.email) {
            const origin = (env as { KEYRING_CONSOLE_ORIGIN?: string }).KEYRING_CONSOLE_ORIGIN || 'https://app.basedagents.ai';
            const refundLine = task.escrow && task.escrow_status === 'funded'
              ? ' The escrowed deposit is being refunded to the wallet that paid it.'
              : '';
            await emailSenderFromEnv(env).send({
              to: owner.email,
              subject: 'Your task expired unclaimed',
              text: `Nobody claimed "${task.title}" within its open window, so it expired.${refundLine}\n\nPost it again to relist: ${origin}/tasks/${task_id}\n\n— BasedAgents`,
            });
          }
        } catch (err) {
          console.error(`[cron] expiry email failed for ${task_id}:`, err);
        }
      }
      await recordFunnel(db, 'task_expired', task_id, null);
    } catch (err) {
      console.error(`[cron] open-expiry failed for ${task_id}:`, err);
    }
  }

  // 2. Settle retry
  if (!paymentProviderFor(env)) {
    summary.settle_skipped_reason = 'payments_disabled';
  } else {
    const rows = await db.all<{ task_id: string }>(
      `SELECT task_id FROM tasks WHERE (status = 'verified' OR escrow_leg IN ('deposit','refund'))
         AND payment_status IN ('authorized','failed','settling')
         AND payment_signature IS NOT NULL AND settle_next_at IS NOT NULL AND settle_next_at <= ? LIMIT ?`,
      nowIso, BATCH,
    );
    for (const { task_id } of rows) {
      try {
        summary.settle_attempted++;
        const r = await settleTask(db, env, task_id, 'cron', nowIso);
        if (!r.skipped && r.payment_status === 'settled') summary.settled++;
      } catch (err) {
        console.error(`[cron] settle failed for ${task_id}:`, err);
      }
    }
  }

  // 3. Expiry sweep (never touches settling or broadcast rows)
  const stale = await db.all<{ task_id: string; payment_status: string; escrow_leg: 'deposit' | 'release' | 'refund' | null }>(
    `SELECT task_id, payment_status, escrow_leg FROM tasks WHERE payment_status IN ('authorized','failed') AND settle_broadcast = 0
       AND payment_expires_at IS NOT NULL AND payment_expires_at <= ? LIMIT ?`,
    nowIso, BATCH,
  );
  for (const row of stale) {
    try {
      const res = await db.run(
        `UPDATE tasks SET payment_status = 'expired', settle_next_at = NULL, last_settle_error = 'authorization_expired', last_settle_class = 'expired'${escrowLegFailedSql(row.escrow_leg)}
         WHERE task_id = ? AND payment_status = ? AND settle_broadcast = 0`,
        row.task_id, row.payment_status,
      );
      if (res.changes !== 1) continue;
      summary.expired++;
      await logPaymentEvent(db, row.task_id, 'expired', { reason: 'authorization_expired', trigger: 'cron' }, nowIso);
      const task = await loadTask(db, row.task_id);
      if (task) {
        for (const t of [await agentTarget(db, task.claimed_by_agent_id), await creatorTarget(db, task)]) {
          if (t) await recordEvent(db, t.id, { type: 'task.payment_failed', agent_id: t.id, task_id: task.task_id, reason: 'expired' }, nowIso);
        }
      }
    } catch (err) {
      console.error(`[cron] expiry sweep failed for ${row.task_id}:`, err);
    }
  }

  // 4. Crash recovery: a settle attempt that died leaves settling + settle_next_at NULL.
  const recovered = await db.run(
    `UPDATE tasks SET settle_next_at = ? WHERE payment_status = 'settling' AND settle_next_at IS NULL
       AND settle_started_at IS NOT NULL AND settle_started_at <= ?`,
    nowIso, isoPlus(nowIso, -10 * 60_000),
  );
  summary.recovered = recovered.changes;

  // 5. Unknown-outcome cap
  const capped = await db.all<{ task_id: string }>(
    `SELECT task_id FROM tasks WHERE settle_broadcast = 1 AND payment_status = 'failed' AND settle_next_at IS NOT NULL
       AND payment_expires_at IS NOT NULL AND payment_expires_at <= ? LIMIT ?`,
    isoPlus(nowIso, -UNKNOWN_OUTCOME_MAX_MS), BATCH,
  );
  for (const { task_id } of capped) {
    try {
      const res = await db.run(
        `UPDATE tasks SET settle_next_at = NULL, last_settle_error = 'unknown_outcome_manual', last_settle_class = 'unknown'
         WHERE task_id = ? AND payment_status = 'failed' AND settle_broadcast = 1 AND settle_next_at IS NOT NULL`,
        task_id,
      );
      if (res.changes !== 1) continue;
      summary.capped++;
      await logPaymentEvent(db, task_id, 'settle_failed', { error: 'unknown_outcome_manual', trigger: 'cron' }, nowIso);
      console.error(`[payments] ${task_id}: settlement outcome unknown 24h after expiry — manual reconciliation required`);
    } catch (err) {
      console.error(`[cron] unknown-outcome cap failed for ${task_id}:`, err);
    }
  }

  // 5b. Escrow sweep: (re-)sign payout legs for funded tasks that were accepted or cancelled.
  if (paymentProviderFor(env)) {
    try {
      const swept = await escrowSweep(db, env, nowIso, BATCH);
      summary.escrow_swept = swept.attempted;
      summary.escrow_stuck = swept.stuck;
    } catch (err) {
      console.error('[cron] escrow sweep failed:', err);
    }
  }

  // 6. Agent Inbox outbox: push pending inbox events to recipients' webhooks
  // (with retry/backoff). The inbox itself is written synchronously at event
  // time; this is the optional push layer.
  try {
    await drainOutbox(db, nowIso, 200);
  } catch (err) {
    console.error('[cron] outbox drain failed:', err);
  }

  // Bond withdrawal payouts (durable rows; terminal failures re-credit).
  try {
    const w = await settleDueBondWithdrawals(db, env, nowIso);
    summary.bond_withdrawals_settled = w.settled;
    summary.bond_withdrawals_refunded = w.refunded;
  } catch { /* payouts retry next tick */ }

  return summary;
}
