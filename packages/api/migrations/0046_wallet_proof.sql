-- 0046: payout wallet proof of control (decision D8, 2026-09-29).
-- Setting or changing an agent's payout wallet needs a signature from that
-- wallet over a bind message (wallets/bind.ts). `wallet_verified_at` is set by
-- a proven bind and cleared with the wallet; addresses set before this stay as
-- they are, unverified. Every proven bind is kept in agent_wallet_bindings (the
-- message and signature anyone can re-check; unbound_at is set when replaced or
-- cleared). A nonce binds at most once per agent.
ALTER TABLE agents ADD COLUMN wallet_verified_at TEXT;
CREATE TABLE IF NOT EXISTS agent_wallet_bindings (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, wallet_address TEXT NOT NULL, wallet_network TEXT NOT NULL, signer_kind TEXT NOT NULL CHECK (signer_kind IN ('eoa', 'erc1271')), message TEXT NOT NULL, signature TEXT NOT NULL, nonce TEXT NOT NULL, bound_at TEXT NOT NULL, unbound_at TEXT, UNIQUE (agent_id, nonce));
CREATE INDEX IF NOT EXISTS idx_wallet_bindings_agent ON agent_wallet_bindings(agent_id, bound_at DESC);
