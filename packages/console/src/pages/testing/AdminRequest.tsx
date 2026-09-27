/**
 * /testing/admin/requests/:id — operator intake review: the §9.1 checklist,
 * scope construction, and quote approval under a fresh passkey ceremony
 * whose signed params name the exact request version, scope hash, price,
 * worker cap and delivery target.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { testingAdmin, type TestingRequest } from '../../api/testing.js';
import { useOwner } from '../../state/session.js';
import { runAction } from '../../lib/ceremony.js';
import { canonicalJsonStringify, sha256hex } from '../../lib/action.js';

interface EnvSlot { client: string; transport: string; native_execution_required: boolean; notes: string }

interface PackageInfo { price_cents: number; currency: string; worker_cap_usdc_atomic: string; worker_bounty_usdc_atomic: string; external_run_slots: number; quote_validity_days: number; min_operator_groups: number }

export default function TestingAdminRequest() {
  const { requestId } = useParams();
  const { owner } = useOwner();
  const navigate = useNavigate();
  const [request, setRequest] = useState<(TestingRequest & { owner_id?: string; source?: string }) | null>(null);
  const [pkg, setPkg] = useState<PackageInfo | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checklist, setChecklist] = useState(false);

  // Scope under construction.
  const [origins, setOrigins] = useState('');
  const [slots, setSlots] = useState<EnvSlot[]>([]);
  const [maxRequests, setMaxRequests] = useState(100);
  const [maxSeconds, setMaxSeconds] = useState(1200);
  const [deliveryTarget, setDeliveryTarget] = useState('');

  useEffect(() => {
    if (!requestId) return;
    Promise.all([testingAdmin.getRequest(requestId), testingAdmin.queue()])
      .then(([res, queue]) => {
        setRequest(res.request);
        setPkg((queue as unknown as { package: PackageInfo }).package);
        const intake = res.request.intake;
        try { setOrigins(new URL(intake.product_url).origin); } catch { setOrigins(''); }
        const prefs = intake.coverage_preferences.map((p) => {
          const [client, transport] = p.split('/');
          return { client: (client ?? '').trim(), transport: (transport ?? 'http').trim(), native_execution_required: true, notes: '' };
        }).filter((s) => s.client);
        setSlots(prefs.length >= 3 ? prefs.slice(0, 3) : [
          ...prefs,
          ...Array.from({ length: 3 - prefs.length }, () => ({ client: '', transport: 'http', native_execution_required: true, notes: '' })),
        ]);
        setDeliveryTarget(new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 16));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [requestId]);

  const scope = useMemo(() => {
    if (!request) return null;
    const intake = request.intake;
    return {
      schema_version: '1.0' as const,
      workflow_objective: intake.workflow_objective,
      expected_result: intake.expected_result,
      allowed_origins: origins.split(',').map((s) => s.trim()).filter(Boolean),
      documentation_url: intake.documentation_url,
      release_identifier: intake.release_identifier,
      auth_mode: intake.auth_mode,
      read_only: intake.allowed_operations.read_only,
      sandbox_write_steps: intake.allowed_operations.sandbox_write_steps,
      fixture: intake.fixture,
      environment_slots: slots.filter((s) => s.client.trim()),
      max_requests: maxRequests,
      max_execution_seconds: maxSeconds,
      constraints_note: intake.known_constraints,
    };
  }, [request, origins, slots, maxRequests, maxSeconds]);

  async function decide(kind: 'needs-changes' | 'decline'): Promise<void> {
    if (!request || !note.trim()) { setError('A note to the customer is required.'); return; }
    setBusy(true);
    try {
      if (kind === 'needs-changes') await testingAdmin.needsChanges(request.id, note.trim());
      else await testingAdmin.decline(request.id, note.trim());
      navigate('/testing/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  // Why the approve button is not available yet — always visible next to the
  // button, so a blocked approval is never a click that silently does nothing.
  const approveBlockers = useMemo(() => {
    const out: string[] = [];
    if (request && request.status !== 'submitted') out.push(`the request is ${request.status}, and only a submitted request can be quoted`);
    if (!scope || scope.environment_slots.length < 1) out.push('at least one environment slot needs a client + transport (e.g. claude-code / mcp)');
    if (!checklist) out.push('the scope checklist above is not confirmed');
    return out;
  }, [request, scope, checklist]);

  async function tag(source: 'founder_sample' | 'test_fixture'): Promise<void> {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      await testingAdmin.setSource(request.id, source);
      setRequest({ ...request, source });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function approve(): Promise<void> {
    if (!request || !scope || !pkg || !owner) return;
    setBusy(true);
    setError(null);
    try {
      const deliveryIso = new Date(deliveryTarget).toISOString();
      const scopeHash = sha256hex(canonicalJsonStringify(scope));
      const ceremony = await runAction(owner.owner_id, 'testing.approve_quote', {
        request_id: request.id,
        request_version: request.version,
        scope_hash: scopeHash,
        subtotal_cents: pkg.price_cents,
        worker_cap_usdc_atomic: pkg.worker_cap_usdc_atomic,
        delivery_target_at: deliveryIso,
      });
      await testingAdmin.approveQuote(request.id, {
        request_version: request.version,
        scope,
        delivery_target_at: deliveryIso,
        checklist_confirmed: true,
        ...ceremony,
      });
      navigate('/testing/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (error && !request) return <div className="page"><div className="banner banner-error">{error}</div></div>;
  if (!request || !pkg) return <div className="page"><p className="muted">Loading…</p></div>;
  const intake = request.intake;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Intake review — {intake.product_name}</h1>
        <Link className="btn btn-ghost" to="/testing/admin">Queue</Link>
      </div>
      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {request.status !== 'submitted' && <div className="banner banner-warn">This request is {request.status}; only a submitted request can be quoted.</div>}
      {intake.product_category === 'other' && <div className="banner banner-warn">Category “other” — not eligible for the standard package; send back for changes or handle out of band.</div>}

      <section className="panel">
        <h2>Customer intake (v{request.version})</h2>
        <div className="kv"><span className="kv-key">Category</span><span>{intake.product_category}</span></div>
        <div className="kv"><span className="kv-key">Product</span><span><a href={intake.product_url} target="_blank" rel="noreferrer">{intake.product_url}</a></span></div>
        <div className="kv"><span className="kv-key">Docs</span><span><a href={intake.documentation_url} target="_blank" rel="noreferrer">{intake.documentation_url}</a></span></div>
        <div className="kv"><span className="kv-key">Workflow</span><span className="prewrap">{intake.workflow_objective}</span></div>
        <div className="kv"><span className="kv-key">Oracle</span><span className="prewrap">{intake.expected_result}</span></div>
        <div className="kv"><span className="kv-key">Fixture</span><span className="prewrap">{intake.fixture.inline || intake.fixture.url || '—'}</span></div>
        <div className="kv"><span className="kv-key">Target</span><span>{intake.target_environment}</span></div>
        <div className="kv"><span className="kv-key">Auth</span><span>{intake.auth_mode}</span></div>
        <div className="kv"><span className="kv-key">Operations</span><span>{intake.allowed_operations.read_only ? 'read-only' : `writes: ${intake.allowed_operations.sandbox_write_steps.join('; ')}`}</span></div>
        <div className="kv"><span className="kv-key">Constraints</span><span className="prewrap">{intake.known_constraints || '—'}</span></div>
        <div className="kv"><span className="kv-key">Suspected failure</span><span className="prewrap">{intake.suspected_failure || '—'} <em>(hypothesis, not a finding)</em></span></div>
      </section>

      <section className="panel">
        <h2>Scope for the quote</h2>
        <div className="field">
          <label className="field-label" htmlFor="aq-origins">Allowed target origins (comma-separated https origins)</label>
          <input id="aq-origins" value={origins} onChange={(e) => setOrigins(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">Environment slots ({pkg.external_run_slots} runs, ≥{pkg.min_operator_groups} operator groups)</span>
          {slots.map((s, i) => (
            <div className="form-inline" key={i}>
              <input aria-label={`Slot ${i + 1} client`} placeholder="client (e.g. claude-code)" value={s.client}
                onChange={(e) => setSlots(slots.map((x, j) => j === i ? { ...x, client: e.target.value } : x))} />
              <input aria-label={`Slot ${i + 1} transport`} placeholder="transport (e.g. mcp)" value={s.transport}
                onChange={(e) => setSlots(slots.map((x, j) => j === i ? { ...x, transport: e.target.value } : x))} />
              <label><input type="checkbox" checked={s.native_execution_required}
                onChange={(e) => setSlots(slots.map((x, j) => j === i ? { ...x, native_execution_required: e.target.checked } : x))} /> native</label>
            </div>
          ))}
        </div>
        <div className="form-inline">
          <label className="field-label" htmlFor="aq-req">Max requests</label>
          <input id="aq-req" type="number" min={1} max={1000} value={maxRequests} onChange={(e) => setMaxRequests(parseInt(e.target.value, 10) || 100)} />
          <label className="field-label" htmlFor="aq-sec">Max seconds</label>
          <input id="aq-sec" type="number" min={60} max={7200} value={maxSeconds} onChange={(e) => setMaxSeconds(parseInt(e.target.value, 10) || 1200)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="aq-target">Delivery target (specific, shown to the buyer before payment; never “guaranteed”)</label>
          <input id="aq-target" type="datetime-local" value={deliveryTarget} onChange={(e) => setDeliveryTarget(e.target.value)} />
        </div>
        <div className="panel-note">
          Package: {(pkg.price_cents / 100).toFixed(2)} {pkg.currency.toUpperCase()} one-time · worker bounty {Number(pkg.worker_bounty_usdc_atomic) / 1e6} USDC/run ·
          commitment ceiling {Number(pkg.worker_cap_usdc_atomic) / 1e6} USDC (a ceiling, not a target) · quote valid {pkg.quote_validity_days} days.
        </div>
        <div className="field">
          <label className="field-label">
            <input type="checkbox" checked={checklist} onChange={(e) => setChecklist(e.target.checked)} />{' '}
            Scope checklist confirmed: customer authority over the target; safe non-sensitive fixture with an objective
            oracle; reachable public/test target; supported auth mode with no customer secrets; three meaningfully
            distinct environments across ≥{pkg.min_operator_groups} reviewed operator groups (or the customer explicitly accepted a
            different versioned package); feasible window; no prohibited spend/destructive/spam/account activity; a
            plausible internal baseline.
          </label>
        </div>
        {approveBlockers.length > 0 && (
          <div className="banner banner-warn" role="status">
            <strong>Before you can approve:</strong> {approveBlockers.join('; ')}.
          </div>
        )}
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy || approveBlockers.length > 0}
            onClick={() => void approve()}>
            {busy ? 'Waiting for passkey…' : 'Approve quote (passkey)'}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Or send back / decline</h2>
        <div className="field">
          <label className="field-label" htmlFor="aq-note">Note to the customer</label>
          <textarea id="aq-note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="btn-row">
          <button className="btn" disabled={busy} onClick={() => void decide('needs-changes')}>Request changes</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void decide('decline')}>Decline</button>
        </div>
        <div className="form-row">
          <span className="field-label">Demand accounting — currently: {request.source ?? 'external_customer'}</span>
          <div className="btn-row">
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void tag('founder_sample')}>Tag founder sample</button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void tag('test_fixture')}>Tag test fixture</button>
          </div>
        </div>
      </section>
    </div>
  );
}
