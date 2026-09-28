import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useOwner } from '../state/session.js';
import { agentDisplayName } from '../lib/agentActions.js';

/** Truncate an owner id for the sidebar (ow_ + base58 is long). */
function shortOwner(id: string): string {
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/**
 * The logged-in shell: one left sidebar for every page. The base case lives
 * at the top — Home, then every connected agent by name (click one to see
 * what it can use, cut it off, rotate its keys) and "Add an agent". The
 * power pages sit below under "Advanced", so the vocabulary split survives:
 * base-case words above the fold, the full console one section down.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
export default function Layout() {
  const { owner, logout } = useOwner();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const agents = (owner?.delegations ?? []).filter((d) => d.status === 'active');
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'side-link active' : 'side-link');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="side-brand">
          <span className="brand-mark">◈</span>
          <span className="brand-name">BasedAgents</span>
        </div>

        <NavLink to="/home" className={cls}>Home</NavLink>

        <div className="side-head">Agents</div>
        {agents.length === 0 ? (
          <div className="side-empty">None yet</div>
        ) : (
          agents.map((d) => (
            <NavLink
              key={d.id}
              to={`/agents/${encodeURIComponent(d.agent_id)}`}
              className={cls}
              title={d.agent_id}
            >
              <span className="side-dot" aria-hidden="true" />
              <span className="side-label">{agentDisplayName(d)}</span>
            </NavLink>
          ))
        )}
        <NavLink to="/agents/new" className={({ isActive }) => (isActive ? 'side-link side-add active' : 'side-link side-add')}>
          + Add an agent
        </NavLink>

        <div className="side-head">Advanced</div>
        <NavLink to="/explore" className={cls}>Browse tasks</NavLink>
        <NavLink to="/tasks" className={cls}>My tasks</NavLink>
        <NavLink to="/testing" className={cls}>Testing</NavLink>
        <NavLink to="/board" className={cls}>Board</NavLink>
        <NavLink to="/approvals" className={cls}>Approvals</NavLink>
        <NavLink to="/vault" className={cls}>Vault</NavLink>
        <NavLink to="/settings/billing" className={cls}>Billing</NavLink>
        {owner?.is_admin && <NavLink to="/admin/feedback" className={cls}>Feedback</NavLink>}
        {owner?.is_admin && <NavLink to="/testing/admin" className={cls}>Testing ops</NavLink>}

        <div className="side-bottom">
          <a className="side-star" href="https://github.com/maxfain/basedagents" target="_blank" rel="noopener noreferrer">
            If BasedAgents is useful, star it on GitHub
          </a>
          {owner && <span className="owner-id" title={owner.owner_id}>{shortOwner(owner.owner_id)}</span>}
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>Sign out</button>
        </div>
      </aside>
      <div className="main-col">
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
