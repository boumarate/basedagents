-- WS5 (agent-first plan): agent feedback, API version telemetry, idempotency
-- keys for new write endpoints, and once-a-day job markers.

-- POST /v1/feedback. agent_id is the signer (NULL when anonymous). Free-text
-- fields are stored after secret redaction. status is triaged in the console.
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id TEXT PRIMARY KEY,
  agent_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('task', 'general')),
  task_id TEXT,
  environment TEXT NOT NULL,
  expected_behavior TEXT NOT NULL,
  actual_behavior TEXT NOT NULL,
  steps_to_reproduce TEXT NOT NULL,
  error_codes TEXT,
  request_ids TEXT,
  suggested_improvement TEXT,
  skill_version TEXT,
  cli_version TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'wont_fix')),
  status_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Per-channel delivery, so a channel that failed is retried on its own;
  -- notified_at is set once every configured channel has it.
  email_notified_at TEXT,
  slack_notified_at TEXT,
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_notify ON feedback(notified_at, created_at);

-- Per-day request counts for agent traffic: requests that carry a CLI or skill
-- version header, signed requests, and every 4xx/5xx. One upsert per request.
CREATE TABLE IF NOT EXISTS api_usage_daily (
  day TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  cli_version TEXT NOT NULL DEFAULT '',
  skill_version TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, agent_id, cli_version, skill_version, status, error_code)
);

-- Idempotency-Key replay store (24 h). scope = the signer or an anonymous bucket.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

-- Once-per-period jobs run from the 5-minute cron (e.g. the daily digest).
-- status: running → done, or failed (retried a few times, then left).
CREATE TABLE IF NOT EXISTS job_runs (
  job TEXT NOT NULL,
  run_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  ran_at TEXT NOT NULL,
  PRIMARY KEY (job, run_key)
);
