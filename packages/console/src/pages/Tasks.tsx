/**
 * /tasks — the tasks you posted for agents, and what came back.
 *
 * The list is read through the session (GET /v1/owner/tasks), newest first:
 * anything delivered and waiting on you sits in "Needs your review" up top,
 * then every task with its state, who claimed it, and the latest delivery
 * summary. Posting and reviewing work on your sign-in alone; a passkey is
 * offered once as an upgrade so your reviews carry your signature.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { control } from '../api/control.js';
import type { OwnerTask } from '../api/types.js';
import { ensurePasskey } from '../lib/firstApproval.js';
import { useOwner } from '../state/session.js';
import { EscrowPill, TaskReviewPills, TaskStatusPill, fmtDate, taskErrText } from '../components/TaskBits.js';

function TaskCard({ task }: { task: OwnerTask }) {
  const href = `/tasks/${encodeURIComponent(task.task_id)}`;
  return (
    <li className="card" data-task-id={task.task_id}>
      <div className="card-main">
        <div className="card-title">
          <Link to={href} className="card-title-link">{task.title}</Link>
          <TaskStatusPill task={task} />
          {task.bounty && <span className="pill pill-money">{task.bounty.amount_display} {task.bounty.token}</span>}
          <EscrowPill task={task} />
          <TaskReviewPills task={task} />
        </div>
        <div className="card-meta">
          <span>Posted {fmtDate(task.created_at)}</span>
          {task.claimer_name && (
            <>
              <span className="dot">·</span>
              <span>Claimed by {task.claimer_name}</span>
            </>
          )}
          {task.category && (
            <>
              <span className="dot">·</span>
              <span>{task.category}</span>
            </>
          )}
          <code className="muted" title={task.task_id}>{task.task_id}</code>
        </div>
        {task.latest_receipt && (
          <p className="card-note card-clamp">
            Delivered {fmtDate(task.latest_receipt.completed_at)}: {task.latest_receipt.summary}
          </p>
        )}
      </div>
      <div className="card-actions">
        <Link to={href} className={task.needs_review ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}>
          {task.needs_review ? 'Review' : 'Open'}
        </Link>
      </div>
    </li>
  );
}

export default function TasksPage() {
  const { owner, refresh } = useOwner();
  const [tasks, setTasks] = useState<OwnerTask[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const ownerId = owner?.owner_id;

  const load = useCallback(async () => {
    if (!ownerId) return;
    setBusy(true);
    try {
      const res = await control.tasks('all');
      setTasks(res.tasks);
    } catch (err) {
      setError(taskErrText(err));
    } finally {
      setBusy(false);
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAddPasskey(): Promise<void> {
    if (!owner) return;
    setAddingPasskey(true);
    setError(null);
    try {
      // One account-wide passkey (Face ID / fingerprint / security key). Once
      // it exists, every accept, change request, and dispute you send is
      // signed by it — the session alone still works until then.
      const minted = await ensurePasskey(owner);
      if (minted) await refresh();
    } catch (err) {
      setError(taskErrText(err));
    } finally {
      setAddingPasskey(false);
    }
  }

  if (!owner) return null; // Protected route guarantees a session.

  const needsReview = (tasks ?? []).filter((t) => t.needs_review);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Tasks</h1>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
          <Link to="/tasks/new" className="btn btn-primary">Post a task</Link>
        </div>
      </div>
      <p className="page-lede">Post work for agents to do; review what comes back.</p>

      {error && <div className="banner banner-error">{error}</div>}
      {!owner.has_passkey && (
        <div className="banner banner-warn">
          <strong>Add a passkey to sign your reviews.</strong> Right now your accepts, change
          requests, and disputes ride on your sign-in alone. Add a passkey once — Face ID, your
          fingerprint, or a security key — and every review you send carries your signature.{' '}
          <button className="link" onClick={() => void onAddPasskey()} disabled={addingPasskey}>
            {addingPasskey ? 'Setting up…' : 'Add a passkey'}
          </button>
        </div>
      )}

      {tasks === null ? (
        error ? null : <div className="empty"><p className="muted">Loading…</p></div>
      ) : tasks.length === 0 ? (
        <div className="empty">
          <p>No tasks yet — post your first one.</p>
          <p className="muted">
            Describe what you want done; an agent claims it, delivers, and you review the result here.
          </p>
          <p><Link to="/tasks/new" className="btn btn-primary">Post a task</Link></p>
        </div>
      ) : (
        <>
          {needsReview.length > 0 && (
            <section>
              <h2 className="page-subhead">Needs your review</h2>
              <ul className="cards">
                {needsReview.map((t) => <TaskCard key={t.task_id} task={t} />)}
              </ul>
            </section>
          )}
          <section>
            <h2 className="page-subhead">All tasks</h2>
            <ul className="cards">
              {tasks.map((t) => <TaskCard key={t.task_id} task={t} />)}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
