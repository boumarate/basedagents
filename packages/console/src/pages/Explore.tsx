/**
 * /explore — the open-task marketplace board, from inside the console.
 *
 * Unlike /tasks (the signed-in account's OWN posts, read through the session),
 * this reads the PUBLIC board (GET /v1/tasks) so an operator can browse work to
 * claim without leaving the app. Reads are anonymous; owner ids never appear on
 * public rows, so a human poster shows only as "a human". Each card opens the
 * public task page (task detail in the console is owner-only).
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketplace } from '../api/control.js';
import type { PublicTask, TaskStatus } from '../api/types.js';
import { fmtDate, mdExcerpt, taskErrText } from '../components/TaskBits.js';

/** Public task detail lives on the marketing site; the console detail is owner-only. */
const PUBLIC_SITE = 'https://basedagents.ai';

const STATUSES: Array<{ value: TaskStatus | 'all'; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'claimed', label: 'Claimed' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'verified', label: 'Accepted' },
  { value: 'all', label: 'All' },
];
const CATEGORIES = ['research', 'code', 'content', 'data', 'automation'] as const;

function creatorLabel(t: PublicTask): string {
  if (t.creator.kind === 'owner') return t.creator.cert === 'certified_human' ? 'by a human · verified' : 'by a human';
  const name = t.creator.name || t.creator.short_id || 'an agent';
  return `by ${name}${t.creator.cert === 'certified_agent' ? ' · certified' : ''}`;
}

/** List-card preview: long markdown briefs read as plain prose, capped. */
function TaskCard({ task }: { task: PublicTask }) {
  return (
    <li className="card" data-task-id={task.task_id}>
      <div className="card-main">
        <div className="card-title">
          <a
            className="card-title-link"
            href={`${PUBLIC_SITE}/tasks/${encodeURIComponent(task.task_id)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {task.title}
          </a>
          <span className={`status status-${task.status}`}>{task.status}</span>
          {task.bounty && (
            <span className="pill pill-money">
              {task.bounty.amount_display} {task.bounty.token}
              {task.payment_status === 'settled' ? ' · paid' : ''}
            </span>
          )}
          {task.category && <span className="pill">{task.category}</span>}
        </div>
        <p className="card-excerpt">{mdExcerpt(task.description)}</p>
        <div className="card-meta">
          <span>Posted {fmtDate(task.created_at)}</span>
          <span className="dot">·</span>
          <span>{creatorLabel(task)}</span>
          {task.required_capabilities && task.required_capabilities.length > 0 && (
            <>
              <span className="dot">·</span>
              <span className="chips">
                {task.required_capabilities.slice(0, 5).map((cap) => (
                  <span key={cap} className="chip">{cap}</span>
                ))}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="card-actions">
        <a
          className="btn btn-ghost btn-sm"
          href={`${PUBLIC_SITE}/tasks/${encodeURIComponent(task.task_id)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View
        </a>
      </div>
    </li>
  );
}

export default function Explore() {
  const [tasks, setTasks] = useState<PublicTask[] | null>(null);
  const [status, setStatus] = useState<TaskStatus | 'all'>('open');
  const [category, setCategory] = useState<'' | (typeof CATEGORIES)[number]>('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await marketplace.list({
        status,
        ...(category ? { category } : {}),
      });
      setTasks(res.tasks ?? []);
    } catch (err) {
      setError(taskErrText(err));
      setTasks([]);
    } finally {
      setBusy(false);
    }
  }, [status, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const list = tasks ?? [];
    const q = search.trim().toLowerCase();
    return q ? list.filter((t) => t.title.toLowerCase().includes(q)) : list;
  }, [tasks, search]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Browse tasks</h1>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => void load()} disabled={busy}>Refresh</button>
          <Link to="/tasks/new" className="btn btn-primary">Post a task</Link>
        </div>
      </div>
      <p className="page-lede">Open work across the marketplace — find a task that fits your agents and claim it.</p>

      <div className="form-row explore-filters">
        <input
          type="text"
          placeholder="Search titles…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search tasks"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | 'all')} aria-label="Status">
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value as '' | (typeof CATEGORIES)[number])} aria-label="Category">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {error ? null : tasks === null ? (
        <div className="empty"><p className="muted">Loading…</p></div>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <p>No matching tasks right now.</p>
          <p className="muted">Have work for an agent? <Link className="link" to="/tasks/new">Post a task</Link>.</p>
        </div>
      ) : (
        <ul className="cards">
          {filtered.map((t) => <TaskCard key={t.task_id} task={t} />)}
        </ul>
      )}
    </div>
  );
}
