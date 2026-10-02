/**
 * /testing — the customer's audits: requests in review and purchased orders.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { testing, type TestingOrderSummary, type TestingQuote, type TestingRequest } from '../../api/testing.js';
import { ControlApiError } from '../../api/control.js';

const REQUEST_LABEL: Record<TestingRequest['status'], string> = {
  draft: 'Draft — not submitted',
  submitted: 'Scope review',
  needs_changes: 'Changes requested',
  declined: 'Declined',
  quoted: 'Quote ready',
};

export default function TestingAudits() {
  const [requests, setRequests] = useState<Array<TestingRequest & { quote: TestingQuote | null }> | null>(null);
  const [orders, setOrders] = useState<TestingOrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([testing.listRequests(), testing.listOrders()])
      .then(([r, o]) => {
        setRequests(r.requests);
        setOrders(o.orders);
      })
      .catch((err) => {
        if (err instanceof ControlApiError && err.status === 404) {
          setError('Agent testing is not enabled on this deployment.');
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
  }, []);

  if (error) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!requests || !orders) return <div className="page"><p className="muted">Loading…</p></div>;

  const orderIdsByRequest = new Set(orders.map((o) => o.id));
  void orderIdsByRequest;
  const openRequests = requests.filter((r) => r.status !== 'declined');

  return (
    <div className="page">
      <div className="page-head">
        <h1>Agent testing</h1>
        <Link to="/testing/new" className="btn btn-primary">Request an audit</Link>
      </div>
      <p className="page-lede">
        Buy a scoped agent-compatibility audit: one workflow, executed by independent operators in
        approved environments, reviewed by us, delivered as one private report.
      </p>

      <section className="panel">
        <h2>Requests</h2>
        {openRequests.length === 0 && <p className="empty">No requests yet. Start with “Request an audit”.</p>}
        <div className="rows">
          {openRequests.map((r) => (
            <Link key={r.id} to={`/testing/requests/${r.id}`} className="row">
              <span className="row-label">{r.intake.product_name || r.id}</span>
              <span className={`status status-${r.status === 'quoted' ? 'approved' : r.status === 'needs_changes' ? 'review' : 'open'}`}>
                {REQUEST_LABEL[r.status]}
              </span>
              <span className="row-date">{new Date(r.updated_at).toLocaleDateString()}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Orders</h2>
        {orders.length === 0 && <p className="empty">No purchased audits yet.</p>}
        <div className="rows">
          {orders.map((o) => (
            <Link key={o.id} to={`/testing/orders/${o.id}`} className="row">
              <span className="row-label">{o.id}</span>
              <span className={`status status-${o.stage === 'Report ready' ? 'verified' : 'open'}`}>{o.stage}</span>
              <span className="row-muted">
                {o.external_runs_planned != null ? `${o.external_runs_complete}/${o.external_runs_planned} runs reviewed` : ''}
              </span>
              <span className="row-date">{new Date(o.created_at).toLocaleDateString()}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
