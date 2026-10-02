/**
 * /testing/reports/:id — the private report as a legible HTML document
 * (spec §4.6): scope, coverage, execution matrix, baseline comparison,
 * evidence-backed findings, limitations, retest terms, evidence index.
 * Print-friendly; results are never encoded by color alone.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { testing, type TestingReportDoc } from '../../api/testing.js';

const RESULT_TEXT: Record<string, string> = {
  product_success: '✓ completed',
  product_failure: '✗ product failure',
  inconclusive: '? inconclusive',
  evidence_invalid: '⊘ evidence invalid',
  not_attempted: '– not attempted',
};

export default function TestingReport() {
  const { reportId } = useParams();
  const [report, setReport] = useState<TestingReportDoc | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reportId) return;
    testing.getReport(reportId)
      .then((r) => { setReport(r.report); setPublishedAt(r.published_at); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [reportId]);

  if (error) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!report) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page report-doc">
      <div className="page-head">
        <h1>Agent compatibility report</h1>
        <div className="btn-row">
          <a className="btn" href={testing.exportUrl(report.report_id, 'md')}>Markdown</a>
          <a className="btn" href={testing.exportUrl(report.report_id, 'json')}>JSON</a>
          <button className="btn" onClick={() => window.print()}>Print</button>
          <Link className="btn btn-ghost" to={`/testing/orders/${report.order_id}`}>Order</Link>
        </div>
      </div>

      <section className="panel">
        <h2>Scope</h2>
        <div className="kv"><span className="kv-key">Report</span><span>v{report.version}{publishedAt ? ` · published ${new Date(publishedAt).toLocaleString()}` : ''}</span></div>
        <div className="kv"><span className="kv-key">Workflow</span><span className="prewrap">{report.workflow_objective}</span></div>
        <div className="kv"><span className="kv-key">Expected result</span><span className="prewrap">{report.expected_result}</span></div>
        <div className="kv"><span className="kv-key">Release under test</span><span>{report.release_identifier ?? 'not recorded'}</span></div>
        <div className="kv"><span className="kv-key">Observed</span><span>{report.observation_period.from ? new Date(report.observation_period.from).toLocaleString() : 'n/a'} → {report.observation_period.to ? new Date(report.observation_period.to).toLocaleString() : 'n/a'}</span></div>
        <div className="kv"><span className="kv-key">Scope hash</span><span className="code-block-select">{report.scope_hash}</span></div>
      </section>

      <section className="panel">
        <h2>Executive summary</h2>
        <p className="prewrap">{report.executive_summary}</p>
      </section>

      <section className="panel">
        <h2>Coverage</h2>
        <ul>
          <li>{report.coverage.external_runs_valid} valid reviewed external runs of {report.coverage.external_runs_planned} planned</li>
          <li>{report.coverage.distinct_environments} distinct environments observed</li>
          <li>{report.coverage.reviewed_operator_groups} reviewed operator groups</li>
          {report.coverage.unknowns.map((u) => <li key={u}>Unknown: {u}</li>)}
        </ul>
      </section>

      <section className="panel">
        <h2>Execution matrix</h2>
        <div className="rows">
          {report.execution_matrix.map((row) => (
            <div key={row.run_id} className="row">
              <span className="row-label">{row.kind} · {row.environment.client}/{row.environment.transport}
                {row.environment.observed_client_version ? ` (${row.environment.observed_client_version})` : ''}</span>
              <span>{RESULT_TEXT[row.result] ?? row.result}</span>
              <span className="row-muted">
                env {row.environment_demonstrated === null ? 'unknown' : row.environment_demonstrated ? 'demonstrated' : 'not demonstrated'}
                {row.first_failure_stage ? ` · first failure: ${row.first_failure_stage}` : ''}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Baseline comparison</h2>
        <p>{report.baseline.ran ? <>Internal baseline result: <strong>{RESULT_TEXT[report.baseline.result] ?? report.baseline.result}</strong>.</> : 'The internal baseline did not run.'} {report.baseline.note}</p>
      </section>

      <section className="panel">
        <h2>Findings ({report.findings.length})</h2>
        {report.findings.length === 0 && <p className="empty">No findings met the reporting bar in the reviewed evidence.</p>}
        {report.findings.map((f) => (
          <article key={f.finding_id} className="card testing-stack">
            <div className="card-title">
              {f.finding_id} · {f.severity.toUpperCase()} · {f.category.replace(/_/g, ' ')} · <em>{f.statement_type}</em>
            </div>
            <div className="card-main prewrap">{f.summary}</div>
            <div className="card-meta">
              Runs: {f.affected_run_ids.join(', ')}
              {f.supporting_evidence_ids.length > 0 && <> · evidence: {f.supporting_evidence_ids.join(', ')}</>}
              {' '}· vs baseline: {f.baseline_relation.replace(/_/g, ' ')}
              {f.retest_status !== 'none' && <> · retest: {f.retest_status.replace(/_/g, ' ')}</>}
            </div>
            {f.reproduction_steps.length > 0 && (
              <details><summary>Reproduction steps</summary>
                <ol>{f.reproduction_steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              </details>
            )}
            {f.suggested_change && <p className="card-note">Suggested change (recommendation, not an observation): {f.suggested_change}</p>}
          </article>
        ))}
      </section>

      <section className="panel">
        <h2>Limitations</h2>
        <ul>{report.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </section>

      <section className="panel">
        <h2>Retest entitlement</h2>
        <p>{report.retest.included_slots} included targeted retest{report.retest.included_slots === 1 ? '' : 's'}, {report.retest.used_slots} used{report.retest.deadline_at ? `, request by ${new Date(report.retest.deadline_at).toLocaleString()}` : ''}.</p>
      </section>

      <section className="panel">
        <h2>Evidence index</h2>
        {report.evidence_index.length === 0 && <p className="empty">No evidence records.</p>}
        <div className="rows">
          {report.evidence_index.map((e) => (
            <div key={`${e.run_id}-${e.evidence_id}`} className="row">
              <span className="row-label">{e.evidence_id} · run {e.run_id} · {e.kind.replace(/_/g, ' ')}</span>
              <span className="row-muted code-block-select">sha256 {e.content_sha256.slice(0, 24)}…</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Version history</h2>
        <ul>{report.version_history.map((v) => <li key={v.version}>v{v.version}: {v.note}{v.published_at ? ` (published ${new Date(v.published_at).toLocaleString()})` : ''}</li>)}</ul>
        <p className="muted">Generated {new Date(report.generated_at).toLocaleString()}.</p>
      </section>
    </div>
  );
}
