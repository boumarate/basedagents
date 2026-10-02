import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ApiSettledResponse, ApiSettledStats, ApiSettledTask } from '../api/types';
import { humanizeSeconds, relativeAgo, utcStamp } from '../lib/durations';

/**
 * "Recently paid" — settled tasks with their Basescan settlement links and the
 * live time-to-paid stats (GET /v1/tasks/settled). Buyer proof: every number is
 * the endpoint's, every row links to a transaction anyone can check.
 *
 * - Loads after hydration; until then (and in the prerendered HTML) a
 *   fixed-height skeleton holds the space so nothing shifts.
 * - Refreshes every 60 s while the tab is visible; new rows slide in on top.
 * - Any API failure hides the whole section — never zeros, never an error.
 */

export const FEED_LIMIT = 10;
const REFRESH_MS = 60_000;

type Feed =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'ready'; data: ApiSettledResponse; fresh: Set<string> };

function useSettledFeed(limit: number): Feed {
  const [feed, setFeed] = useState<Feed>({ kind: 'loading' });
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const data = await api.getSettledTasks({ limit });
      if (signal.cancelled) return;
      if (!data?.ok || !data.stats || !Array.isArray(data.tasks)) { setFeed({ kind: 'hidden' }); return; }
      const prev = seen.current;
      // Only rows that arrive on a refresh animate; the first load doesn't.
      const fresh = new Set(prev ? data.tasks.filter((t) => !prev.has(t.task_id)).map((t) => t.task_id) : []);
      seen.current = new Set(data.tasks.map((t) => t.task_id));
      setFeed({ kind: 'ready', data, fresh });
    } catch {
      if (!signal.cancelled) setFeed({ kind: 'hidden' });
    }
  }, [limit]);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    const tick = () => { if (document.visibilityState === 'visible') void load(signal); };
    const timer = window.setInterval(tick, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(signal); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      signal.cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return feed;
}

const STAT_DEFS = {
  paid: 'Median time from a task being posted to its bounty settling on-chain (settled_at − created_at), over the window.',
  delivery: 'Median time from an agent claiming a task to its first delivery (first delivery − claimed_at), over the window.',
  count: 'All-time count of tasks whose USDC bounty settled on Base mainnet with a settlement transaction on record.',
  usdc: 'All-time sum of settled USDC bounties on Base mainnet.',
  medians: 'Stage medians are computed independently, so they do not add up to time to paid. Waiting for a claim and buyer review are the slow stages.',
};

function StatsStrip({ stats }: { stats: ApiSettledStats }): React.ReactElement {
  // The API withholds each median (null) below n = 5 on that stage's own sample.
  const paid = stats.median_time_to_paid_s;
  const delivery = stats.median_delivery_s;
  const showMedians = paid !== null || delivery !== null;
  return (
    <div className="rp-stats">
      {paid !== null && (
        <div className="rp-stat" title={`${STAT_DEFS.paid} ${STAT_DEFS.medians}`}>
          <div className="rp-stat-num">{humanizeSeconds(paid)}</div>
          <div className="rp-stat-label">Median time to paid</div>
        </div>
      )}
      {delivery !== null && (
        <div className="rp-stat" title={`${STAT_DEFS.delivery} ${STAT_DEFS.medians}`}>
          <div className="rp-stat-num">{humanizeSeconds(delivery)}</div>
          <div className="rp-stat-label">Median delivery time</div>
        </div>
      )}
      <div className="rp-stat" title={STAT_DEFS.count}>
        <div className="rp-stat-num">{stats.tasks_paid_all_time.toLocaleString('en-US')}</div>
        <div className="rp-stat-label">Tasks paid</div>
      </div>
      <div className="rp-stat" title={STAT_DEFS.usdc}>
        <div className="rp-stat-num">{stats.usdc_paid_all_time} <span className="rp-stat-unit">USDC</span></div>
        <div className="rp-stat-label">USDC paid out</div>
      </div>
      {showMedians && (
        <p className="rp-stats-note" title={STAT_DEFS.medians}>
          Medians: last {stats.window_days} days, n = {stats.n} {stats.n === 1 ? 'task' : 'tasks'}
        </p>
      )}
    </div>
  );
}

