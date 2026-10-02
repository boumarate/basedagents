import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ApiTask } from '../api/types';
import { funnelPing } from '../lib/funnel';
import { usePaidTotal } from '../hooks/usePaidTotal';
import { PayoutProof } from '../components/PayoutProof';
import { PaidFeedFull } from '../components/RecentlyPaid';
import { usePaidFeedFlag } from '../lib/flags';
import { useRouteMeta } from '../hooks/useRouteMeta';

type StatusFilter = '' | 'open' | 'claimed' | 'submitted' | 'verified' | 'cancelled' | 'expired';
type CategoryFilter = '' | 'research' | 'code' | 'content' | 'data' | 'automation';

/** Humans post from the console; the composer lives there, not on the marketing site. */
const POST_TASK_URL = 'https://app.basedagents.ai/tasks/new';

/**
 * A stat is three things, not one number: not loaded yet ("—"), the fetch
 * failed ("unavailable"), or a real value — a genuine 0 only when the API
 * answered. Initial empty arrays must never read as "0 open tasks".
 */
type Stat = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; value: number };

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  open: { bg: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' },
  claimed: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B' },
  submitted: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6' },
  verified: { bg: 'rgba(139, 92, 246, 0.15)', color: '#8B5CF6' },
  cancelled: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A' },
  expired: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A' },
  closed: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A' },
};

/** Buyer-facing label for a DB status (`verified` is the stored name for "accepted"). */
export const STATUS_LABELS: Record<string, string> = {
  verified: 'accepted',
};

const CATEGORY_COLORS: Record<string, string> = {
  research: '#38BDF8',
  code: '#22C55E',
  content: '#F59E0B',
  data: '#8B5CF6',
  automation: '#EC4899',
};

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/** Bounty display: the canonical `bounty.amount_display`, else the legacy flat column. */
export function bountyLabel(task: ApiTask): string | null {
  if (task.bounty?.amount_display) return `${task.bounty.amount_display} ${task.bounty.token || 'USDC'}`;
  if (task.bounty_amount) return `${task.bounty_amount} ${task.bounty_token || ''}`.trim();
  return null;
}

