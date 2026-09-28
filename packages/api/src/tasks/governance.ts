/**
 * Claim governance — how many open claims one agent may hold (migration 0044).
 *
 * Neutral marketplace policy, enforced authoritatively inside the atomic
 * claim gate (tasks/service.ts) and surfaced here for advisory route errors
 * and the budget view. No control-plane imports.
 *
 * The GLOBAL budget scales with reputation:
 *
 *   budget = clamp( base
 *                   + perAccept × human-accepted deliveries
 *                   − penalty  × (expired claims + disputes)
 *                   + bonded slots,
 *                   floor, max )
 *
 * Auto-accepted deliveries count for NOTHING — silence must not farm
 * budget. Expired claims are counted from the claimer's own
 * `task.claim_expired` events; disputes from tasks the agent delivered.
 *
 * Money: USDC atomic units (6 dp) as digit strings, summed via CAST; every
 * value is validated to fit far below 2^53.
 */
import type { DBAdapter } from '../db/adapter.js';

export interface ClaimGovernanceConfig {
  /** Budget for a brand-new identity (default 10 — micro-task friendly). */
  base: number;
  /** Ceiling on any budget, bond included (default 1000). */
  max: number;
  /** Floor — reputation damage never locks an agent out entirely (default 2). */
  floor: number;
  /** Budget gained per human-accepted delivery (default 10). */
  perAccept: number;
  /** Budget lost per expired claim or dispute (default 25). */
  penalty: number;
  /** One additional budget slot per this much bonded USDC (default 1 USDC). */
  bondPerSlotAtomic: string;
  /** Slashed from the bond when a claim expires unworked (default 1 USDC). */
  slashPerExpiryAtomic: string;
}

function intFromEnv(env: unknown, key: string, dflt: number, min: number, max: number): number {
  const raw = ((env ?? {}) as Record<string, string | undefined>)[key];
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

export function claimGovernanceConfig(env: unknown): ClaimGovernanceConfig {
  return {
    base: intFromEnv(env, 'CLAIM_BUDGET_BASE', 10, 1, 1000),
    max: intFromEnv(env, 'CLAIM_BUDGET_MAX', 1000, 1, 100_000),
    floor: intFromEnv(env, 'CLAIM_BUDGET_FLOOR', 2, 1, 1000),
    perAccept: intFromEnv(env, 'CLAIM_BUDGET_PER_ACCEPT', 10, 0, 1000),
    penalty: intFromEnv(env, 'CLAIM_BUDGET_PENALTY', 25, 0, 10_000),
    bondPerSlotAtomic: String(intFromEnv(env, 'CLAIM_BOND_PER_SLOT_ATOMIC', 1_000_000, 1, 1_000_000_000)),
    slashPerExpiryAtomic: String(intFromEnv(env, 'CLAIM_BOND_SLASH_ATOMIC', 1_000_000, 0, 1_000_000_000)),
  };
}

/**
 * Claim window scaled to the bounty: a $0.10 task must not be lockable for
 * a week. Free tasks keep the long window — they cost the poster nothing
 * while claimed.
 */
export const CLAIM_WINDOW_MICRO_MS = 12 * 60 * 60 * 1000; // < 1 USDC
export const CLAIM_WINDOW_SMALL_MS = 48 * 60 * 60 * 1000; // < 10 USDC
export const CLAIM_WINDOW_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;

export function claimWindowMsForBounty(bountyAtomic: string | null | undefined): number {
  if (!bountyAtomic || !/^[0-9]{1,15}$/.test(bountyAtomic)) return CLAIM_WINDOW_DEFAULT_MS;
  const n = Number(bountyAtomic);
  if (n < 1_000_000) return CLAIM_WINDOW_MICRO_MS;
  if (n < 10_000_000) return CLAIM_WINDOW_SMALL_MS;
  return CLAIM_WINDOW_DEFAULT_MS;
}

export interface ClaimBudgetView {
  budget: number;
  active_claims: number;
  base: number;
  accepted_deliveries: number;
  expired_claims: number;
  disputes: number;
  bond_balance_atomic: string;
  bond_slots: number;
}

const isAtomic = (v: string) => /^[0-9]{1,15}$/.test(v);

export async function bondBalanceAtomic(db: DBAdapter, agentId: string): Promise<string> {
  const row = await db.get<{ balance_atomic: string }>(
    'SELECT balance_atomic FROM agent_claim_bonds WHERE agent_id = ?', agentId,
  );
  return row && isAtomic(row.balance_atomic) ? row.balance_atomic : '0';
}

/** The full budget view: what the gate enforces and the agent can inspect. */
export async function claimBudget(db: DBAdapter, env: unknown, agentId: string): Promise<ClaimBudgetView> {
  const cfg = claimGovernanceConfig(env);
  const [accepted, expired, disputed, active, bond] = await Promise.all([
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE claimed_by_agent_id = ? AND status = 'verified'
          AND (accepted_by IS NULL OR accepted_by <> 'auto')`, agentId,
    ),
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_events WHERE agent_id = ? AND type = 'task.claim_expired'`, agentId,
    ),
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks WHERE claimed_by_agent_id = ? AND disputed_at IS NOT NULL`, agentId,
    ),
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks WHERE claimed_by_agent_id = ? AND status = 'claimed'`, agentId,
    ),
    bondBalanceAtomic(db, agentId),
  ]);
  const bondSlots = Math.floor(Number(bond) / Number(cfg.bondPerSlotAtomic));
  const raw = cfg.base
    + cfg.perAccept * (accepted?.n ?? 0)
    - cfg.penalty * ((expired?.n ?? 0) + (disputed?.n ?? 0))
    + bondSlots;
  return {
    budget: Math.max(cfg.floor, Math.min(cfg.max, raw)),
    active_claims: active?.n ?? 0,
    base: cfg.base,
    accepted_deliveries: accepted?.n ?? 0,
    expired_claims: expired?.n ?? 0,
    disputes: disputed?.n ?? 0,
    bond_balance_atomic: bond,
    bond_slots: bondSlots,
  };
}

