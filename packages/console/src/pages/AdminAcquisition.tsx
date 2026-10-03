/**
 * /admin/acquisition — operator view of MCP acquisition attribution.
 *
 * Reads GET /v1/owner/admin/acquisition (same query layer as the bearer
 * endpoint GET /v1/admin/acquisition). The route answers 404 unless
 * ADMIN_OWNER_IDS lists this account, and the nav link only shows for admins.
 *
 * The page labels its own caveats on purpose: installations are not people or
 * downloads, unknown is its own row, cohort and activity views never share a
 * denominator, buyer and worker perspectives are never summed, and settled
 * USDC is payouts, not revenue.
 */
import { useCallback, useEffect, useState } from 'react';
import { control, ControlApiError } from '../api/control.js';
import type {
  AcquisitionActivityReport,
  AcquisitionCohortReport,
  AcquisitionQuery,
} from '../api/types.js';
import { useOwner } from '../state/session.js';

const SOURCES = ['', 'website', 'github', 'npm', 'mcp_registry', 'pulsemcp', 'glama', 'smithery', 'hackernews', 'partner', 'unknown'];
const INTERFACES = ['', 'mcp_stdio', 'mcp_http', 'cli', 'sdk', 'web'];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** A rate with its denominator, or N/A on an empty denominator. */
function rate(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}% (${n}/${d})` : 'N/A';
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function CohortTables({ report }: { report: AcquisitionCohortReport }) {
  const c = report.coverage;
  return (
    <>
      <h2 className="acq-h2">Attribution coverage</h2>
      <p className="muted acq-note">
        Share of observed installations with a known source. The at-first-observation measure is never revised by
        later evidence; later-known coverage is shown beside it.
      </p>
      <div className="acq-kpis">
        <div><div className="fb-label">Observed installations</div><div className="acq-kpi">{c.observed_installations}</div></div>
        <div><div className="fb-label">Known at first observation</div><div className="acq-kpi">{c.coverage_at_first_pct === null ? 'N/A' : `${c.coverage_at_first_pct}%`}</div></div>
        <div><div className="fb-label">Known at any point</div><div className="acq-kpi">{c.coverage_ever_pct === null ? 'N/A' : `${c.coverage_ever_pct}%`}</div></div>
      </div>

      <h2 className="acq-h2">Installations first observed in the period</h2>
      <p className="muted acq-note">
        Distinct stable installation ids seen by the API — not downloads, process launches or people. Grouped by the
        earliest known source.
      </p>
      <div className="acq-scroll">
        <table className="acq-table">
          <thead><tr><th>Source</th><th>Observed installations</th><th>Known at first observation</th><th>Known later</th></tr></thead>
          <tbody>
            {report.installations.length === 0 && <tr><td colSpan={4} className="muted">No installations in this period.</td></tr>}
            {report.installations.map((r) => (
              <tr key={r.source}>
                <td><code>{r.source}</code></td>
                <td>{r.observed_installations}</td>
                <td>{r.known_at_first_observation}</td>
                <td>{r.known_ever - r.known_at_first_observation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="acq-h2">Agents registered in the period (cohort)</h2>
      <p className="muted acq-note">
        Attributed at actual registration; agents that predate attribution are not new acquisitions. Worker columns
        follow the agent as deliverer, buyer columns follow the same agent as task poster — never summed. Settled USDC
        is worker payouts (mainnet, not refunded), not platform revenue. 7-day returning = a successful non-discovery
        use 7–14 days after registration; agents registered less than 14 days ago are immature and excluded from that
        rate.
      </p>
      <div className="acq-scroll">
        <table className="acq-table">
          <thead>
            <tr>
              <th>Source</th><th>New agents</th><th>First claim</th><th>First accepted delivery</th><th>First paid</th>
              <th>Settled worker USDC</th><th>Buyers w/ escrow-funded task</th><th>Repeat escrow buyers</th>
              <th>Buyers paid at accept</th><th>Repeat paid-at-accept</th><th>7-day returning</th><th>Immature</th>
            </tr>
          </thead>
          <tbody>
            {report.agents.length === 0 && <tr><td colSpan={12} className="muted">No registrations in this period.</td></tr>}
            {report.agents.map((r) => (
              <tr key={r.source}>
                <td><code>{r.source}</code></td>
                <td>{r.new_agents}</td>
                <td>{rate(r.agents_with_first_claim, r.new_agents)}</td>
                <td>{rate(r.agents_with_first_accepted_delivery, r.new_agents)}</td>
                <td>{rate(r.first_paid_agents, r.new_agents)}</td>
                <td>{r.settled_worker_usdc}</td>
                <td>{r.buyers_with_first_funded_task}</td>
                <td>{r.repeat_funded_buyers}</td>
                <td>{r.buyers_with_first_paid_at_accept}</td>
                <td>{r.repeat_paid_at_accept_buyers}</td>
                <td>{rate(r.returning_7d, r.mature_agents)}</td>
                <td>{r.immature_agents}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="acq-h2">Human buyers (console accounts)</h2>
      <p className="muted acq-note">Console accounts carry no acquisition source in this model; reported as their own bucket.</p>
      <div className="acq-kpis">
        <div><div className="fb-label">New accounts</div><div className="acq-kpi">{report.human_buyers.new_owners}</div></div>
        <div><div className="fb-label">With an escrow-funded task</div><div className="acq-kpi">{report.human_buyers.buyers_with_first_funded_task}</div></div>
        <div><div className="fb-label">Repeat escrow</div><div className="acq-kpi">{report.human_buyers.repeat_funded_buyers}</div></div>
        <div><div className="fb-label">Paid at accept</div><div className="acq-kpi">{report.human_buyers.buyers_with_first_paid_at_accept}</div></div>
        <div><div className="fb-label">Repeat paid at accept</div><div className="acq-kpi">{report.human_buyers.repeat_paid_at_accept_buyers}</div></div>
      </div>
    </>
  );
}

function ActivityTable({ report }: { report: AcquisitionActivityReport }) {
  const workers = report.rows.filter((r) => r.perspective === 'worker');
  const buyers = report.rows.filter((r) => r.perspective === 'buyer');
  return (
    <>
      <h2 className="acq-h2">Worker activity in the period</h2>
      <p className="muted acq-note">Events that happened in the period, grouped by the deliverer’s acquisition source (any cohort).</p>
      <div className="acq-scroll">
        <table className="acq-table">
          <thead><tr><th>Source</th><th>Claims</th><th>Deliveries</th><th>Acceptances</th><th>Settled payouts</th><th>Settled worker USDC</th></tr></thead>
          <tbody>
            {workers.length === 0 && <tr><td colSpan={6} className="muted">No worker activity in this period.</td></tr>}
            {workers.map((r) => (
              <tr key={r.source}>
                <td><code>{r.source}</code></td><td>{r.claims}</td><td>{r.deliveries}</td><td>{r.acceptances}</td>
                <td>{r.settled_payouts}</td><td>{r.settled_worker_usdc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="acq-h2">Buyer activity in the period</h2>
      <p className="muted acq-note">
        Two payment modes, never added together: confirmed escrow deposits, and no-escrow bounties paid at
        acceptance. Grouped by the poster’s source (human_buyer = console accounts).
      </p>
      <div className="acq-scroll">
        <table className="acq-table">
          <thead><tr><th>Source</th><th>Escrow-funded tasks</th><th>Paid at accept</th></tr></thead>
          <tbody>
            {buyers.length === 0 && <tr><td colSpan={3} className="muted">No funded or paid tasks in this period.</td></tr>}
            {buyers.map((r) => (
              <tr key={r.source}><td><code>{r.source}</code></td><td>{r.funded_tasks}</td><td>{r.paid_at_accept_tasks}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function AdminAcquisition() {
  const { owner } = useOwner();
  const [query, setQuery] = useState<AcquisitionQuery>(() => ({
    view: 'cohort',
    from: isoDay(new Date(Date.now() - 30 * 86_400_000)),
    to: isoDay(new Date(Date.now() + 86_400_000)),
  }));
  const [report, setReport] = useState<AcquisitionCohortReport | AcquisitionActivityReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setReport(null);
    try {
      setReport(await control.adminAcquisition(query));
    } catch (err) {
      setError(err instanceof ControlApiError && err.status === 404 ? 'This page is for operators.' : err instanceof Error ? err.message : 'Failed to load');
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  async function exportCsv(table?: 'installations' | 'agents') {
    try {
      const blob = await control.adminAcquisitionCsv(query, table);
      download(blob, `acquisition-${query.view}${table ? `-${table}` : ''}.csv`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    }
  }

  if (!owner) return null;
  const set = (patch: Partial<AcquisitionQuery>) => setQuery((q) => ({ ...q, ...patch }));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Acquisition</h1>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => void load()}>Refresh</button>
          {query.view === 'cohort' ? (
            <>
              <button className="btn btn-ghost" onClick={() => void exportCsv('agents')}>Agents CSV</button>
              <button className="btn btn-ghost" onClick={() => void exportCsv('installations')}>Installations CSV</button>
            </>
          ) : (
            <button className="btn btn-ghost" onClick={() => void exportCsv()}>CSV</button>
          )}
        </div>
      </div>
      <p className="page-lede">
        Where installations, agents and buyers came from, joined to committed marketplace state. Sources are reported
        evidence from install tags, not verified identity; <code>unknown</code> is its own row.
      </p>

      <div className="acq-filters">
        <div className="btn-row">
          {(['cohort', 'activity'] as const).map((v) => (
            <button key={v} className={v === query.view ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'} onClick={() => set({ view: v })}>
              {v === 'cohort' ? 'Acquisition cohorts' : 'Activity in period'}
            </button>
          ))}
        </div>
        <label>From <input type="date" value={query.from ?? ''} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>To <input type="date" value={query.to ?? ''} onChange={(e) => set({ to: e.target.value })} /></label>
        <label>Source
          <select value={query.source ?? ''} onChange={(e) => set({ source: e.target.value || undefined })}>
            {SOURCES.map((s) => <option key={s} value={s}>{s || 'all'}</option>)}
          </select>
        </label>
        <label>Interface
          <select value={query.interface ?? ''} onChange={(e) => set({ interface: e.target.value || undefined })}>
            {INTERFACES.map((s) => <option key={s} value={s}>{s || 'all'}</option>)}
          </select>
        </label>
        <label>Campaign
          <input placeholder="any" value={query.campaign ?? ''} onChange={(e) => set({ campaign: e.target.value.trim().toLowerCase() || undefined })} />
        </label>
        <label className="acq-check">
          <input type="checkbox" checked={!!query.include_internal} onChange={(e) => set({ include_internal: e.target.checked })} />
          Include internal and house traffic
        </label>
      </div>

      {error && <div className="banner banner-error">{error}</div>}
      {!report && !error && <div className="empty"><p className="muted">Loading…</p></div>}
      {report?.view === 'cohort' && <CohortTables report={report} />}
      {report?.view === 'activity' && <ActivityTable report={report} />}
    </div>
  );
}
