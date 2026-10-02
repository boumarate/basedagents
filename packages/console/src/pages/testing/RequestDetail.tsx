/**
 * /testing/requests/:id — request status and, when quoted, the exact frozen
 * scope + disclosures + "Approve scope and pay" (spec §4.4). The price and
 * every limit shown here come from the server-approved quote.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { testing, type TestingQuote, type TestingRequest } from '../../api/testing.js';
import { ControlApiError } from '../../api/control.js';

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function freshIdempotencyKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `ck-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export default function TestingRequestDetail() {
  const { requestId } = useParams();
  const [request, setRequest] = useState<TestingRequest | null>(null);
  const [quote, setQuote] = useState<TestingQuote | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per review of this quote: a double-click reuses the
  // same checkout attempt instead of minting another.
  const idemKey = useMemo(freshIdempotencyKey, []);

  const load = useCallback(() => {
    if (!requestId) return;
    testing.getRequest(requestId)
      .then((res) => { setRequest(res.request); setQuote(res.quote); setOrderId(res.order_id); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [requestId]);

  useEffect(load, [load]);

  async function pay(): Promise<void> {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      const { checkout_url } = await testing.checkout(quote.id, quote, idemKey);
      window.location.assign(checkout_url);
    } catch (err) {
      setError(err instanceof ControlApiError ? `${err.message}` : String(err));
      setBusy(false);
      load();
    }
  }

  async function requestChange(): Promise<void> {
    if (!quote || !changeNote.trim()) return;
    setBusy(true);
    try {
      await testing.requestQuoteChange(quote.id, changeNote.trim());
      setChangeNote('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !request) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!request) return <div className="page"><p className="muted">Loading…</p></div>;

  const quoteLive = quote && quote.status === 'approved' && new Date(quote.expires_at) > new Date();

  return (
    <div className="page">
      <div className="page-head">
        <h1>{request.intake.product_name}</h1>
        <Link className="btn btn-ghost" to="/testing">All audits</Link>
      </div>
      {error && <div className="banner banner-error" role="alert">{error}</div>}

      {request.status === 'submitted' && (
        <div className="banner banner-ok">Scope review in progress. <strong>No payment has been taken.</strong> We will confirm coverage before you pay.</div>
      )}
      {request.status === 'needs_changes' && (
        <div className="banner banner-warn">
          Changes requested{request.operator_note ? `: ${request.operator_note}` : '.'}{' '}
          <Link to={`/testing/requests/${request.id}/edit`}>Edit and resubmit</Link>.
        </div>
      )}
      {request.status === 'declined' && (
        <div className="banner banner-error">This request was declined{request.operator_note ? `: ${request.operator_note}` : '.'}</div>
      )}
      {request.status === 'draft' && (
        <div className="banner banner-warn">
          Draft — not submitted yet. <Link to={`/testing/requests/${request.id}/edit`}>Continue editing</Link>.
        </div>
      )}
      {orderId && (
        <div className="banner banner-ok">This request has an order: <Link to={`/testing/orders/${orderId}`}>{orderId}</Link></div>
      )}

      <section className="panel">
        <h2>Your request (v{request.version})</h2>
        <div className="kv"><span className="kv-key">Workflow</span><span className="prewrap">{request.intake.workflow_objective}</span></div>
        <div className="kv"><span className="kv-key">Expected result</span><span className="prewrap">{request.intake.expected_result}</span></div>
        <div className="kv"><span className="kv-key">Target</span><span>{request.intake.target_environment}</span></div>
        <div className="kv"><span className="kv-key">Auth mode</span><span>{request.intake.auth_mode === 'none' ? 'None (public)' : 'Worker-owned test account'}</span></div>
      </section>

      {quote && (
        <section className="panel">
          <h2>{quoteLive ? 'Approved scope — review before paying' : `Quote (${quote.status})`}</h2>
          <div className="kv"><span className="kv-key">Price</span><span><strong>{money(quote.subtotal_cents, quote.currency)}</strong> one-time{quote.subtotal_cents === 20000 ? '' : ''} (tax handled at checkout where applicable)</span></div>
          <div className="kv"><span className="kv-key">Included</span>
            <span>{quote.external_run_slots} external runs across ≥{quote.min_operator_groups} independent operator groups, one internal baseline,
              one consolidated report, {quote.retest_slots} targeted retest within {quote.retest_window_days} days of the report.</span></div>
          <div className="kv"><span className="kv-key">Delivery target</span><span>{new Date(quote.delivery_target_at).toLocaleString()} — {quote.delivery_target_note}</span></div>
          <div className="kv"><span className="kv-key">Quote valid until</span><span>{new Date(quote.expires_at).toLocaleString()}</span></div>
          <div className="kv"><span className="kv-key">Frozen workflow</span><span className="prewrap">{quote.scope.workflow_objective}</span></div>
          <div className="kv"><span className="kv-key">Expected output</span><span className="prewrap">{quote.scope.expected_result}</span></div>
          <div className="kv"><span className="kv-key">Allowed target origins</span><span>{quote.scope.allowed_origins.join(', ')}</span></div>
          <div className="kv"><span className="kv-key">Environments</span>
            <span>{quote.scope.environment_slots.map((e) => `${e.client} / ${e.transport}`).join(' · ')}</span></div>
          <div className="kv"><span className="kv-key">Permitted actions</span>
            <span>{quote.scope.read_only ? 'Read-only' : `Approved sandbox writes: ${quote.scope.sandbox_write_steps.join('; ')}`} ·
              ≤{quote.scope.max_requests} requests · ≤{Math.round(quote.scope.max_execution_seconds / 60)} min per run · no external spend</span></div>
          <div className="kv"><span className="kv-key">Scope hash</span><span className="code-block-select">{quote.scope_hash}</span></div>
          <div className="panel-note">
            <strong>Disclosures ({quote.disclosure_version}, terms {quote.terms_version}):</strong> approved independent operators receive
            the frozen test materials above to execute assignments. You buy observed execution and a
            reviewed private report — not a favorable verdict or certification. A reproducible product
            failure is a valid, reported result. Cancellation before work is published is refundable;
            after that, refunds are reviewed case by case. Your report stays private to this account.
          </div>

          {quoteLive && !orderId && (
            <>
              <div className="btn-row">
                <button className="btn btn-primary" disabled={busy} onClick={() => void pay()}>
                  {busy ? 'Starting secure checkout…' : `Approve scope and pay ${money(quote.subtotal_cents, quote.currency)}`}
                </button>
              </div>
              <div className="change-request">
                <div className="field">
                  <label className="field-label" htmlFor="chg">Not quite right? Request a change instead</label>
                  <textarea id="chg" rows={3} maxLength={2000} value={changeNote} onChange={(e) => setChangeNote(e.target.value)}
                    placeholder="Tell us what should be different about the scope…" />
                  <p className="field-hint">
                    Sends the scope back to review — this quote is withdrawn, nothing is charged, and we
                    follow up with a revised one.
                  </p>
                </div>
                <div className="btn-row">
                  <button className="btn" disabled={busy || !changeNote.trim()} onClick={() => void requestChange()}>Request a change</button>
                </div>
              </div>
            </>
          )}
          {!quoteLive && quote.status === 'approved' && (
            <div className="banner banner-warn">This quote expired. Request a change to receive an updated scope.</div>
          )}
        </section>
      )}
    </div>
  );
}