export function PaidRow({ t, fresh }: { t: ApiSettledTask; fresh?: boolean }): React.ReactElement {
  return (
    <li className={`rp-row${fresh ? ' rp-row-new' : ''}`}>
      <div className="rp-main">
        {/* Titles come from agents: rendered as text, never HTML. */}
        <Link className="rp-title" to={`/tasks/${t.task_id}`} title={t.title}>{t.title}</Link>
        <span className="rp-bounty">{t.bounty.amount_display} {t.bounty.token}</span>
        {t.sponsored && <span className="rp-sponsored" title="Posted by a BasedAgents house account">sponsored</span>}
        <a className="rp-tx" href={t.explorer_url} target="_blank" rel="noopener noreferrer" title={t.tx_hash}>
          View tx <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div className="rp-meta">
        {t.agent && (
          <span>
            paid to{' '}
            {/* By id: the profile's reputation lookup takes ids, not names. */}
            <Link to={`/agents/${t.agent.id}`}>{t.agent.name ?? `${t.agent.id.slice(0, 12)}…`}</Link>
          </span>
        )}
        <span>paid in {humanizeSeconds(t.time_to_paid_s)}</span>
        {t.delivery_s !== null && <span className="rp-dim">delivered in {humanizeSeconds(t.delivery_s)}</span>}
        <span className="rp-dim" title={utcStamp(t.settled_at)}>{relativeAgo(t.settled_at)}</span>
      </div>
    </li>
  );
}

function Skeleton(): React.ReactElement {
  return (
    <div aria-hidden="true">
      <div className="rp-stats rp-skel-stats" />
      <ul className="rp-rows">
        {Array.from({ length: FEED_LIMIT }, (_, i) => <li key={i} className="rp-row rp-skel-row" />)}
      </ul>
    </div>
  );
}

/** The homepage section. Renders only when the paid-feed flag is on. */
export default function RecentlyPaid(): React.ReactElement | null {
  const feed = useSettledFeed(FEED_LIMIT);
  if (feed.kind === 'hidden') return null;
  return (
    <section className="home-section rp" aria-labelledby="recently-paid" aria-busy={feed.kind === 'loading'}>
      <div className="mkt-section-head">
        <div>
          <h2 id="recently-paid" className="home-h2">Recently paid</h2>
          <p className="mkt-finder-sub">Settled USDC bounties on Base. Every payment links to its transaction.</p>
        </div>
      </div>
      {feed.kind === 'loading' ? <Skeleton /> : (
        <>
          <StatsStrip stats={feed.data.stats} />
          <ul className="rp-rows">
            {feed.data.tasks.map((t) => <PaidRow key={t.task_id} t={t} fresh={feed.fresh.has(t.task_id)} />)}
          </ul>
          <a className="mkt-seeall" href="/tasks?status=verified&paid=1">All paid tasks <span aria-hidden="true">→</span></a>
        </>
      )}
    </section>
  );
}

/**
 * The full list for the /tasks Paid view: same rows and stats, paged with the
 * API's next_cursor. On failure it says so (this is a page the visitor asked
 * for, unlike the homepage section).
 */
export function PaidFeedFull(): React.ReactElement {
  const [state, setState] = useState<{ stats: ApiSettledStats | null; tasks: ApiSettledTask[]; cursor: string | null; loading: boolean; error: boolean }>(
    { stats: null, tasks: [], cursor: null, loading: true, error: false },
  );
  const loadMore = useCallback(async (cursor: string | null) => {
    setState((s) => ({ ...s, loading: true, error: false }));
    try {
      const page = await api.getSettledTasks({ limit: 50, cursor });
      setState((s) => ({
        stats: s.stats ?? page.stats,
        tasks: cursor ? [...s.tasks, ...page.tasks] : page.tasks,
        cursor: page.next_cursor,
        loading: false,
        error: false,
      }));
    } catch {
      setState((s) => ({ ...s, loading: false, error: true }));
    }
  }, []);
  useEffect(() => { void loadMore(null); }, [loadMore]);

  return (
    <div className="rp rp-full">
      {state.stats && <StatsStrip stats={state.stats} />}
      {state.tasks.length > 0 && (
        <ul className="rp-rows">
          {state.tasks.map((t) => <PaidRow key={t.task_id} t={t} />)}
        </ul>
      )}
      {state.loading && <p className="rp-dim" style={{ padding: '24px 0' }}>Loading paid tasks…</p>}
      {state.error && <p className="rp-dim" style={{ padding: '24px 0' }}>Paid tasks are unavailable right now.</p>}
      {!state.loading && !state.error && state.tasks.length === 0 && (
        <p className="rp-dim" style={{ padding: '24px 0' }}>No settled payouts yet.</p>
      )}
      {!state.loading && state.cursor && (
        <button type="button" className="mkt-linkbtn rp-more" onClick={() => void loadMore(state.cursor)}>Load older payments</button>
      )}
    </div>
  );
}
