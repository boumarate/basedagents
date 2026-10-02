-- 0043: Agent Testing — public (pre-authentication) intake inbox.
--
-- Every audit request is operator-reviewed before any quote or payment, so
-- the intake form no longer requires an account: a visitor submits the form
-- with an email address, the payload lands HERE (owned by nobody), and a
-- sign-in magic link goes to that address. The moment the email is verified
-- (the visitor signs in — new buyer account or existing owner), pending rows
-- for that address are ADOPTED: a real `testing_requests` row is created in
-- 'submitted' state under the pre-minted request_id below, and the inbox row
-- flips to 'claimed'. The pre-minted id makes adoption idempotent
-- (INSERT OR IGNORE) under races and retries.
--
-- Unclaimed rows are invisible to every surface except the operator queue's
-- count, and expire after a TTL (jobs sweep) — an unverified email never
-- creates an account, keeps a request, or triggers operator review.

CREATE TABLE IF NOT EXISTS testing_intake_inbox (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,                -- normalized (trimmed, lower-cased)
  request_id TEXT NOT NULL UNIQUE,    -- pre-minted testing_requests id, used at adoption
  intake_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','expired')),
  claimed_owner_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_testing_inbox_email ON testing_intake_inbox(email, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_testing_inbox_status ON testing_intake_inbox(status, expires_at);
