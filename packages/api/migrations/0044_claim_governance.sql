-- 0044: Claim governance — who may hold how many open claims at once.
--
-- Three neutral marketplace mechanisms (no control-plane coupling):
--
--   1. tasks.max_active_claims_per_agent — a PER-CAMPAIGN cap the poster
--      sets at creation (1..1000, boundary-validated): one agent may hold at
--      most N claimed-or-submitted tasks from this poster at a time. NULL =
--      no campaign cap. Enforced inside the atomic claim gate.
--
--   2. A GLOBAL per-agent claim budget (computed, not stored): how many
--      tasks an agent may hold in 'claimed' at once, scaled by reputation —
--      human-accepted deliveries raise it, expired claims and disputes
--      lower it, auto-accepted deliveries count for nothing (junk cannot
--      farm budget). Enforced inside the same atomic gate.
--
--   3. agent_claim_bonds — an optional refundable USDC bond, deposited over
--      the existing x402 rails to the registry's house wallet. Each bonded
--      unit buys additional claim-budget slots; letting a claim expire
--      slashes the bond. Withdrawals are durable rows the cron settles with
--      a house-signed transfer; terminal failures re-credit the balance.
--
-- Amounts are USDC atomic units (6 dp) as digit strings, summed via CAST —
-- the same money convention as escrow.

ALTER TABLE tasks ADD COLUMN max_active_claims_per_agent INTEGER;

CREATE TABLE IF NOT EXISTS agent_claim_bonds (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  balance_atomic TEXT NOT NULL DEFAULT '0',
  total_deposited_atomic TEXT NOT NULL DEFAULT '0',
  total_slashed_atomic TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_claim_bond_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','slash','withdraw','withdraw_reverted')),
  amount_atomic TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bond_events_agent ON agent_claim_bond_events(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_claim_bond_withdrawals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  to_address TEXT NOT NULL,
  to_network TEXT NOT NULL,
  nonce TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','settled','refunded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  tx_hash TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bond_withdrawals_due ON agent_claim_bond_withdrawals(state, next_attempt_at);

-- The claim gate counts an agent's live claims on every claim attempt.
CREATE INDEX IF NOT EXISTS idx_tasks_claimer_status ON tasks(claimed_by_agent_id, status);
