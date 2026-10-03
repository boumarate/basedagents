-- Acquisition attribution (MCP growth loop): where an installation, an agent
-- and a buyer came from, joined to committed marketplace state. Everything in
-- here is PRIVATE analytics — nothing feeds the chain, receipts, reputation,
-- payments or public profiles, and every write is best-effort (a failed
-- analytics insert never fails a business request).

-- One row per client-minted installation UUID. The INSERT that creates the row
-- IS the immutable first observation (even when the source is unknown); later
-- evidence only fills the first_known_* columns (at their REAL observation
-- time, never backdated) and the latest_* columns. An untagged request never
-- erases a known source.
CREATE TABLE IF NOT EXISTS mcp_installations (
  installation_id TEXT PRIMARY KEY,
  first_observed_at TEXT NOT NULL,
  source_at_first_observation TEXT NOT NULL DEFAULT 'unknown',
  campaign_at_first_observation TEXT NOT NULL DEFAULT '',
  method_at_first_observation TEXT NOT NULL DEFAULT 'unknown',
  -- Earliest KNOWN source, set once at its actual observation time.
  first_known_source TEXT,
  first_known_campaign TEXT,
  first_known_source_at TEXT,
  first_known_method TEXT,
  -- Most recent explicit tag (a changed tag is a new touch, not a rewrite).
  latest_source TEXT NOT NULL DEFAULT '',
  latest_campaign TEXT NOT NULL DEFAULT '',
  latest_source_at TEXT NOT NULL DEFAULT '',
  acquisition_id TEXT NOT NULL DEFAULT '',
  interface TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  client_version TEXT NOT NULL DEFAULT '',
  mcp_version TEXT NOT NULL DEFAULT '',
  last_seen_day TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mcp_inst_first ON mcp_installations(first_observed_at);

-- Immutable acquisition-touch history. The unique index bounds writes: a
-- stable config re-sending the same tag tuple is a no-op, a CHANGED tag adds
-- one new row. Touches are never updated or overwritten.
CREATE TABLE IF NOT EXISTS acquisition_touches (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  source TEXT NOT NULL,
  campaign TEXT NOT NULL DEFAULT '',
  acquisition_id TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL,
  interface TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_touch_dedupe ON acquisition_touches(installation_id, source, campaign, acquisition_id, method);

-- Installation ⇄ agent joins, written ONLY when the agent id came from
-- verified AgentSig auth (or the registration challenge signature) — an
-- unsigned header can never create a link. M:N by design: several agents may
-- share one local installation and one agent may run on several machines.
CREATE TABLE IF NOT EXISTS installation_agent_links (
  installation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  first_linked_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_links_agent ON installation_agent_links(agent_id);

-- One attribution record per agent, written at its ACTUAL registration.
-- Agents that predate this system get no row and read as unknown — history is
-- never reconstructed.
CREATE TABLE IF NOT EXISTS agent_acquisition (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  registered_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  campaign TEXT NOT NULL DEFAULT '',
  acquisition_id TEXT NOT NULL DEFAULT '',
  installation_id TEXT NOT NULL DEFAULT '',
  interface TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS idx_agent_acq_source ON agent_acquisition(source, registered_at);

-- Opaque setup-flow ids minted by POST /v1/acquisition (the website bridge).
-- The source mapping stays server-side; retention is a DELETE past expiry.
-- An id proves it was issued by the setup flow — not that the visitor truly
-- discovered BasedAgents through the claimed channel.
CREATE TABLE IF NOT EXISTS acquisition_ids (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  campaign TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acq_ids_expires ON acquisition_ids(expires_at);

-- Client-reported MCP tool outcomes (POST /v1/telemetry/mcp). REPORTED
-- activity only: rows here never create registrations, funding, acceptance or
-- settlement. PK = tool_call_id makes ingestion idempotent (one final outcome
-- per tool invocation, stable across internal retries). error_code is a
-- bounded category, never raw error text.
CREATE TABLE IF NOT EXISTS mcp_tool_outcomes (
  tool_call_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'tool_error', 'api_error', 'auth_required', 'payment_required', 'network_error')),
  error_code TEXT NOT NULL DEFAULT '',
  client_time TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  interface TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_outcomes_received ON mcp_tool_outcomes(received_at);

-- Daily activity rollup (the api_usage_daily pattern — one row per unit per
-- day, upserted). kind is classified SERVER-SIDE from method+path, never from
-- a client-supplied header: reads/polling are 'discovery', committed writes
-- are 'meaningful'. Powers the 7-day-returning metric and keeps tools/list
-- noise out of activity counts.
CREATE TABLE IF NOT EXISTS installation_usage_daily (
  day TEXT NOT NULL,
  installation_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  interface TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('discovery', 'meaningful')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, installation_id, agent_id, interface, kind)
);
