/**
 * /testing/admin — the operator work queue (spec §16): intake review,
 * awaiting payment, awaiting task approval, executing, evidence review,
 * financial exceptions, cancellation requests, stuck operations.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { testingAdmin, type AdminQueue as Queue, type AdminOrderRow } from '../../api/testing.js';

/** "client/transport, client/transport" → env objects; invalid pairs dropped. */
function parseEnvs(text: string): Array<{ client: string; transport: string }> {
  return text.split(',').map((pair) => {
    const [client, transport] = pair.split('/').map((s) => s.trim());
    return { client: client ?? '', transport: transport ?? '' };
  }).filter((e) => e.client && e.transport);
}

function OrderRows({ rows }: { rows: AdminOrderRow[] }) {
  if (rows.length === 0) return <p className="empty">Nothing here.</p>;
  return (
    <div className="rows">
      {rows.map((o) => (
        <Link key={o.id} to={`/testing/admin/orders/${o.id}`} className="row">
          <span className="row-label">{o.id}</span>
          <span className="row-muted">{o.payment_state} · {o.fulfillment_state}{o.risk_hold ? ' · RISK HOLD' : ''}{o.cancel_requested_at ? ' · cancel requested' : ''}</span>
          <span className="row-date">{new Date(o.updated_at).toLocaleString()}</span>
        </Link>
      ))}
    </div>
  );
}

interface WorkerRow { agent_id: string; operator_group_id: string; status: string; provenance: string; environments_json: string; expires_at: string | null }

const EMPTY_ELIGIBILITY = {
  agent_id: '', operator_group_id: '', environments: '',
  provenance: 'operator_reviewed' as 'operator_reviewed' | 'self_reported',
  group_confidence: 'operator_reviewed' as 'operator_reviewed' | 'declared' | 'unverified',
  status: 'approved' as 'approved' | 'suspended' | 'revoked',
  notes: '',
};

