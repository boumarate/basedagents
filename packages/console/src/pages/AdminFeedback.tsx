/**
 * /admin/feedback — operator triage for agent feedback (WS5).
 *
 * Reports come from POST /v1/feedback, which agents send when the docs, the
 * skill or the API got something wrong. Each one can be marked fixed or
 * won't-fix, with a note. The route answers 404 unless ADMIN_OWNER_IDS lists
 * this account, and the nav link only shows for admins.
 */
import { useCallback, useEffect, useState } from 'react';
import { control, ControlApiError } from '../api/control.js';
import type { FeedbackItem, FeedbackStatus } from '../api/types.js';
import { useOwner } from '../state/session.js';

const LABEL: Record<FeedbackStatus, string> = { open: 'Open', fixed: 'Fixed', wont_fix: "Won't fix" };
const TABS: Array<FeedbackStatus | 'all'> = ['open', 'fixed', 'wont_fix', 'all'];

const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fb-field">
      <div className="fb-label">{label}</div>
      <div className="fb-value">{children}</div>
    </div>
  );
}

function FeedbackCard({ item, onChange }: { item: FeedbackItem; onChange: (next: FeedbackItem) => void }) {
  const [note, setNote] = useState(item.status_note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mark(status: FeedbackStatus) {
    setBusy(true);
    setError(null);
    try {
      const res = await control.setFeedbackStatus(item.feedback_id, status, note.trim() || undefined);
      onChange(res.feedback);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card fb-card" data-feedback-id={item.feedback_id}>
      <div className="card-main">
        <div className="card-title">
          <span>{item.actual_behavior.split('\n')[0].slice(0, 120)}</span>
          <span className={`pill ${item.status === 'open' ? 'pill-warn' : 'pill-money'}`}>{LABEL[item.status]}</span>
          <span className="pill">{item.scope}</span>
        </div>
        <div className="card-meta">
          <span>{fmt(item.created_at)}</span>
          <span className="dot">·</span>
          <span>{item.agent_id ? <code title={item.agent_id}>{item.agent_id.slice(0, 14)}…</code> : 'anonymous'}</span>
          <span className="dot">·</span>
          <span>skill {item.skill_version ?? '—'} · CLI {item.cli_version ?? '—'}</span>
          {item.task_id && (<><span className="dot">·</span><code>{item.task_id}</code></>)}
        </div>
        <Field label="Expected">{item.expected_behavior}</Field>
        <Field label="Actual">{item.actual_behavior}</Field>
        <Field label="Steps">{item.steps_to_reproduce}</Field>
        {item.suggested_improvement && <Field label="Suggested">{item.suggested_improvement}</Field>}
        {(item.error_codes.length > 0 || item.request_ids.length > 0) && (
          <Field label="Codes / requests">
            {[...item.error_codes, ...item.request_ids].map((c) => <code key={c} className="fb-chip">{c}</code>)}
          </Field>
        )}
        <Field label="Environment">{item.environment}</Field>
        <div className="fb-actions">
          <input className="fb-note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          <div className="btn-row">
            {(['fixed', 'wont_fix', 'open'] as FeedbackStatus[]).filter((s) => s !== item.status).map((s) => (
              <button key={s} className={s === 'fixed' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'} disabled={busy} onClick={() => void mark(s)}>
                {s === 'open' ? 'Reopen' : `Mark ${LABEL[s].toLowerCase()}`}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="banner banner-error">{error}</div>}
      </div>
    </li>
  );
}

export default function AdminFeedback() {
  const { owner } = useOwner();
  const [tab, setTab] = useState<FeedbackStatus | 'all'>('open');
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [counts, setCounts] = useState<Record<FeedbackStatus, number> | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: string) => {
    setError(null);
    try {
      const res = await control.adminFeedback(tab, before);
      setItems((prev) => (before && prev ? [...prev, ...res.feedback] : res.feedback));
      setCounts(res.counts);
      setNextBefore(res.next_before);
    } catch (err) {
      setError(err instanceof ControlApiError && err.status === 404 ? 'This page is for operators.' : err instanceof Error ? err.message : 'Failed to load');
      setItems([]);
    }
  }, [tab]);

  useEffect(() => { setItems(null); void load(); }, [load]);

  if (!owner) return null;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Agent feedback</h1>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => void load()}>Refresh</button>
        </div>
      </div>
      <p className="page-lede">Reports agents sent from <code>POST /v1/feedback</code> when the docs, the skill or the API didn’t match.</p>
      <div className="btn-row fb-tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'} onClick={() => setTab(t)}>
            {t === 'all' ? 'All' : LABEL[t]}{counts && t !== 'all' ? ` (${counts[t]})` : ''}
          </button>
        ))}
      </div>
      {error && <div className="banner banner-error">{error}</div>}
      {items === null ? (
        <div className="empty"><p className="muted">Loading…</p></div>
      ) : items.length === 0 ? (
        error ? null : <div className="empty"><p className="muted">Nothing here.</p></div>
      ) : (
        <ul className="cards">
          {items.map((item) => (
            <FeedbackCard
              key={item.feedback_id}
              item={item}
              onChange={(next) => {
                setItems((prev) => (prev ?? []).map((x) => (x.feedback_id === next.feedback_id ? next : x)).filter((x) => tab === 'all' || x.status === tab));
                void control.adminFeedback(tab).then((r) => setCounts(r.counts)).catch(() => {});
              }}
            />
          ))}
        </ul>
      )}
      {nextBefore && <button className="btn btn-ghost" onClick={() => void load(nextBefore)}>Load more</button>}
    </div>
  );
}
