/**
 * /testing/orders/:id — customer order status (spec §4.5): honest stages, a
 * plain blocker when present, report access, the included retest, feedback,
 * cancellation request and repeat purchase.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { testing, type TestingOrderDetail, type TestingReportDoc } from '../../api/testing.js';

const STAGES = ['Scope review', 'Ready to purchase', 'Payment confirmation', 'Preparing tests', 'Testing', 'Reviewing evidence', 'Report ready'];

export default function TestingOrder() {
  const { orderId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState<TestingOrderDetail | null>(null);
  const [report, setReport] = useState<TestingReportDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retest, setRetest] = useState({ finding_id: '', change_description: '', updated_target: '' });
  const [feedback, setFeedback] = useState({ useful: '' as '' | 'yes' | 'partial' | 'no', action_taken: '', incremental: '' });
  const [cancelReason, setCancelReason] = useState('');

  const checkoutReturn = params.get('checkout'); // success | cancelled | null

  const load = useCallback(() => {
    if (!orderId) return;
    testing.getOrder(orderId)
      .then(({ order }) => {
        setOrder(order);
        if (order.report_id) {
          testing.getReport(order.report_id).then((r) => setReport(r.report)).catch(() => setReport(null));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [orderId]);

  useEffect(load, [load]);

  // While the server is verifying a fresh payment, poll briefly.
  useEffect(() => {
    if (checkoutReturn === 'success' && order && order.payment_state !== 'succeeded') {
      const t = setTimeout(load, 2500);
      return () => clearTimeout(t);
    }
  }, [checkoutReturn, order, load]);

  if (error) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!order) return <div className="page"><p className="muted">Loading…</p></div>;

  const stageIndex = STAGES.indexOf(order.stage);

  async function act(fn: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNotice(done);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const retestOpen = !!order.retest_deadline_at && new Date(order.retest_deadline_at) > new Date() && !order.retest_requested;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Audit order</h1>
        <Link className="btn btn-ghost" to="/testing">All audits</Link>
      </div>

      {checkoutReturn === 'success' && order.payment_state !== 'succeeded' && (
        <div className="banner banner-warn" role="status">Confirming payment — this page updates once our servers verify it with the payment provider.</div>
      )}
      {checkoutReturn === 'cancelled' && <div className="banner banner-warn">Checkout was cancelled — nothing was charged.</div>}
      {notice && <div className="banner banner-ok" role="status">{notice}</div>}
      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {order.blocker && <div className="banner banner-warn"><strong>Attention:</strong> {order.blocker}</div>}

      <section className="panel">
        <h2>Status: {order.stage}</h2>
        <ol className="timeline">
          {STAGES.map((s, i) => (
            <li key={s} className={i < stageIndex ? 'decided' : i === stageIndex ? 'asking' : ''}>
              <span className="timeline-label">{i <= stageIndex ? '✓' : '·'} {s}</span>
            </li>
          ))}
        </ol>
        <div className="kv"><span className="kv-key">Order</span><span className="code-block-select">{order.id}</span></div>
        <div className="kv"><span className="kv-key">Payment</span><span>{order.payment_state}{order.refund_state !== 'none' ? ` · refund ${order.refund_state}` : ''}</span></div>
        {order.delivery_target_at && (
          <div className="kv"><span className="kv-key">Delivery target</span><span>{new Date(order.delivery_target_at).toLocaleString()} (a target, not a guarantee)</span></div>
        )}
        {order.external_runs_planned != null && (
          <div className="kv"><span className="kv-key">External runs</span>
            <span>{order.external_runs_complete}/{order.external_runs_planned} valid reviewed runs</span></div>
        )}
        {order.runs && order.runs.length > 0 && (
          <div className="rows">
            {order.runs.map((r) => (
              <div key={r.id} className="row">
                <span className="row-label">{r.kind === 'baseline' ? 'Internal baseline' : `${r.kind} · ${r.environment.client}/${r.environment.transport}`}</span>
                <span className={`status status-${r.result === 'in_progress' ? 'open' : 'verified'}`}>{r.result.replace(/_/g, ' ')}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {order.report_id && (
        <section className="panel">
          <h2>Report</h2>
          <p>Your private report (version {order.report_version}) is published.</p>
          <div className="btn-row">
            <Link className="btn btn-primary" to={`/testing/reports/${order.report_id}`}>Read the report</Link>
            <a className="btn" href={testing.exportUrl(order.report_id, 'md')}>Export Markdown</a>
            <a className="btn" href={testing.exportUrl(order.report_id, 'json')}>Export JSON</a>
          </div>
        </section>
      )}

      {retestOpen && report && (
        <section className="panel">
          <h2>Included targeted retest</h2>
          <p className="panel-note">
            One retest of one reported finding in one environment is included until{' '}
            {new Date(order.retest_deadline_at!).toLocaleString()}. Tell us which finding you addressed.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="rt-f">Finding</label>
            <select id="rt-f" value={retest.finding_id} onChange={(e) => setRetest({ ...retest, finding_id: e.target.value })}>
              <option value="">Choose a finding…</option>
              {report.findings.map((f) => <option key={f.finding_id} value={f.finding_id}>{f.finding_id} — {f.summary.slice(0, 80)}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="rt-c">What changed</label>
            <textarea id="rt-c" rows={2} maxLength={2000} value={retest.change_description} onChange={(e) => setRetest({ ...retest, change_description: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="rt-t">Updated safe target / version</label>
            <input id="rt-t" maxLength={500} value={retest.updated_target} onChange={(e) => setRetest({ ...retest, updated_target: e.target.value })} />
          </div>
          <button className="btn btn-primary" disabled={busy || !retest.finding_id || !retest.change_description.trim() || !retest.updated_target.trim()}
            onClick={() => void act(() => testing.requestRetest(order.id, retest.finding_id, retest.change_description, retest.updated_target), 'Retest requested — an operator confirms it before work is published.')}>
            Request the included retest
          </button>
        </section>
      )}

      {order.report_id && (
        <section className="panel">
          <h2>Was the report useful?</h2>
          <div className="field">
            <label className="field-label" htmlFor="fb-u">Usefulness</label>
            <select id="fb-u" value={feedback.useful} onChange={(e) => setFeedback({ ...feedback, useful: e.target.value as typeof feedback.useful })}>
              <option value="">—</option><option value="yes">Yes</option><option value="partial">Partially</option><option value="no">No</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="fb-a">What did you change because of it?</label>
            <input id="fb-a" maxLength={2000} value={feedback.action_taken} onChange={(e) => setFeedback({ ...feedback, action_taken: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="fb-i">Did external runs find anything the baseline did not?</label>
            <select id="fb-i" value={feedback.incremental} onChange={(e) => setFeedback({ ...feedback, incremental: e.target.value })}>
              <option value="">—</option>
              <option value="external_only">Yes — external-only findings</option>
              <option value="both">Findings in both</option>
              <option value="baseline_only">Only the baseline found things</option>
              <option value="none">Nothing found</option>
              <option value="unsure">Not sure</option>
            </select>
          </div>
          <button className="btn" disabled={busy}
            onClick={() => void act(() => testing.feedback(order.id, {
              useful: feedback.useful || undefined,
              action_taken: feedback.action_taken || undefined,
              incremental: feedback.incremental || undefined,
            }), 'Thanks — feedback recorded.')}>
            Send feedback
          </button>
        </section>
      )}

      <section className="panel">
        <h2>More</h2>
        <div className="btn-row">
          <button className="btn" disabled={busy}
            onClick={() => void act(async () => {
              const { request } = await testing.repeat(order.id);
              navigate(`/testing/requests/${request.id}/edit`);
            }, '')}>
            Run another audit (copies this scope into a new draft — nothing is charged now)
          </button>
        </div>
        {!order.cancel_requested_at && order.fulfillment_state !== 'delivered' && order.fulfillment_state !== 'cancelled' && (
          <div className="form-row">
            <label className="field-label" htmlFor="cx">Request cancellation</label>
            <input id="cx" maxLength={2000} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Why? (optional)" />
            <button className="btn btn-danger" disabled={busy}
              onClick={() => void act(() => testing.requestCancel(order.id, cancelReason), 'Cancellation requested — an operator reviews it; no refund is issued automatically.')}>
              Request cancellation / refund review
            </button>
          </div>
        )}
        {order.cancel_requested_at && <p className="muted">Cancellation requested {new Date(order.cancel_requested_at).toLocaleString()} — under operator review.</p>}
      </section>
    </div>
  );
}
