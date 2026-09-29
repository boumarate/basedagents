-- 0045: open-task expiry (decision D13). An `open` task nobody claims within
-- its open window becomes `expired` (new terminal status; swept by the cron).
-- Two new columns: expires_at (the window's end, stamped at post; NULL =
-- never, house standing tasks) and expired_at (when the sweep fired).
--
-- Full rebuild, 0035 precedent: SQLite cannot widen the status CHECK in
-- place. tasks is referenced by submissions / delivery_receipts /
-- payment_events, so the rebuild keeps the table NAME: back up, drop,
-- recreate, refill. Runs inside D1's migration transaction; node.ts wraps
-- each file in a better-sqlite3 transaction so the pragma is effective
-- locally too.
--
-- Grandfathering: rows that are `open` at migration time get
-- expires_at = now + 7 days (ISO-8601 with 'T', matching the app's
-- toISOString() strings so lexicographic compares hold), so the first sweep
-- after a deploy never purges the board without a full week's notice.
-- Non-open rows keep NULL; a claimed task that later returns to `open` is
-- re-stamped by the claim-expiry gate.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE tasks_backup AS SELECT * FROM tasks;
DROP TABLE tasks;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  creator_agent_id TEXT REFERENCES agents(id),
  creator_owner_id TEXT,                                 -- ow_…; NO FK (owners absent on OSS deploys, 0033:15-18)
  creator_kind TEXT NOT NULL DEFAULT 'agent' CHECK (creator_kind IN ('agent','owner')),
  creator_assertion_id TEXT,
  claimed_by_agent_id TEXT REFERENCES agents(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  required_capabilities TEXT,
  expected_output TEXT,
  output_format TEXT DEFAULT 'json',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','submitted','verified','closed','cancelled','expired')),
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  submitted_at TEXT,
  verified_at TEXT,
  accepted_by TEXT CHECK (accepted_by IS NULL OR accepted_by IN ('creator','auto')),
  review_note TEXT,
  review_assertion_id TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  revision_requested_at TEXT,
  disputed_at TEXT,
  cancelled_at TEXT,
  proposer_signature TEXT,
  acceptor_signature TEXT,
  bounty_amount TEXT,                                    -- atomic units, digits only
  bounty_token TEXT,
  bounty_network TEXT,
  payment_status TEXT NOT NULL DEFAULT 'none',           -- no CHECK on purpose (N2)
  payment_signature TEXT,
  payment_requirements TEXT,
  payment_payer TEXT,
  payment_nonce TEXT,
  payment_verified INTEGER NOT NULL DEFAULT 0,
  payment_settled INTEGER NOT NULL DEFAULT 0,
  payment_tx_hash TEXT,
  payment_expires_at TEXT,
  auto_release_at TEXT,
  settle_attempts INTEGER NOT NULL DEFAULT 0,
  settle_broadcast INTEGER NOT NULL DEFAULT 0,
  settle_started_at TEXT,
  settle_next_at TEXT,
  settled_at TEXT,
  last_settle_error TEXT,
  last_settle_class TEXT,                                -- payments/settle.ts SettleClass
  claim_expires_at TEXT,                                 -- 0038: claim-delivery timer
  -- ─── Escrow (0039) — see payments/escrow.ts ───
  escrow INTEGER NOT NULL DEFAULT 0,
  escrow_status TEXT,
  escrow_leg TEXT,
  escrow_leg_attempts INTEGER NOT NULL DEFAULT 0,
  escrow_wallet TEXT,
  escrow_deposit_payer TEXT,
  escrow_deposit_nonce TEXT,
  escrow_deposit_tx_hash TEXT,
  escrow_funded_at TEXT,
  escrow_release_tx_hash TEXT,
  escrow_released_at TEXT,
  escrow_refund_tx_hash TEXT,
  escrow_refunded_at TEXT,
  max_active_claims_per_agent INTEGER,                   -- 0044: campaign cap
  -- ─── Open-task expiry (0045) ───
  expires_at TEXT,                                       -- end of the open window; NULL = never (house standing tasks)
  expired_at TEXT,
  CHECK ((creator_agent_id IS NULL) <> (creator_owner_id IS NULL))
);

INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, creator_kind, creator_assertion_id, claimed_by_agent_id,
  title, description, category, required_capabilities, expected_output, output_format, status, created_at,
  claimed_at, submitted_at, verified_at, accepted_by, review_note, review_assertion_id, revision_count,
  revision_requested_at, disputed_at, cancelled_at, proposer_signature, acceptor_signature,
  bounty_amount, bounty_token, bounty_network, payment_status, payment_signature, payment_requirements,
  payment_payer, payment_nonce, payment_verified, payment_settled, payment_tx_hash, payment_expires_at,
  auto_release_at, settle_attempts, settle_broadcast, settle_started_at, settle_next_at, settled_at,
  last_settle_error, last_settle_class, claim_expires_at,
  escrow, escrow_status, escrow_leg, escrow_leg_attempts, escrow_wallet, escrow_deposit_payer,
  escrow_deposit_nonce, escrow_deposit_tx_hash, escrow_funded_at, escrow_release_tx_hash, escrow_released_at,
  escrow_refund_tx_hash, escrow_refunded_at, max_active_claims_per_agent, expires_at, expired_at)
SELECT task_id, creator_agent_id, creator_owner_id, creator_kind, creator_assertion_id, claimed_by_agent_id,
  title, description, category, required_capabilities, expected_output, output_format, status, created_at,
  claimed_at, submitted_at, verified_at, accepted_by, review_note, review_assertion_id, revision_count,
  revision_requested_at, disputed_at, cancelled_at, proposer_signature, acceptor_signature,
  bounty_amount, bounty_token, bounty_network, payment_status, payment_signature, payment_requirements,
  payment_payer, payment_nonce, payment_verified, payment_settled, payment_tx_hash, payment_expires_at,
  auto_release_at, settle_attempts, settle_broadcast, settle_started_at, settle_next_at, settled_at,
  last_settle_error, last_settle_class, claim_expires_at,
  escrow, escrow_status, escrow_leg, escrow_leg_attempts, escrow_wallet, escrow_deposit_payer,
  escrow_deposit_nonce, escrow_deposit_tx_hash, escrow_funded_at, escrow_release_tx_hash, escrow_released_at,
  escrow_refund_tx_hash, escrow_refunded_at, max_active_claims_per_agent,
  CASE WHEN status = 'open' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days') END,
  NULL
FROM tasks_backup;

DROP TABLE tasks_backup;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimer ON tasks(claimed_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_payment_status ON tasks(payment_status);
CREATE INDEX IF NOT EXISTS idx_tasks_auto_release ON tasks(auto_release_at);
CREATE INDEX IF NOT EXISTS idx_tasks_creator_owner ON tasks(creator_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_settle ON tasks(payment_status, settle_next_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_payment_nonce ON tasks(payment_nonce) WHERE payment_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_claim_expires ON tasks(claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_escrow_sweep ON tasks(escrow_status, status) WHERE escrow = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_escrow_deposit_nonce ON tasks(escrow_deposit_nonce) WHERE escrow_deposit_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_payment_settled ON tasks(payment_status, settled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_claimer_status ON tasks(claimed_by_agent_id, status);
-- The open-expiry sweep's population (cron): open rows past their window.
CREATE INDEX IF NOT EXISTS idx_tasks_open_expires ON tasks(status, expires_at);