export default function TestingAdminQueue() {
  const [queue, setQueue] = useState<(Queue & { package?: { price_cents: number; worker_cap_usdc_atomic: string } }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [eligibility, setEligibility] = useState(EMPTY_ELIGIBILITY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadWorkers = useCallback(() => {
    testingAdmin.listWorkers().then((r) => setWorkers(r.workers as WorkerRow[])).catch(() => setWorkers([]));
  }, []);

  useEffect(() => {
    testingAdmin.queue().then(setQueue).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    loadWorkers();
  }, [loadWorkers]);

  async function saveEligibility(): Promise<void> {
    const envs = parseEnvs(eligibility.environments);
    if (!eligibility.agent_id.trim() || !eligibility.operator_group_id.trim() || envs.length === 0) {
      setError('Eligibility needs an agent id, an operator group, and at least one client/transport environment.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await testingAdmin.upsertEligibility(eligibility.agent_id.trim(), {
        operator_group_id: eligibility.operator_group_id.trim(),
        group_confidence: eligibility.group_confidence,
        capabilities: ['agent-compatibility-testing'],
        environments: envs,
        evidence_refs: [],
        provenance: eligibility.provenance,
        status: eligibility.status,
        expires_at: null,
        notes: eligibility.notes,
      });
      setNotice(`Eligibility saved for ${eligibility.agent_id.trim()}.`);
      setEligibility(EMPTY_ELIGIBILITY);
      loadWorkers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!queue) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Testing — operator queue</h1>
        <button className="btn btn-ghost" onClick={() => void testingAdmin.metrics().then(setMetrics)}>Load metrics</button>
      </div>

      {queue.operations_needing_attention.length > 0 && (
        <section className="panel">
          <h2>⚠ Operations needing attention</h2>
          <div className="rows">
            {queue.operations_needing_attention.map((op) => (
              <div key={op.id} className="row">
                <span className="row-label">{op.kind}</span>
                <span className="row-muted">{op.last_error ?? ''}</span>
                {op.order_id && <Link to={`/testing/admin/orders/${op.order_id}`}>order</Link>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Intake review ({queue.intake_review.length})</h2>
        {queue.intake_review.length === 0 ? <p className="empty">No submitted requests.</p> : (
          <div className="rows">
            {queue.intake_review.map((r) => (
              <Link key={r.id} to={`/testing/admin/requests/${r.id}`} className="row">
                <span className="row-label">{r.id} (v{r.version})</span>
                <span className="row-muted">{r.source !== 'external_customer' ? r.source : ''}</span>
                <span className="row-date">{new Date(r.updated_at).toLocaleString()}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="panel"><h2>Awaiting payment ({queue.awaiting_payment.length})</h2><OrderRows rows={queue.awaiting_payment} /></section>
      <section className="panel"><h2>Paid — awaiting task approval ({queue.awaiting_task_approval.length})</h2><OrderRows rows={queue.awaiting_task_approval} /></section>
      <section className="panel"><h2>Executing ({queue.executing.length})</h2><OrderRows rows={queue.executing} /></section>
      <section className="panel"><h2>Evidence review ({queue.evidence_review.length})</h2><OrderRows rows={queue.evidence_review} /></section>
      <section className="panel"><h2>Paused / blocked ({queue.paused_or_blocked.length})</h2><OrderRows rows={queue.paused_or_blocked} /></section>
      <section className="panel"><h2>Cancellation requested ({queue.cancel_requested.length})</h2><OrderRows rows={queue.cancel_requested} /></section>

      <section className="panel">
        <h2>Worker eligibility</h2>
        {notice && <div className="banner banner-ok" role="status">{notice}</div>}
        <div className="rows">
          {workers.map((w) => (
            <div key={w.agent_id} className="row">
              <span className="row-label code-block-select">{w.agent_id}</span>
              <span className="row-muted">{w.operator_group_id} · {w.provenance.replace(/_/g, ' ')} · {parseEnvsFromJson(w.environments_json)}</span>
              <span className={`status status-${w.status === 'approved' ? 'approved' : 'denied'}`}>{w.status}</span>
            </div>
          ))}
          {workers.length === 0 && <p className="empty">No reviewed workers yet — nothing can be published until at least one is approved per quoted environment.</p>}
        </div>
        <div className="form-row">
          <span className="field-label">Add / update a worker (re-submitting an agent id overwrites its record)</span>
          <div className="field">
            <label className="field-label" htmlFor="el-agent">Agent id</label>
            <input id="el-agent" placeholder="ag_…" value={eligibility.agent_id} onChange={(e) => setEligibility({ ...eligibility, agent_id: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="el-group">Operator group (private; your best ownership evidence)</label>
            <input id="el-group" placeholder="grp-…" value={eligibility.operator_group_id} onChange={(e) => setEligibility({ ...eligibility, operator_group_id: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="el-envs">Environments — client/transport, comma-separated</label>
            <input id="el-envs" placeholder="claude-code/mcp, openhands/http" value={eligibility.environments} onChange={(e) => setEligibility({ ...eligibility, environments: e.target.value })} />
          </div>
          <div className="form-inline">
            <label>Provenance{' '}
              <select value={eligibility.provenance} onChange={(e) => setEligibility({ ...eligibility, provenance: e.target.value as typeof eligibility.provenance })}>
                <option value="operator_reviewed">operator reviewed (publishable coverage)</option>
                <option value="self_reported">self reported</option>
              </select>
            </label>
            <label>Group confidence{' '}
              <select value={eligibility.group_confidence} onChange={(e) => setEligibility({ ...eligibility, group_confidence: e.target.value as typeof eligibility.group_confidence })}>
                <option value="operator_reviewed">operator reviewed</option>
                <option value="declared">declared</option>
                <option value="unverified">unverified</option>
              </select>
            </label>
            <label>Status{' '}
              <select value={eligibility.status} onChange={(e) => setEligibility({ ...eligibility, status: e.target.value as typeof eligibility.status })}>
                <option value="approved">approved</option>
                <option value="suspended">suspended</option>
                <option value="revoked">revoked</option>
              </select>
            </label>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="el-notes">Notes</label>
            <input id="el-notes" value={eligibility.notes} onChange={(e) => setEligibility({ ...eligibility, notes: e.target.value })} />
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={() => void saveEligibility()}>Save eligibility</button>
          </div>
        </div>
      </section>

      {metrics && (
        <section className="panel">
          <h2>Metrics (server records; founder/test work excluded from external demand)</h2>
          <pre className="code-block">{JSON.stringify(metrics, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

function parseEnvsFromJson(json: string): string {
  try {
    const envs = JSON.parse(json) as Array<{ client?: string; transport?: string }>;
    return envs.map((e) => `${e.client}/${e.transport}`).join(', ');
  } catch {
    return '';
  }
}
