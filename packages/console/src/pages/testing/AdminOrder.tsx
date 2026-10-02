/**
 * /testing/admin/orders/:id — the operator's order work surface: plan +
 * bounded publication, run/evidence review with the marketplace consequence
 * preview, replacements, report draft/publish, pause/resume/cancel, refunds,
 * reconciliation. Every money- or publication-shaped action runs the fresh
 * passkey ceremony over the exact ids/amounts.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { testingAdmin, type AdminOrderView, type AdminRun, type TestingReportDoc } from '../../api/testing.js';
import { useOwner } from '../../state/session.js';
import { runAction } from '../../lib/ceremony.js';
import { sha256hex } from '../../lib/action.js';

function usdc(atomic: string | number | null): string {
  if (atomic == null) return '—';
  return `${(Number(atomic) / 1e6).toFixed(2)} USDC`;
}

interface ReviewForm {
  evidence: 'valid' | 'needs_revision' | 'invalid';
  outcome: 'product_success' | 'product_failure' | 'inconclusive' | '';
  environment_demonstrated: 'yes' | 'no' | 'unknown';
  slot_satisfied: boolean;
  operator_group_id: string;
  marketplace_action: 'accept' | 'revision' | 'dispute' | 'cancel' | 'none';
  note: string;
}

const EMPTY_REVIEW: ReviewForm = {
  evidence: 'valid', outcome: '', environment_demonstrated: 'yes', slot_satisfied: true,
  operator_group_id: '', marketplace_action: 'accept', note: '',
};

export default function TestingAdminOrder() {
  const { orderId } = useParams();
  const { owner } = useOwner();
  const [view, setView] = useState<AdminOrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<Record<string, ReviewForm>>({});
  const [refund, setRefund] = useState({ amount: '', reason: '' });
  const [cancelReason, setCancelReason] = useState('');
  const [replaceReason, setReplaceReason] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<{ id: string; source_hash?: string; version: number } | null>(null);
  const [draftDoc, setDraftDoc] = useState<TestingReportDoc | null>(null);

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      const v = await testingAdmin.getOrder(orderId);
      setView(v);
      const d = v.reports.find((r) => r.status === 'draft');
      setDraft(d ? { id: d.id, version: d.version } : null);
      if (!d) setDraftDoc(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  // A draft exists but its content is not on screen → fetch it, so the
  // operator always READS what the publish signature will cover. The draft
  // endpoint regenerates deterministically from reviewed records, so this
  // also keeps the preview honest after new reviews.
  useEffect(() => {
    if (!orderId || !draft || draftDoc) return;
    testingAdmin.reportDraft(orderId).then((r) => {
      setDraft({ id: r.report.id, source_hash: r.report.source_hash, version: r.report.version });
      setDraftDoc(r.report.document);
    }).catch(() => { /* the Generate button remains the explicit path */ });
  }, [orderId, draft, draftDoc]);

  async function act(fn: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      // Stay busy until the refreshed view is IN — a button must never
      // re-arm against a stale view right after its action succeeded.
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !view) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!view || !owner) return <div className="page"><p className="muted">Loading…</p></div>;
  const { order, quote, runs } = view;

  // A run whose publish operation is queued/running is spoken for — showing
  // its checkbox re-armed right after the ceremony reads as "did nothing
  // happen?" (field report). Semantic keys are `publish:<runId>:a<attempt>`.
  // Only LIVE operations park a run ("queued"); a manual_review publication
  // must re-arm its checkbox — re-approving is exactly how the operator
  // retries it after fixing the cause (enqueue revives the operation).
  const queuedPublishRunIds = new Set(
    view.operations
      .filter((o) => o.kind === 'publish_task' && ['pending', 'processing'].includes(o.state))
      .map((o) => o.semantic_key.split(':')[1])
      .filter(Boolean),
  );
  const publishable = runs.filter((r) => r.kind !== 'baseline' && !r.attempts.some((a) => a.active) && !queuedPublishRunIds.has(r.id));
  const totalSelected = selectedRuns.size;

  async function publishSelected(): Promise<void> {
    if (!quote || totalSelected === 0) return;
    const runIds = [...selectedRuns].sort();
    const total = String(BigInt(quote.worker_bounty_usdc_atomic) * BigInt(runIds.length));
    await act(async () => {
      const ceremony = await runAction(owner!.owner_id, 'testing.publish_tasks', {
        order_id: order.id,
        run_ids: runIds,
        scope_hash: quote.scope_hash,
        bounty_usdc_atomic: quote.worker_bounty_usdc_atomic,
        total_commitment_usdc_atomic: total,
        worker_cap_usdc_atomic: quote.worker_cap_usdc_atomic,
      });
      await testingAdmin.publishTasks(order.id, runIds, ceremony);
      setSelectedRuns(new Set());
    }, 'Publication approved — durable operations will create and fund the tasks (see Operations below).');
  }

  async function submitReview(run: AdminRun): Promise<void> {
    const f = review[run.id] ?? EMPTY_REVIEW;
    if (!f.note.trim()) { setError('A review note is required.'); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (f.evidence === 'valid' && !f.outcome) { setError('A valid-evidence review must state the product outcome.'); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    await act(async () => {
      const ceremony = await runAction(owner!.owner_id, 'testing.review_run', {
        run_id: run.id,
        run_version: run.version,
        evidence: f.evidence,
        outcome: f.evidence === 'valid' ? f.outcome : null,
        marketplace_action: f.marketplace_action,
        note_hash: sha256hex(f.note),
      });
      await testingAdmin.reviewRun(run.id, {
        expected_version: run.version,
        evidence: f.evidence,
        outcome: f.evidence === 'valid' ? (f.outcome as 'product_success') : null,
        environment_demonstrated: f.environment_demonstrated === 'unknown' ? null : f.environment_demonstrated === 'yes',
        slot_satisfied: f.slot_satisfied,
        operator_group_id: f.operator_group_id || null,
        marketplace_action: f.marketplace_action,
        note: f.note,
        ...ceremony,
      });
    }, 'Review recorded and the marketplace action executed through the normal gates.');
  }

  const financialPreview = (f: ReviewForm): string => {
    if (f.marketplace_action === 'accept') return `Accept releases the ${usdc(quote?.worker_bounty_usdc_atomic ?? null)} escrow deposit to the worker — including for a valid product FAILURE.`;
    if (f.marketplace_action === 'revision') return 'Revision returns the task to the worker; no payout yet.';
    if (f.marketplace_action === 'dispute') return 'Dispute freezes auto-accept; resolve explicitly afterwards.';
    if (f.marketplace_action === 'cancel') return 'Cancel refunds the escrow deposit to the treasury once confirmed (only valid states can cancel).';
    return 'No marketplace consequence.';
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Order {order.id}</h1>
        <Link className="btn btn-ghost" to="/testing/admin">Queue</Link>
      </div>
      {notice && <div className="banner banner-ok" role="status">{notice}</div>}
      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {order.risk_hold === 1 && <div className="banner banner-warn">RISK HOLD — new publication is blocked; earned obligations stand.</div>}
      {order.cancel_requested_at && (
        <div className="banner banner-warn">Customer requested cancellation {new Date(order.cancel_requested_at).toLocaleString()}: {order.cancel_request_reason ?? 'no reason given'}</div>
      )}

      <section className="panel">
        <h2>State</h2>
        <div className="kv"><span className="kv-key">Billing</span><span>payment {order.payment_state} · refund {order.refund_state} · dispute {order.dispute_state}</span></div>
        <div className="kv"><span className="kv-key">Fulfillment</span><span>{order.fulfillment_state}</span></div>
        <div className="kv"><span className="kv-key">Collected</span><span>${(order.collected_cents / 100).toFixed(2)} ({order.refunded_cents ? `$${(order.refunded_cents / 100).toFixed(2)} refunded` : 'no refunds'})</span></div>
        {quote && <div className="kv"><span className="kv-key">Worker budget</span>
          <span>cap {usdc(quote.worker_cap_usdc_atomic)} · remaining authorization {usdc(view.remaining_budget_atomic)} · bounty {usdc(quote.worker_bounty_usdc_atomic)}/run</span></div>}
        {quote && <div className="kv"><span className="kv-key">Delivery target</span><span>{new Date(quote.delivery_target_at).toLocaleString()}</span></div>}
        <div className="btn-row">
          <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => testingAdmin.plan(order.id), 'Plan ensured.')}>Ensure plan</button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => testingAdmin.reconcile(order.id), 'Checkout attempts reconciled.')}>Reconcile payments</button>
          {order.fulfillment_state === 'paused' ? (
            <button className="btn btn-sm" disabled={busy}
              onClick={() => void act(async () => testingAdmin.resume(order.id, await runAction(owner.owner_id, 'testing.resume_order', { order_id: order.id })), 'Resumed.')}>
              Resume (passkey)
            </button>
          ) : (
            <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => testingAdmin.pause(order.id), 'Paused.')}>Pause</button>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Runs</h2>
        {queuedPublishRunIds.size > 0 && (
          <div className="banner banner-ok" role="status">
            {queuedPublishRunIds.size === 1 ? 'One publication is' : `${queuedPublishRunIds.size} publications are`} queued —
            the job runner (within ~5 minutes) creates and escrow-funds the task; it then appears on the
            run card below with its task id. Re-approving cannot double-publish.
          </div>
        )}
        {publishable.length > 0 && quote && order.payment_state === 'succeeded' && (
          <div className="panel-note">
            <strong>Publish assignments</strong> — select runs, then approve with your passkey. Commitment for this batch:{' '}
            {usdc(String(BigInt(quote.worker_bounty_usdc_atomic) * BigInt(totalSelected)))} of {usdc(view.remaining_budget_atomic)} remaining.
            <div className="btn-row">
              {publishable.map((r) => (
                <label key={r.id} className="chip">
                  <input type="checkbox" checked={selectedRuns.has(r.id)}
                    onChange={(e) => {
                      const next = new Set(selectedRuns);
                      if (e.target.checked) next.add(r.id); else next.delete(r.id);
                      setSelectedRuns(next);
                    }} /> {r.kind} slot {r.slot} ({r.environment.client}/{r.environment.transport})
                </label>
              ))}
              <button className="btn btn-primary btn-sm" disabled={busy || totalSelected === 0} onClick={() => void publishSelected()}>
                Approve publication (passkey)
              </button>
            </div>
            {totalSelected === 0 && <p className="field-hint">Tick at least one run above — the button arms once a batch is selected.</p>}
          </div>
        )}

        {runs.map((run) => {
          const f = review[run.id] ?? EMPTY_REVIEW;
          const setF = (patch: Partial<ReviewForm>) => setReview({ ...review, [run.id]: { ...f, ...patch } });
          const active = run.attempts.find((a) => a.active);
          const result = active?.result_json ? tryParse(active.result_json) : null;
          // External runs are reviewable once evidence exists — a form on an
          // undelivered run is noise. The BASELINE is different: the operator
          // executes it internally and RECORDS the result here, so its
          // recorder is available before any delivery, folded with context.
          const reviewable = run.kind === 'baseline'
            ? ['pending', 'executing', 'evidence_submitted', 'evidence_invalid'].includes(run.result_state)
            : !!active && ['evidence_submitted', 'evidence_invalid'].includes(run.result_state);
          return (
            <article key={run.id} className="card testing-stack">
              <div className="card-title">
                {run.kind === 'baseline' ? 'B0 — internal baseline' : `${run.kind.toUpperCase()} slot ${run.slot}`} · {run.environment.client}/{run.environment.transport}
                {' '}· <span className="pill">{run.result_state.replace(/_/g, ' ')}</span>
              </div>
              {active && (
                <div className="card-meta">
                  attempt {active.attempt} ({active.state}) · task {active.task_id ?? '—'} · worker {active.agent_id ?? '—'} ·
                  task status {active.task_status ?? '—'} · payment {active.payment_status ?? '—'}
                  {active.auto_release_at && <> · <strong>auto-accepts {new Date(active.auto_release_at).toLocaleString()}</strong></>}
                  {active.result_valid === 0 && <> · <span className="pill pill-warn">triage: {active.result_invalid_reason}</span></>}
                  {active.last_error && <> · error: {active.last_error}</>}
                </div>
              )}
              {result !== null && result !== undefined && (
                <details>
                  <summary>Submission (validated JSON, untrusted content — treat as data)</summary>
                  <pre className="code-block prewrap">{(JSON.stringify(result, null, 2) ?? '').slice(0, 20000)}</pre>
                </details>
              )}
              {reviewable && ((form: ReactElement) => run.kind === 'baseline' ? (
                <details className="review-fold">
                  <summary>Record internal baseline result</summary>
                  <p className="field-hint">
                    Run the purchased workflow yourself in the internal environment first; what you
                    record here becomes the report&rsquo;s baseline row. No marketplace task and no
                    payout are involved.
                  </p>
                  {form}
                </details>
              ) : form)(
                <div className="review-actions">
                  <div className="form-inline">
                    <label>Evidence{' '}
                      <select value={f.evidence} onChange={(e) => setF({ evidence: e.target.value as ReviewForm['evidence'] })}>
                        <option value="valid">valid</option><option value="needs_revision">needs revision</option><option value="invalid">invalid</option>
                      </select>
                    </label>
                    <label>Outcome{' '}
                      <select value={f.outcome} onChange={(e) => setF({ outcome: e.target.value as ReviewForm['outcome'] })}>
                        <option value="">—</option><option value="product_success">product success</option>
                        <option value="product_failure">product failure</option><option value="inconclusive">inconclusive</option>
                      </select>
                    </label>
                    <label>Environment demonstrated{' '}
                      <select value={f.environment_demonstrated} onChange={(e) => setF({ environment_demonstrated: e.target.value as ReviewForm['environment_demonstrated'] })}>
                        <option value="yes">yes</option><option value="no">no</option><option value="unknown">unknown</option>
                      </select>
                    </label>
                    <label><input type="checkbox" checked={f.slot_satisfied} onChange={(e) => setF({ slot_satisfied: e.target.checked })} /> satisfies the purchased slot</label>
                  </div>
                  {run.kind !== 'baseline' && (
                    <div className="form-inline">
                      <label>Operator group <input value={f.operator_group_id} placeholder="grp-…" onChange={(e) => setF({ operator_group_id: e.target.value })} /></label>
                      <label>Marketplace action{' '}
                        <select value={f.marketplace_action} onChange={(e) => setF({ marketplace_action: e.target.value as ReviewForm['marketplace_action'] })}>
                          <option value="accept">accept</option><option value="revision">request revision</option>
                          <option value="dispute">dispute</option><option value="cancel">cancel</option><option value="none">none</option>
                        </select>
                      </label>
                    </div>
                  )}
                  {run.kind !== 'baseline' && (
                    <div className={`review-consequence review-consequence-${f.marketplace_action}`} role="note">
                      <strong>Money consequence</strong> — {financialPreview(f)}
                    </div>
                  )}
                  <div className="field">
                    <label className="field-label" htmlFor={`note-${run.id}`}>Review note — required, recorded in the audit trail</label>
                    <textarea id={`note-${run.id}`} rows={2} maxLength={4000}
                      value={f.note} onChange={(e) => setF({ note: e.target.value })} />
                  </div>
                  <div className="btn-row">
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submitReview(run)}>Record review (passkey)</button>
                  </div>
                </div>,
              )}
              {run.kind !== 'baseline' && !active && run.attempts.length > 0 && !['product_success', 'product_failure'].includes(run.result_state) && (
                <div className="form-inline">
                  <input aria-label={`Replacement reason for ${run.id}`} placeholder="Replacement reason (documented invalid/unavailable attempt)"
                    value={replaceReason[run.id] ?? ''} onChange={(e) => setReplaceReason({ ...replaceReason, [run.id]: e.target.value })} />
                  <button className="btn btn-sm" disabled={busy || !(replaceReason[run.id] ?? '').trim()}
                    onClick={() => void act(async () => {
                      const reason = replaceReason[run.id].trim();
                      const ceremony = await runAction(owner.owner_id, 'testing.replace_attempt', {
                        run_id: run.id, order_id: order.id,
                        bounty_usdc_atomic: quote?.worker_bounty_usdc_atomic ?? '0',
                        reason_hash: sha256hex(reason),
                      });
                      await testingAdmin.replaceAttempt(run.id, reason, ceremony);
                    }, 'Replacement approved within the remaining cap.')}>
                    Replace attempt (passkey)
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </section>

      <section className="panel">
        <h2>Report</h2>
        <div className="btn-row">
          <button className="btn" disabled={busy} onClick={() => void act(async () => {
            const res = await testingAdmin.reportDraft(order.id);
            setDraft({ id: res.report.id, source_hash: res.report.source_hash, version: res.report.version });
            setDraftDoc(res.report.document);
          }, 'Draft generated from reviewed records.')}>
            Generate / refresh draft
          </button>
          {draft && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void act(async () => {
              // Re-read the draft row for the exact source hash the signature covers.
              const fresh = await testingAdmin.reportDraft(order.id);
              const sourceHash = fresh.report.source_hash!;
              const ceremony = await runAction(owner.owner_id, 'testing.publish_report', {
                report_id: fresh.report.id, order_id: order.id, report_version: fresh.report.version, source_hash: sourceHash,
              });
              await testingAdmin.publishReport(fresh.report.id, sourceHash, ceremony);
            }, 'Report published — the customer has been queued a notification.')}>
              Publish report v{draft.version} (passkey)
            </button>
          )}
        </div>
        {draftDoc && (
          <article className="card testing-stack">
            <div className="card-title">Draft v{draftDoc.version} — read before publishing (the passkey signs exactly this)</div>
            <p className="prewrap">{draftDoc.executive_summary}</p>
            <div className="kv"><span className="kv-key">Coverage</span>
              <span>{draftDoc.coverage.external_runs_valid}/{draftDoc.coverage.external_runs_planned} valid external runs ·{' '}
                {draftDoc.coverage.distinct_environments} distinct environment{draftDoc.coverage.distinct_environments === 1 ? '' : 's'} ·{' '}
                {draftDoc.coverage.reviewed_operator_groups} reviewed operator group{draftDoc.coverage.reviewed_operator_groups === 1 ? '' : 's'}
                {draftDoc.coverage.unknowns.length > 0 && <> · unknowns: {draftDoc.coverage.unknowns.join('; ')}</>}
              </span></div>
            <div className="kv"><span className="kv-key">Baseline</span>
              <span>{draftDoc.baseline.ran ? draftDoc.baseline.result.replace(/_/g, ' ') : 'not run'}{draftDoc.baseline.note ? ` — ${draftDoc.baseline.note}` : ''}</span></div>
            <div className="kv"><span className="kv-key">Execution</span>
              <span>{draftDoc.execution_matrix.map((r) => `${r.kind}${r.kind === 'baseline' ? '' : ` slot ${r.slot}`}: ${r.result.replace(/_/g, ' ')}`).join(' · ')}</span></div>
            <div>
              <span className="field-label">Findings ({draftDoc.findings.length})</span>
              {draftDoc.findings.length === 0 ? <p className="muted">None recorded.</p> : (
                <ul className="draft-findings">
                  {draftDoc.findings.map((f) => (
                    <li key={f.finding_id}>
                      <strong>{f.finding_id}</strong> · {f.severity} · {f.category} · {f.statement_type}: {f.summary}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {draftDoc.limitations.length > 0 && (
              <div>
                <span className="field-label">Limitations</span>
                <ul className="draft-findings">{draftDoc.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
              </div>
            )}
            <details>
              <summary>Full draft JSON (byte-exact content the publish signature covers)</summary>
              <pre className="code-block prewrap">{JSON.stringify(draftDoc, null, 2).slice(0, 40000)}</pre>
            </details>
          </article>
        )}
        <div className="rows">
          {view.reports.map((r) => (
            <div key={r.id} className="row">
              <span className="row-label">v{r.version} · {r.status}</span>
              <span className="row-date">{r.published_at ? new Date(r.published_at).toLocaleString() : ''}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Money</h2>
        <div className="rows">
          {view.reservations.map((r) => (
            <div key={r.id} className="row">
              <span className="row-label">{r.purpose.replace(/_/g, ' ')}</span>
              <span>{usdc(r.amount_atomic)}</span>
              <span className={`status status-${r.state === 'settled' ? 'verified' : 'open'}`}>{r.state.replace(/_/g, ' ')}</span>
            </div>
          ))}
        </div>
        <div className="form-row">
          <span className="field-label">Refund (explicit amount + reason; runs as a durable operation)</span>
          <div className="form-inline">
            <input aria-label="Refund amount in cents" type="number" min={1} placeholder="amount (cents)" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
            <input aria-label="Refund reason" placeholder="reason" value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} />
            <button className="btn btn-danger btn-sm" disabled={busy || !refund.amount || !refund.reason.trim()}
              onClick={() => void act(async () => {
                const cents = parseInt(refund.amount, 10);
                const ceremony = await runAction(owner.owner_id, 'testing.refund_order', {
                  order_id: order.id, amount_cents: cents, reason_hash: sha256hex(refund.reason.trim()),
                });
                await testingAdmin.refund(order.id, cents, refund.reason.trim(), ceremony);
                setRefund({ amount: '', reason: '' });
              }, 'Refund requested — pending until the provider confirms via webhook.')}>
              Refund (passkey)
            </button>
          </div>
        </div>
        <div className="form-row">
          <span className="field-label">Cancel order (unclaimed tasks via normal lifecycle; claimed work resolves through run review first)</span>
          <div className="form-inline">
            <input aria-label="Cancellation reason" placeholder="reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            <button className="btn btn-danger btn-sm" disabled={busy || !cancelReason.trim()}
              onClick={() => void act(async () => {
                const ceremony = await runAction(owner.owner_id, 'testing.cancel_order', {
                  order_id: order.id, reason_hash: sha256hex(cancelReason.trim()),
                });
                await testingAdmin.cancel(order.id, cancelReason.trim(), ceremony);
              }, 'Order cancelled; check unresolved tasks in the runs list.')}>
              Cancel order (passkey)
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Operations</h2>
        <div className="rows">
          {view.operations.map((op) => (
            <div key={op.id} className="row">
              <span className="row-label">{op.kind}</span>
              <span className={`status status-${op.state === 'succeeded' ? 'verified' : op.state === 'manual_review' ? 'denied' : 'open'}`}>{op.state}</span>
              <span className="row-muted">{op.attempts} attempt{op.attempts === 1 ? '' : 's'}{op.last_error ? ` · ${op.last_error}` : ''}</span>
            </div>
          ))}
        </div>
        <h2>Checkout attempts</h2>
        <div className="rows">
          {view.checkout_attempts.map((a) => (
            <div key={a.id} className="row">
              <span className="row-label">#{a.attempt} {a.stripe_session_id ?? '(no session)'}</span>
              <span className={`status status-${a.state === 'completed' ? 'verified' : a.state === 'needs_reconciliation' ? 'denied' : 'open'}`}>{a.state.replace(/_/g, ' ')}</span>
              <span className="row-muted">{a.last_error ?? ''}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
