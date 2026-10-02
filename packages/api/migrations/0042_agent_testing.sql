-- 0042: Agent Testing by BasedAgents — managed agent-compatibility audits.
--
-- A human buys a scoped audit with a card (Stripe, one-time). The platform
-- commissions bounded execution through the existing task marketplace under a
-- dedicated service principal, reviews the evidence, and publishes ONE private
-- report. Billing state (payment/refund/dispute) and fulfillment state are
-- orthogonal columns, never one merged status.
--
-- Monetary units: customer money is integer USD cents; worker commitments are
-- USDC atomic units (6 dp) stored as decimal strings (summed via CAST — every
-- value fits in 64-bit and is validated as a digit string at the boundary).
--
-- `task_claim_allowlist` (at the end) is a NEUTRAL marketplace extension:
-- a task with allowlist rows is claimable only by listed agents, enforced
-- inside the atomic claim gate. It is generic (usable by any deploy) and the
-- OSS claim path has no import on control-plane code — it only consults the
-- table when it exists.

-- ─── Intake ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS testing_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  intake_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','needs_changes','declined','quoted')),
  version INTEGER NOT NULL DEFAULT 1,
  operator_note TEXT,
  source TEXT NOT NULL DEFAULT 'external_customer'
    CHECK (source IN ('external_customer','founder_sample','test_fixture')),
  previous_order_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testing_requests_owner ON testing_requests(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_testing_requests_status ON testing_requests(status, updated_at);

-- ─── Quotes (frozen scope + price snapshot) ───────────────────────────────
CREATE TABLE IF NOT EXISTS testing_quotes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES testing_requests(id),
  request_version INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  package_key TEXT NOT NULL,
  package_version INTEGER NOT NULL,
  stripe_price_id TEXT,
  subtotal_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  tax_mode TEXT NOT NULL DEFAULT 'none' CHECK (tax_mode IN ('none','stripe_tax','manual')),
  worker_cap_usdc_atomic TEXT NOT NULL,
  worker_bounty_usdc_atomic TEXT NOT NULL,
  external_run_slots INTEGER NOT NULL,
  retest_slots INTEGER NOT NULL,
  retest_window_days INTEGER NOT NULL,
  min_operator_groups INTEGER NOT NULL,
  terms_version TEXT NOT NULL,
  disclosure_version TEXT NOT NULL,
  delivery_target_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('draft','approved','accepted','expired','superseded','withdrawn')),
  approved_by TEXT,
  approve_assertion_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (request_id, request_version)
);
CREATE INDEX IF NOT EXISTS idx_testing_quotes_request ON testing_quotes(request_id);

-- ─── Orders (billing states ⊥ fulfillment state) ──────────────────────────
CREATE TABLE IF NOT EXISTS testing_orders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  quote_id TEXT NOT NULL UNIQUE REFERENCES testing_quotes(id),
  request_id TEXT NOT NULL REFERENCES testing_requests(id),
  source TEXT NOT NULL DEFAULT 'external_customer'
    CHECK (source IN ('external_customer','founder_sample','test_fixture')),
  payment_state TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_state IN ('unpaid','processing','succeeded','failed')),
  refund_state TEXT NOT NULL DEFAULT 'none'
    CHECK (refund_state IN ('none','pending','partial','full','failed')),
  dispute_state TEXT NOT NULL DEFAULT 'none'
    CHECK (dispute_state IN ('none','open','won','lost')),
  fulfillment_state TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (fulfillment_state IN ('awaiting_payment','needs_inputs','ready','running','reviewing','delivered','paused','cancelled','cannot_fulfill')),
  paused_from_state TEXT,
  risk_hold INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  cancel_request_reason TEXT,
  collected_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  initial_report_id TEXT,
  initial_report_published_at TEXT,
  retest_deadline_at TEXT,
  previous_order_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testing_orders_owner ON testing_orders(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_testing_orders_fulfillment ON testing_orders(fulfillment_state, updated_at);

-- ─── Checkout attempts (one Stripe session each; failures never overwrite a later success) ───
CREATE TABLE IF NOT EXISTS testing_checkout_attempts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES testing_orders(id),
  attempt INTEGER NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating'
    CHECK (state IN ('creating','open','completed','expired','failed','superseded','needs_reconciliation')),
  quoted_subtotal_cents INTEGER NOT NULL,
  quoted_currency TEXT NOT NULL,
  confirmed_subtotal_cents INTEGER,
  confirmed_tax_cents INTEGER,
  confirmed_total_cents INTEGER,
  confirmed_currency TEXT,
  checkout_url TEXT,
  livemode INTEGER,
  last_error TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_testing_checkout_order ON testing_checkout_attempts(order_id, attempt);

-- ─── Runs (fixed plan: B0 baseline, E1–E3 external, R1 retest) ────────────
CREATE TABLE IF NOT EXISTS testing_runs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES testing_orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('baseline','external','retest')),
  slot INTEGER NOT NULL,
  scope_hash TEXT NOT NULL,
  environment_json TEXT NOT NULL,
  result_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (result_state IN ('pending','executing','evidence_submitted','evidence_invalid','product_success','product_failure','inconclusive')),
  operator_group_id TEXT,
  environment_observed_json TEXT,
  reviewed_result_json TEXT,
  environment_demonstrated INTEGER,
  slot_satisfied INTEGER,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_assertion_id TEXT,
  parent_finding_id TEXT,
  parent_run_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, kind, slot)
);
CREATE INDEX IF NOT EXISTS idx_testing_runs_order ON testing_runs(order_id);