// ─── bond ledger (guarded arithmetic on digit strings via CAST) ───

function randomId(prefix: string): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

async function bondEvent(db: DBAdapter, agentId: string, kind: string, amountAtomic: string, ref: string | null, nowIso: string): Promise<void> {
  await db.run(
    `INSERT INTO agent_claim_bond_events (id, agent_id, kind, amount_atomic, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    randomId('bev'), agentId, kind, amountAtomic, ref, nowIso,
  );
}

export async function creditBond(db: DBAdapter, agentId: string, amountAtomic: string, kind: 'deposit' | 'withdraw_reverted', ref: string | null, nowIso: string): Promise<void> {
  if (!isAtomic(amountAtomic)) throw new Error('creditBond: amount must be a digit string of USDC atomic units');
  await db.run(
    `INSERT INTO agent_claim_bonds (agent_id, balance_atomic, total_deposited_atomic, total_slashed_atomic, created_at, updated_at)
     VALUES (?, '0', '0', '0', ?, ?)
     ON CONFLICT(agent_id) DO NOTHING`,
    agentId, nowIso, nowIso,
  );
  await db.run(
    `UPDATE agent_claim_bonds SET
       balance_atomic = CAST(CAST(balance_atomic AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
       total_deposited_atomic = CASE WHEN ? = 'deposit'
         THEN CAST(CAST(total_deposited_atomic AS INTEGER) + CAST(? AS INTEGER) AS TEXT)
         ELSE total_deposited_atomic END,
       updated_at = ?
     WHERE agent_id = ?`,
    amountAtomic, kind, amountAtomic, nowIso, agentId,
  );
  await bondEvent(db, agentId, kind, amountAtomic, ref, nowIso);
}

/** Guarded debit — false when the balance cannot cover the amount. */
export async function debitBond(db: DBAdapter, agentId: string, amountAtomic: string, kind: 'slash' | 'withdraw', ref: string | null, nowIso: string): Promise<boolean> {
  if (!isAtomic(amountAtomic)) throw new Error('debitBond: amount must be a digit string of USDC atomic units');
  const res = await db.run(
    `UPDATE agent_claim_bonds SET
       balance_atomic = CAST(CAST(balance_atomic AS INTEGER) - CAST(? AS INTEGER) AS TEXT),
       total_slashed_atomic = CASE WHEN ? = 'slash'
         THEN CAST(CAST(total_slashed_atomic AS INTEGER) + CAST(? AS INTEGER) AS TEXT)
         ELSE total_slashed_atomic END,
       updated_at = ?
     WHERE agent_id = ? AND CAST(balance_atomic AS INTEGER) >= CAST(? AS INTEGER)`,
    amountAtomic, kind, amountAtomic, nowIso, agentId, amountAtomic,
  );
  if (res.changes !== 1) return false;
  await bondEvent(db, agentId, kind, amountAtomic, ref, nowIso);
  return true;
}

/**
 * Slash on claim expiry (cron): takes min(balance, configured slash) so a
 * nearly-empty bond is drained rather than skipped. No-op without a bond.
 */
export async function slashBondForExpiredClaim(db: DBAdapter, env: unknown, agentId: string, taskId: string, nowIso: string): Promise<string> {
  const cfg = claimGovernanceConfig(env);
  if (cfg.slashPerExpiryAtomic === '0') return '0';
  const balance = await bondBalanceAtomic(db, agentId);
  const amount = String(Math.min(Number(balance), Number(cfg.slashPerExpiryAtomic)));
  if (amount === '0') return '0';
  return (await debitBond(db, agentId, amount, 'slash', `claim_expired:${taskId}`, nowIso)) ? amount : '0';
}