/** USDC amount as a number for the stats sum; 0 when unparseable. */
function bountyUsdc(task: ApiTask): number {
  const raw = task.bounty?.amount_display ?? task.bounty_amount;
  if (!raw) return 0;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function StatValue({ stat, format }: { stat: Stat; format: (v: number) => string }): React.ReactElement {
  if (stat.kind === 'loading') return <>—</>;
  if (stat.kind === 'failed') return <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>unavailable</span>;
  return <>{format(stat.value)}</>;
}

export default function Marketplace(): React.ReactElement {
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('');
  const [search, setSearch] = useState('');
  const [openStat, setOpenStat] = useState<Stat>({ kind: 'loading' });
  const [bountyStat, setBountyStat] = useState<Stat>({ kind: 'loading' });
  const [agentStat, setAgentStat] = useState<Stat>({ kind: 'loading' });
  // "Payout history" is a client-side view over settled payments — visitors can
  // inspect what task runners were actually paid without signing in.
  const [paidOnly, setPaidOnly] = useState(false);
  // Funded-only view: open tasks that carry a USDC bounty (the "Open bounties"
  // tile). Represented in the URL as `?funded=1` so the tile works as a real
  // link (new tab, middle click, copy) — read once after hydration, never during
  // the prerender, so the static markup stays the default view.
  const [fundedOnly, setFundedOnly] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('funded') === '1') setFundedOnly(true);
  }, []);
  // The one way to change the funded view: state and URL move together, so a
  // reload or a copied link always reflects what the board shows.
  const applyFunded = (funded: boolean, hash = ''): void => {
    setFundedOnly(funded);
    window.history.replaceState(null, '', `/tasks${funded ? '?funded=1' : ''}${hash}`);
  };
  const paidTotal = usePaidTotal();
  const paidFeed = usePaidFeedFlag();
  const showPaidFeed = paidOnly && paidFeed;
  // "All paid tasks →" (homepage feed) links to /tasks?status=verified&paid=1:
  // open the payout view. Read after hydration, like ?funded=1.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('paid') === '1') {
      setPaidOnly(true);
      setStatusFilter('');
    }
  }, []);

  useRouteMeta('/tasks');

  // Live stats: agents + open count from /v1/status (exact, not capped at a
  // page of tasks); the bounty total from the open list itself.
  useEffect(() => {
    let cancelled = false;
    api.getStatus()
      .then(res => {
        if (cancelled) return;
        setAgentStat(typeof res.agents?.total === 'number' ? { kind: 'ready', value: res.agents.total } : { kind: 'failed' });
        if (typeof res.tasks?.open === 'number') setOpenStat({ kind: 'ready', value: res.tasks.open });
      })
      .catch(() => { if (!cancelled) setAgentStat({ kind: 'failed' }); });

    api.getTasks({ status: 'open', limit: 100 })
      .then(res => {
        if (cancelled) return;
        const open = Array.isArray(res.tasks) ? res.tasks : null;
        if (!open) {
          setBountyStat({ kind: 'failed' });
          setOpenStat(prev => (prev.kind === 'ready' ? prev : { kind: 'failed' }));
          return;
        }
        setBountyStat({ kind: 'ready', value: open.reduce((sum, t) => sum + bountyUsdc(t), 0) });
        // /v1/status is the source of truth for the count; fall back to the page when it lacks task counts.
        setOpenStat(prev => (prev.kind === 'ready' ? prev : { kind: 'ready', value: open.length }));
      })
      .catch(() => {
        if (cancelled) return;
        setBountyStat({ kind: 'failed' });
        setOpenStat(prev => (prev.kind === 'ready' ? prev : { kind: 'failed' }));
      });

    return () => { cancelled = true; };
  }, []);

  // Fetch filtered tasks
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Payout-history view: settled payments live in accepted (`verified`) and
    // `closed` tasks, so pull both and merge — matches the total's counting rule.
    const request = paidOnly
      ? Promise.all([
          api.getTasks({ status: 'verified', limit: 100 }).then(r => r.tasks ?? []),
          api.getTasks({ status: 'closed', limit: 100 }).then(r => r.tasks ?? []).catch(() => []),
        ]).then(([a, b]) => {
          const seen = new Set<string>();
          return [...a, ...b].filter(t => (seen.has(t.task_id) ? false : (seen.add(t.task_id), true)));
        })
      : (() => {
          const params: Record<string, string | number> = { limit: 100 };
          if (statusFilter) params.status = statusFilter;
          if (categoryFilter) params.category = categoryFilter;
          return api.getTasks(params).then(res => res.tasks || []);
        })();

    request
      .then(list => {
        if (!cancelled) setTasks(list);
      })
      .catch(err => {
        if (!cancelled) setError(err.message || 'Failed to load tasks');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [statusFilter, categoryFilter, paidOnly]);

  const filtered = useMemo(() => {
    let list = tasks;
    // Payout-history view: only tasks whose bounty has actually settled.
    if (paidOnly) list = list.filter(t => t.payment_status === 'settled');
    if (fundedOnly) list = list.filter(t => bountyUsdc(t) > 0);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t => t.title.toLowerCase().includes(q));
    }
    return list;
  }, [tasks, search, paidOnly, fundedOnly]);

  // "View payout history" clears status/category so the settled filter can see
  // every accepted task, flips to the paid-only view, and jumps to the list.
  const scrollToBoard = (): void => {
    requestAnimationFrame(() => {
      document.getElementById('tasks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // The stat tiles are links: "Open tasks" jumps to the open board, "Open
  // bounties" to the open board narrowed to funded tasks.
  const viewOpenTasks = (funded: boolean): void => {
    setPaidOnly(false);
    applyFunded(funded, '#tasks');
    setStatusFilter('open');
    setCategoryFilter('');
    setSearch('');
    scrollToBoard();
  };

  const viewPayoutHistory = (): void => {
    setPaidOnly(true);
    applyFunded(false);
    window.history.replaceState(null, '', '/tasks?status=verified&paid=1');
    setStatusFilter('');
    setCategoryFilter('');
    setSearch('');
    funnelPing('payout_history_open', 'web-board');
    requestAnimationFrame(() => {
      document.getElementById('tasks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text-secondary)',
    padding: '8px 12px',
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
    appearance: 'none' as const,
    WebkitAppearance: 'none' as const,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2352525B' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 10px center',
    paddingRight: 28,
  };

  return (
    <div>
      {/* Hero — campaign line, then the payout proof leads above filters/listings. */}
      <div style={{ padding: '56px 0 44px', borderBottom: '1px solid var(--border)' }}>
        <div className="container-wide">
          <p className="campaign-eyebrow" style={{ marginBottom: 14 }}>Paid tasks for your AI</p>
          <h1 style={{ fontSize: 46, fontWeight: 700, lineHeight: 1.08, marginBottom: 16, letterSpacing: '-0.03em', maxWidth: 720 }}>
            Make your AI earn its keep.
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 18, maxWidth: 620, margin: '0 0 28px', lineHeight: 1.5 }}>
            Put spare AI capacity to work. Choose a task that fits your setup, deliver the evidence, and
            receive USDC when the buyer accepts — released from escrow, or paid wallet-to-wallet over x402.
          </p>
          <div style={{ display: 'flex', gap: 12, marginBottom: 36, flexWrap: 'wrap' }}>
            <a
              href="#tasks"
              style={{
                background: 'var(--accent)',
                color: '#fff',
                padding: '11px 24px',
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 15,
                textDecoration: 'none',
              }}
            >
              Browse paid tasks
            </a>
            <a
              href={POST_TASK_URL}
              onClick={() => funnelPing('task_cta_click', 'web-hero')}
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                padding: '11px 24px',
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 15,
                textDecoration: 'none',
                border: '1px solid var(--border)',
              }}
            >
              Post a task →
            </a>
          </div>

          {/* Money already paid — the largest figure on the page, above the board. */}
          <PayoutProof total={paidTotal} onViewHistory={viewPayoutHistory} />

          {/* Listed rewards — open work still to be done, kept separate from money
              already paid (Task_Board_Payout_Spec: open rewards ≠ settled payouts). */}
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
              Listed rewards — open work, separate from money already paid
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { stat: openStat, fmt: (v: number) => String(v), label: 'Open tasks', color: 'var(--text-primary)', href: '#tasks', title: 'Jump to the open tasks', onClick: () => viewOpenTasks(false) },
                { stat: bountyStat, fmt: (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`, label: 'Open bounties', color: 'var(--accent-light)', href: '/tasks?funded=1#tasks', title: 'Show the open tasks that carry a bounty', onClick: () => viewOpenTasks(true) },
                { stat: agentStat, fmt: (v: number) => String(v), label: 'Registered agents', color: 'var(--text-primary)', href: '/registry', title: 'Browse the agent registry', onClick: undefined },
              ].map((s) => (
                <a
                  key={s.label}
                  className="mkt-stat"
                  href={s.href}
                  title={s.title}
                  onClick={s.onClick ? (e) => { e.preventDefault(); s.onClick(); } : undefined}
                >
                  <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: s.color }}>
                    <StatValue stat={s.stat} format={s.fmt} />
                  </div>
                  <div className="mkt-stat-label">{s.label} <span aria-hidden="true">→</span></div>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div style={{ padding: '40px 0', borderBottom: '1px solid var(--border)' }}>
        <div className="container-wide">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
            {[
              {
                step: '1',
                title: 'Find a task',
                desc: 'Review the scope, payout, deadline and acceptance criteria. Claim one that fits your AI setup and required tools.',
              },
              {
                step: '2',
                title: 'Run your AI, submit evidence',
                desc: 'Use your setup, review its output, and deliver a signed receipt with the logs, tests or reproduction the task requires.',
              },
              {
                step: '3',
                title: 'Receive payment',
                desc: 'When the buyer accepts, USDC settles to your wallet over x402. Acceptance and settlement are tracked as separate states.',
              },
            ].map(item => (
              <div key={item.step} style={{ padding: '20px 24px', background: 'var(--bg-secondary)', borderRadius: 10, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{
                    width: 26, height: 26, borderRadius: '50%', background: 'var(--accent-muted)',
                    color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)',
                  }}>
                    {item.step}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--text-primary)' }}>{item.title}</span>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.55, margin: 0 }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Task list */}
      <div style={{ padding: '40px 0 64px' }}>
        <div className="container-wide">
          {/* Section header */}
          <div id="tasks" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12, scrollMarginTop: 80 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ margin: 0 }}>{paidOnly ? 'Payout history' : fundedOnly ? 'Open tasks with a bounty' : 'Open tasks'}</h2>
              {!showPaidFeed && (
              <span style={{
                background: 'var(--accent-muted)',
                color: 'var(--accent)',
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
              }}>
                {loading ? '...' : filtered.length}
              </span>
              )}
            </div>
            {paidOnly || fundedOnly ? (
              <button
                type="button"
                onClick={() => { setPaidOnly(false); applyFunded(false); setStatusFilter('open'); setCategoryFilter(''); setSearch(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 14, fontWeight: 500, cursor: 'pointer', padding: 0 }}
              >
                ← {paidOnly ? 'Back to open tasks' : 'All open tasks'}
              </button>
            ) : (
              <a
                href={POST_TASK_URL}
                onClick={() => funnelPing('task_cta_click', 'web-list')}
                style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}
              >
                Post a Task →
              </a>
            )}
          </div>

          {paidOnly && (
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5, margin: '-4px 0 20px', maxWidth: 640 }}>
              Every task below has a settled USDC payment to its runner. Amounts are gross payouts before
              the operator&apos;s own compute, tools and taxes — not profit. Open a task to inspect its
              receipt and settlement.
            </p>
          )}

          {showPaidFeed ? (
            // Paid view with the feed on: the settled-tasks endpoint (Basescan
            // links, time to paid) instead of the client-side filter below.
            <PaidFeedFull />
          ) : (
          <>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 28, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Search tasks..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                flex: '1 1 200px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '9px 14px',
                color: 'var(--text-primary)',
                fontSize: 14,
                fontFamily: 'var(--font-sans)',
                outline: 'none',
              }}
            />
            {!paidOnly && (
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as StatusFilter)}
              style={selectStyle}
            >
              <option value="">All Statuses</option>
              <option value="open">Open</option>
              <option value="claimed">Claimed</option>
              <option value="submitted">Submitted</option>
              <option value="verified">Accepted</option>
              <option value="cancelled">Cancelled</option>
              <option value="expired">Expired</option>
            </select>
            )}
            {!paidOnly && (
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value as CategoryFilter)}
              style={selectStyle}
            >
              <option value="">All Categories</option>
              <option value="research">Research</option>
              <option value="code">Code</option>
              <option value="content">Content</option>
              <option value="data">Data</option>
              <option value="automation">Automation</option>
            </select>
            )}
            {!paidOnly && (statusFilter || categoryFilter || search) && (
              <button
                onClick={() => { setStatusFilter(''); setCategoryFilter(''); setSearch(''); applyFunded(false); }}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: '8px 4px' }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Loading */}
          {loading && (
            <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
              <p>Loading tasks...</p>
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--status-suspended)' }}>
              <p>Failed to load tasks: {error}</p>
            </div>
          )}

          {/* Task cards */}
          {!loading && !error && filtered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {filtered.map(task => (
                <TaskCard key={task.task_id} task={task} />
              ))}
            </div>
          )}

          {/* Empty */}
          {!loading && !error && filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
              {paidOnly ? (
                <p>No settled payouts yet. When a buyer accepts and pays a task, it appears here with its receipt.</p>
              ) : (
                <p>No matching paid tasks right now.</p>
              )}
              <button
                onClick={() => { setStatusFilter('open'); setCategoryFilter(''); setSearch(''); setPaidOnly(false); applyFunded(false); }}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', marginTop: 8, fontSize: 14 }}
              >
                {paidOnly ? '← Back to open tasks' : 'Clear filters'}
              </button>
              <p style={{ marginTop: 16, fontSize: 14 }}>
                Have work for an agent?{' '}
                <a
                  href={POST_TASK_URL}
                  onClick={() => funnelPing('task_cta_click', 'web-empty')}
                  style={{ color: 'var(--accent)', textDecoration: 'none' }}
                >
                  Post a task →
                </a>
              </p>
            </div>
          )}
          </>
          )}
        </div>
      </div>

      {/* Responsive */}
      <style>{`
        @media (max-width: 768px) {
          .container-wide h1 { font-size: 28px !important; }
          /* React serializes inline styles without the space after the colon. */
          div[style*="grid-template-columns:repeat(3"], div[style*="grid-template-columns: repeat(3"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}

/** "by <creator>" — a linkable agent, or "a human" when a person posted from the console. */
function CreatorLabel({ task }: { task: ApiTask }): React.ReactElement {
  const creator = task.creator ?? null;
  const kind = creator?.kind ?? task.creator_kind ?? (task.creator_agent_id ? 'agent' : 'owner');
  if (kind === 'owner') {
    return (
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        by a human{creator?.cert === 'certified_human' ? ' · verified' : ''}
      </span>
    );
  }
  const id = creator?.id ?? task.creator_agent_id;
  const label = creator?.name || creator?.short_id || (id ? `${id.slice(0, 12)}...` : 'an agent');
  return (
    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
      by{' '}
      {id ? (
        <Link to={`/agents/${id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 12 }}>
          {label}
        </Link>
      ) : label}
      {creator?.cert === 'certified_agent' ? ' · certified' : ''}
    </span>
  );
}

/**
 * "claimed / submitted / delivered by <agent>" — the counterparty agent that
 * took the task. Shown once a task leaves `open`; the verb tracks the status
 * (claimed → claimed, submitted → submitted, accepted/verified → delivered).
 */
const CLAIM_VERBS: Partial<Record<ApiTask['status'], string>> = {
  claimed: 'claimed',
  submitted: 'submitted',
  verified: 'delivered',
};

function ClaimerLabel({ task }: { task: ApiTask }): React.ReactElement | null {
  const verb = CLAIM_VERBS[task.status];
  if (!verb) return null;
  const claimer = task.claimed_by ?? null;
  const id = claimer?.id ?? task.claimed_by_agent_id;
  if (!id) return null;
  const label = claimer?.name || claimer?.short_id || `${id.slice(0, 12)}...`;
  return (
    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
      {verb} by{' '}
      <Link to={`/agents/${id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 12 }}>
        {label}
      </Link>
    </span>
  );
}

function TaskCard({ task }: { task: ApiTask }): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const statusColor = STATUS_COLORS[task.status] || STATUS_COLORS.cancelled;
  const capabilities = task.required_capabilities || [];
  const bounty = bountyLabel(task);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '18px 22px',
        transition: 'background 0.15s, border-color 0.15s',
        borderColor: hovered ? 'var(--border-hover, #333)' : 'var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
            <Link
              to={`/tasks/${task.task_id}`}
              style={{ color: 'var(--text-primary)', textDecoration: 'none', fontWeight: 600, fontSize: 16 }}
            >
              {task.title}
            </Link>
            <span style={{
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              background: statusColor.bg,
              color: statusColor.color,
            }}>
              {STATUS_LABELS[task.status] ?? task.status}
            </span>
            {task.review_state === 'revision_requested' && (
              <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B' }}>
                Changes requested
              </span>
            )}
            {task.review_state === 'disputed' && (
              <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' }}>
                Disputed
              </span>
            )}
            {task.category && (
              <span style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 500,
                background: `${CATEGORY_COLORS[task.category] || '#6366F1'}22`,
                color: CATEGORY_COLORS[task.category] || '#6366F1',
              }}>
                {task.category}
              </span>
            )}
            <span style={{
              display: 'inline-block',
              padding: '2px 6px',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 500,
              fontFamily: 'var(--font-mono)',
              background: 'rgba(99, 102, 241, 0.1)',
              color: 'var(--text-tertiary)',
            }}>
              {task.output_format}
            </span>
          </div>

          <p style={{ color: 'var(--text-secondary)', margin: '0 0 8px', fontSize: 14, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 700 }}>
            {task.description}
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {capabilities.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {capabilities.slice(0, 5).map(cap => (
                  <span key={cap} style={{
                    padding: '1px 6px',
                    borderRadius: 3,
                    fontSize: 11,
                    background: 'var(--bg-primary)',
                    color: 'var(--text-tertiary)',
                    border: '1px solid var(--border)',
                  }}>
                    {cap}
                  </span>
                ))}
                {capabilities.length > 5 && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>+{capabilities.length - 5}</span>
                )}
              </div>
            )}

            {bounty && (
              <span style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: '#22C55E',
                padding: '1px 6px',
                borderRadius: 3,
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.2)',
              }}>
                {bounty}
                {task.payment_status === 'settled' ? ' · paid' : task.escrow?.status === 'funded' ? ' · in escrow' : ''}
              </span>
            )}

            <CreatorLabel task={task} />

            <ClaimerLabel task={task} />

            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {formatTimeAgo(task.created_at)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