-- ─── Run attempts (marketplace mirror; ≤1 ACTIVE attempt per run) ─────────
CREATE TABLE IF NOT EXISTS testing_run_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES testing_runs(id),
  attempt INTEGER NOT NULL,
  task_id TEXT UNIQUE,
  publication_ref TEXT NOT NULL UNIQUE,
  agent_id TEXT,
  brief_revision INTEGER NOT NULL DEFAULT 1,
  brief_json TEXT NOT NULL,
  reservation_id TEXT,
  state TEXT NOT NULL DEFAULT 'publishing'
    CHECK (state IN ('publishing','published','claimed','submitted','accepted','invalid','replaced','cancelled','failed')),
  active INTEGER NOT NULL DEFAULT 1,
  task_status_mirror TEXT,
  payment_status_mirror TEXT,
  result_json TEXT,
  result_receipt_id TEXT,
  result_valid INTEGER,
  result_invalid_reason TEXT,
  evidence_hashes_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, attempt)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_testing_attempt_one_active ON testing_run_attempts(run_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_testing_attempt_task ON testing_run_attempts(task_id);

-- ─── Worker eligibility (operator-reviewed; operator_group_id is PRIVATE) ──
CREATE TABLE IF NOT EXISTS testing_worker_eligibility (
  agent_id TEXT PRIMARY KEY,
  operator_group_id TEXT NOT NULL,
  group_confidence TEXT NOT NULL DEFAULT 'unverified'
    CHECK (group_confidence IN ('unverified','declared','operator_reviewed')),
  capabilities_json TEXT NOT NULL,
  environments_json TEXT NOT NULL,
  evidence_refs_json TEXT,
  provenance TEXT NOT NULL DEFAULT 'self_reported'
    CHECK (provenance IN ('self_reported','operator_reviewed')),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','suspended','revoked')),
  reviewed_by TEXT,
  reviewed_at TEXT NOT NULL,
  expires_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─── Budget reservations (atomic cap accounting, USDC atomic strings) ─────
CREATE TABLE IF NOT EXISTS testing_budget_reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES testing_orders(id),
  operation_ref TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('external_run','retest_earmark','retest_run','replacement')),
  amount_atomic TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','committed','settled','release_pending','released')),
  attempt_id TEXT,
  payment_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testing_reservations_order ON testing_budget_reservations(order_id, state);

-- ─── Reports (immutable published versions) ───────────────────────────────
CREATE TABLE IF NOT EXISTS testing_reports (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES testing_orders(id),
  version INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  approved_by TEXT,
  approve_assertion_id TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, version)
);

-- ─── Customer feedback (never public) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS testing_feedback (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES testing_orders(id),
  owner_id TEXT NOT NULL,
  useful TEXT CHECK (useful IS NULL OR useful IN ('yes','partial','no')),
  action_taken TEXT,
  incremental TEXT CHECK (incremental IS NULL OR incremental IN ('baseline_only','external_only','both','none','unsure')),
  comment TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testing_feedback_order ON testing_feedback(order_id);

-- ─── Durable Stripe event inbox (received → processing(lease) → processed) ─
CREATE TABLE IF NOT EXISTS testing_stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'received'
    CHECK (state IN ('received','processing','processed','retryable_failed','manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_testing_inbox_due ON testing_stripe_events(state, next_attempt_at);

-- ─── Durable operations (publish/fund/refund/plan/email — idempotent keys) ─
CREATE TABLE IF NOT EXISTS testing_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  semantic_key TEXT NOT NULL UNIQUE,
  order_id TEXT,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','processing','succeeded','failed','manual_review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testing_ops_due ON testing_operations(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_testing_ops_order ON testing_operations(order_id, created_at);

-- ─── Private operator audit trail ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS testing_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  before_version INTEGER,
  after_version INTEGER,
  reason TEXT,
  detail_hash TEXT,
  assertion_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testing_audit_object ON testing_audit_log(object_kind, object_id, created_at);

-- ─── Notification dedupe (semantic key = never email the same event twice) ─
CREATE TABLE IF NOT EXISTS testing_notifications (
  semantic_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  order_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_testing_notifications_due ON testing_notifications(state, next_attempt_at);

-- ─── First-party product events (no workflow contents, no secrets) ────────
CREATE TABLE IF NOT EXISTS testing_metric_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  order_id TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testing_metric_events ON testing_metric_events(event, created_at);

-- ─── Neutral restricted-claim extension (open marketplace schema) ─────────
-- A task with rows here can only be claimed by a listed agent. Enforced
-- inside the atomic claim gate (tasks/service.ts) when the table exists;
-- ordinary tasks (no rows) are untouched.
CREATE TABLE IF NOT EXISTS task_claim_allowlist (
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_task_claim_allowlist_agent ON task_claim_allowlist(agent_id);
