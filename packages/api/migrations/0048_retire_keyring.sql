-- 0048: retire Keyring — drop the credential-vault tables and columns.
--
-- Keyring (the local credential vault, its approvals inbox, connect cards,
-- daemon endpoints, cloud passport and billing) is removed from the product;
-- the task marketplace is what remains. The owner-account layer it shared
-- with the marketplace stays untouched: owners, owner_webauthn_credentials,
-- webauthn_challenges, owner_sessions, action_assertions, delegations,
-- owner_recovery_*, magic_link_tokens, test_outbox, and the 0034 oauth_* tables.
-- funnel_events (0028) also stays: the marketplace records task_posted and
-- friends server-side (tasks/service.ts recordFunnel); only the anonymous
-- keyring onboarding pings and the provider vote tiles are gone.
--
-- Everything below is a plain drop. The tables are children of owners/agents
-- (or standalone counters), so no surviving row references them; link_codes
-- was only ever pointed at by magic_link_tokens.link_code_id, a plain nullable
-- column with no REFERENCES clause — it stays, unused, rather than rebuilding
-- the table. DROP COLUMN needs SQLite ≥ 3.35 (D1 and better-sqlite3 both are).
DROP TABLE IF EXISTS grant_approvals;
DROP TABLE IF EXISTS keyring_requests;
DROP TABLE IF EXISTS sealed_credentials;
DROP TABLE IF EXISTS passport_handoffs;
DROP TABLE IF EXISTS credential_facts;
DROP TABLE IF EXISTS pending_connections;
DROP TABLE IF EXISTS owner_invites;
DROP TABLE IF EXISTS link_codes;
DROP TABLE IF EXISTS owner_vault_keys;
DROP TABLE IF EXISTS provider_votes;
DROP TABLE IF EXISTS stripe_events;

-- Billing (0026) lived on the owners row; the kill-switch report (0032) on
-- delegations. The SUBSCRIPTION (Keyring Pro) columns go; stripe_customer_id
-- STAYS — Agent Testing's one-time checkout (0042) reuses the owner's Stripe
-- customer, and its index with it (reconciliation may look owners up by it).
ALTER TABLE owners DROP COLUMN plan;
ALTER TABLE owners DROP COLUMN plan_status;
ALTER TABLE owners DROP COLUMN stripe_subscription_id;
ALTER TABLE owners DROP COLUMN current_period_end;
ALTER TABLE delegations DROP COLUMN daemon_confirmed_at;
ALTER TABLE delegations DROP COLUMN daemon_kill_report;
