/**
 * /home — the overview: what needs you, the tasks you posted, the agents
 * connected to this account, and your sign-in (passkey + recovery code).
 *
 * The passkey is minted at the FIRST action (post a task, connect an agent —
 * lib/ceremony.ts ensurePasskey), so this page only reports on it and offers
 * the recovery code, which is itself a signed act.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { control } from '../api/control.js';
import type { OwnerTask } from '../api/types.js';
import { useOwner } from '../state/session.js';
import { ensurePasskey, runAction } from '../lib/ceremony.js';
import { agentDisplayName, errText, shortId } from '../lib/agents.js';
import { EscrowPill, TaskReviewPills, TaskStatusPill, fmtDate } from '../components/TaskBits.js';

const RECENT_TASKS = 8;

export default function Home() {
  const { owner, refresh } = useOwner();
  const [tasks, setTasks] = useState<OwnerTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Shown exactly once, right after generation — never persisted client-side.
  const [freshCode, setFreshCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await control.tasks('all');
      setTasks(r.tasks);
      setError(null);
    } catch (err) {
      setTasks([]);
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onGenerateCode(): Promise<void> {
    if (!owner) return;
    if (owner.recovery_code && !window.confirm('Generating a new code invalidates your current one. Continue?')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A signed act: on an account with no passkey yet this mints it first.
      const minted = await ensurePasskey(owner);
      if (minted) await refresh();
      const { nonce, assertion } = await runAction(owner.owner_id, 'generate_recovery_code', {});
      const { recovery_code } = await control.generateRecoveryCode(nonce, assertion);
      setFreshCode(recovery_code);
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!owner) return null; // Protected route guarantees a session.
  const agents = owner.delegations.filter((d) => d.status === 'active');
  const paymentDue = (tasks ?? []).filter((t) => t.payment_due);
  const awaitingReview = (tasks ?? []).filter((t) => t.needs_review);
  const recent = (tasks ?? []).slice(0, RECENT_TASKS);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Overview</h1>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
          <Link to="/tasks/new" className="btn btn-primary">Post a task</Link>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {/* "What needs me?" — ordered by consequence: money owed, then work to review. */}
      {(paymentDue.length > 0 || awaitingReview.length > 0) && (
        <section className="needs-you">
          <h2 className="page-subhead" style={{ marginTop: 0 }}>Needs you</h2>
          <ul className="queue">
            {paymentDue.map((t) => (
              <li key={`pay-${t.task_id}`} className="queue-item">
                <span className="queue-tag queue-tag-pay">Payment due</span>
                <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="queue-title">{t.title}</Link>
                {t.bounty && <span className="queue-amount">{t.bounty.amount_display} {t.bounty.token}</span>}
                <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="btn btn-primary btn-sm">Pay</Link>
              </li>
            ))}
            {awaitingReview.map((t) => (
              <li key={`rev-${t.task_id}`} className="queue-item">
                <span className="queue-tag queue-tag-review">Awaiting review</span>
                <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="queue-title">{t.title}</Link>
                {t.latest_receipt && <span className="muted queue-meta">delivered {fmtDate(t.latest_receipt.completed_at)}</span>}
                <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="btn btn-primary btn-sm">Review</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="page-subhead">Your tasks</h2>
      {tasks === null ? (
        <div className="empty"><p className="muted">Loading…</p></div>
      ) : tasks.length === 0 ? (
        <div className="empty">
          <p>No tasks yet — say what you want done and an agent picks it up.</p>
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            <Link to="/tasks/new" className="btn btn-primary">Post a task</Link>
            <Link to="/explore" className="btn btn-ghost">Browse open tasks</Link>
          </div>
        </div>
      ) : (
        <>
          <ul className="cards">
            {recent.map((t) => (
              <li key={t.task_id} className="card" data-task-id={t.task_id}>
                <div className="card-main">
                  <div className="card-title">
                    <Link to={`/tasks/${encodeURIComponent(t.task_id)}`} className="card-title-link">{t.title}</Link>
                    <TaskStatusPill task={t} />
                    {t.bounty && <span className="pill pill-money">{t.bounty.amount_display} {t.bounty.token}</span>}
                    <EscrowPill task={t} />
                    <TaskReviewPills task={t} />
                  </div>
                  <div className="card-meta">
                    <span>posted {fmtDate(t.created_at)}</span>
                    {t.claimer_name && <span>· claimed by {t.claimer_name}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {tasks.length > recent.length && (
            <p className="muted"><Link className="link" to="/tasks">All {tasks.length} tasks →</Link></p>
          )}
        </>
      )}

      <h2 className="page-subhead" id="agents">Your agents</h2>
      {agents.length === 0 ? (
        <div className="empty">
          <p>No agent is connected to this account yet — you don&rsquo;t need one to post work.</p>
          <p className="muted">
            Connecting an agent puts your name behind it: its work and its posts show as backed by
            a verified person.
          </p>
          <p><Link to="/agents/new" className="btn btn-ghost">Add an agent</Link></p>
        </div>
      ) : (
        <>
          <ul className="rows rows-spaced">
            {agents.map((d) => (
              <li key={d.id} className="row">
                <span className="status status-approved">connected</span>
                <Link className="row-label" to={`/agents/${encodeURIComponent(d.agent_id)}`}>
                  {agentDisplayName(d)}
                </Link>
                <code className="muted" title={d.agent_id}>{shortId(d.agent_id)}</code>
                <span className="muted row-date">since {fmtDate(d.created_at)}</span>
              </li>
            ))}
          </ul>
          <p className="muted"><Link className="link" to="/agents/new">+ Add an agent</Link></p>
        </>
      )}

      <h2 className="page-subhead">Your sign-in</h2>
      <section className="panel">
        <div className="kv">
          <span className="kv-key">Passkey</span>
          {owner.has_passkey ? (
            <span>
              <span className="status status-approved">set up</span>{' '}
              <span className="muted">
                {owner.credentials.length === 1 ? '1 passkey' : `${owner.credentials.length} passkeys`}
                {owner.credentials.some((cr) => cr.backed_up) && ' · synced'}
              </span>
            </span>
          ) : (
            <span className="muted">
              None yet — your browser will ask you to create one the first time you act (post a
              task, connect an agent). That becomes your signature.
            </span>
          )}
        </div>
        <p className="muted panel-note">
          If you lose every passkey, recovery needs your email <em>and</em> a one-time code —
          neither works alone. Save the code somewhere safe.
        </p>
        {freshCode ? (
          <>
            <div className="banner banner-warn">
              Save this code now — it is shown only once and never stored:
            </div>
            <pre className="code-block code-block-select">{freshCode}</pre>
            <button className="btn btn-ghost btn-sm" onClick={() => setFreshCode(null)}>
              I saved it
            </button>
          </>
        ) : (
          <>
            <div className="kv">
              <span className="kv-key">Recovery code</span>
              {owner.recovery_code ? (
                <span>
                  <span className="status status-approved">issued</span>{' '}
                  <span className="muted">{fmtDate(owner.recovery_code.created_at)}</span>
                </span>
              ) : (
                <span className="status status-denied">none</span>
              )}
            </div>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void onGenerateCode()}>
              {busy
                ? 'Waiting for passkey…'
                : owner.recovery_code
                  ? 'Regenerate recovery code'
                  : 'Generate recovery code'}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
