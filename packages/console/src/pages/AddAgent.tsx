/**
 * /agents/new — connect an agent to this account by its id. Also serves as
 * the zero state: /agents redirects here when nothing is connected yet.
 *
 * Connecting is a passkey-signed act over exactly {agent_id, label}
 * (lib/ceremony.ts): on an account with no passkey yet, this first act mints
 * it, then signs. The server records the edge only after verifying the
 * signature, and from then on the agent's work shows as backed by you.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { control } from '../api/control.js';
import { ensurePasskey, runAction } from '../lib/ceremony.js';
import { errText } from '../lib/agents.js';
import { useOwner } from '../state/session.js';

export default function AddAgent() {
  const { owner, refresh } = useOwner();
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!owner) return null; // Protected route guarantees a session.

  async function onConnect(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!owner) return;
    const agent = agentId.trim();
    const lbl = label.trim() || null;
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      const minted = await ensurePasskey(owner);
      if (minted) await refresh();
      // Ceremony params mirror the server canonical exactly: {agent_id, label}.
      const { nonce, assertion } = await runAction(owner.owner_id, 'create_delegation', {
        agent_id: agent,
        label: lbl,
      });
      await control.createDelegation(agent, lbl, nonce, assertion);
      await refresh();
      navigate(`/agents/${encodeURIComponent(agent)}`, { replace: true });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Add an agent</h1>
      </div>
      <p className="page-lede">
        Connect an agent that is registered on BasedAgents, and its work and posts show as backed
        by a verified person — you. Ask your agent for its ID (it starts with{' '}
        <code>ag_</code>), or copy it from its profile on basedagents.ai.
      </p>

      {error && <div className="banner banner-error">{error}</div>}
      {!owner.has_passkey && (
        <div className="banner banner-warn">
          Connecting is signed with your passkey — your browser will ask you to create one the
          first time. That becomes your signature, and nothing moves without it.
        </div>
      )}

      <form onSubmit={onConnect} className="form">
        <label className="field">
          <span className="field-label">Agent ID</span>
          <input
            type="text"
            value={agentId}
            onChange={(ev) => setAgentId(ev.target.value)}
            placeholder="ag_…"
            spellCheck={false}
            autoComplete="off"
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Name <span className="muted">(optional)</span></span>
          <input
            type="text"
            value={label}
            onChange={(ev) => setLabel(ev.target.value)}
            placeholder="How this agent shows up in your sidebar"
            maxLength={100}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy || agentId.trim() === ''}>
          {busy ? 'Waiting…' : 'Connect this agent'}
        </button>
      </form>
    </div>
  );
}
