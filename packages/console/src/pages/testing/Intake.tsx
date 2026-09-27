/**
 * /testing/new (+ /testing/requests/:id/edit) — the audit intake form
 * (spec §4.3). Drafts are saved SERVER-SIDE only: nothing here touches
 * localStorage, and the form never asks for credentials.
 *
 * /testing/request is the same form WITHOUT an account: every request is
 * operator-reviewed before any payment, so submission needs only an email —
 * the server stores the payload, emails a sign-in link, and the request
 * attaches to the account the moment that address signs in.
 *
 * PROPRIETARY console code — see ../../../LICENSE.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { testing, type TestingIntake } from '../../api/testing.js';
import { ControlApiError } from '../../api/control.js';
import { useOwner } from '../../state/session.js';
import { AuthNav } from '../../components/AuthNav.js';

const EMPTY: TestingIntake = {
  product_name: '',
  product_category: 'api',
  product_url: '',
  documentation_url: '',
  workflow_objective: '',
  expected_result: '',
  fixture: { classification: 'synthetic', inline: '' },
  target_environment: '',
  release_identifier: null,
  auth_mode: 'none',
  allowed_operations: { read_only: true, sandbox_write_steps: [] },
  coverage_preferences: [],
  known_constraints: '',
  authority_declaration: true,
  worker_disclosure_acknowledged: true,
  suspected_failure: '',
};

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export default function TestingIntake() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const { owner, loading: sessionLoading } = useOwner();
  const location = useLocation();
  // The public (no-session) door. Signed-in visitors are bounced to the
  // account form so they keep the app shell, drafts, and their history.
  const onPublicRoute = location.pathname === '/testing/request';
  const publicMode = onPublicRoute && !owner;
  const [publicEmail, setPublicEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState('');
  const [intake, setIntake] = useState<TestingIntake>(EMPTY);
  const [version, setVersion] = useState<number | null>(null);
  const [authority, setAuthority] = useState(false);
  const [disclosure, setDisclosure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!requestId);

  useEffect(() => {
    if (!requestId) return;
    testing.getRequest(requestId).then(({ request }) => {
      setIntake(request.intake);
      setVersion(request.version);
      setAuthority(true);
      setDisclosure(true);
      setLoading(false);
    }).catch((err) => { setError(errText(err)); setLoading(false); });
  }, [requestId]);

  const set = <K extends keyof TestingIntake>(key: K, value: TestingIntake[K]) =>
    setIntake((prev) => ({ ...prev, [key]: value }));

  const problems = useMemo(() => {
    const out: string[] = [];
    if (publicMode && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(publicEmail.trim())) {
      out.push('Enter the email address for sign-in and status updates.');
    }
    if (!intake.product_name.trim()) out.push('Product name is required.');
    if (!/^https:\/\//.test(intake.product_url)) out.push('Product URL must be https://.');
    if (!/^https:\/\//.test(intake.documentation_url)) out.push('Documentation URL must be https://.');
    if (!intake.workflow_objective.trim()) out.push('Describe the one workflow to test.');
    if (!intake.expected_result.trim()) out.push('State what establishes a correct result.');
    if (!intake.target_environment.trim()) out.push('Name the test target and its release/version (or observation date).');
    if (!intake.fixture.inline?.trim() && !intake.fixture.url) out.push('Provide a synthetic fixture (inline data or a public https URL).');
    if (!authority) out.push('Confirm you are authorized to commission these tests.');
    if (!disclosure) out.push('Acknowledge what approved independent operators receive.');
    return out;
  }, [intake, authority, disclosure, publicMode, publicEmail]);

  async function save(submit: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: TestingIntake = {
        ...intake,
        release_identifier: intake.release_identifier?.trim() ? intake.release_identifier.trim() : null,
        authority_declaration: true,
        worker_disclosure_acknowledged: true,
      };
      if (publicMode) {
        const { message } = await testing.publicIntake(publicEmail.trim().toLowerCase(), body);
        setSentTo(publicEmail.trim());
        setSentNote(message);
        setBusy(false);
        window.scrollTo({ top: 0 });
        return;
      }
      let id = requestId ?? null;
      let v = version ?? 1;
      if (id && version !== null) {
        const { request } = await testing.updateRequest(id, version, body);
        v = request.version;
      } else {
        const { request } = await testing.createRequest(body);
        id = request.id;
        v = request.version;
      }
      if (submit) await testing.submitRequest(id!, v);
      navigate(`/testing/requests/${id}`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  if (loading || (onPublicRoute && sessionLoading)) return <div className="page"><p className="muted">Loading…</p></div>;
  if (onPublicRoute && owner) return <Navigate to="/testing/new" replace />;

  if (publicMode && sentTo) {
    return (
      <>
        <AuthNav />
        <div className="auth-wrap auth-wrap-nav">
          <div className="auth-card auth-card-wide">
            <h1 className="auth-title">Check your email</h1>
            <p className="auth-lede">
              We sent a sign-in link to <strong>{sentTo}</strong>. Click it within 15 minutes to sign
              in and see your request&rsquo;s status — it attaches to your account automatically.
            </p>
            {sentNote && <p className="field-hint">{sentNote}</p>}
            <p className="field-hint">
              Didn&rsquo;t get it, or the link expired? Request a fresh one any time from{' '}
              <a className="link" href="/start">the sign-in page</a> with the same email — your
              request will be waiting.
            </p>
          </div>
        </div>
      </>
    );
  }

  const page = (
    <div className={publicMode ? 'page page-standalone' : 'page'}>
      <div className="page-head"><h1>{requestId ? 'Edit audit request' : 'Request an agent compatibility audit'}</h1></div>
      <p className="page-lede">
        Describe ONE important workflow. We review your request, confirm coverage, and send an exact
        scope and price for approval. <strong>No payment is taken now.</strong> Never include API keys,
        passwords, production data, or private customer information — tests run only against public
        docs and safe synthetic fixtures.
      </p>
      {publicMode && (
        <p className="page-lede">
          No account needed — enter your email below and we send a sign-in link when you submit, so
          you can follow the review.
        </p>
      )}
      {error && <div className="banner banner-error" role="alert">{error}</div>}

      <form className="form" onSubmit={(e) => { e.preventDefault(); void save(true); }}>
        <section className="panel">
          <h2>Product</h2>
          <div className="field">
            <label className="field-label" htmlFor="t-name">Product name</label>
            <input id="t-name" maxLength={120} value={intake.product_name} onChange={(e) => set('product_name', e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-cat">Category</label>
            <select id="t-cat" value={intake.product_category} onChange={(e) => set('product_category', e.target.value as TestingIntake['product_category'])}>
              <option value="api">API</option>
              <option value="mcp">MCP service</option>
              <option value="other">Other (manual review; not eligible for the standard package until supported)</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-url">Product URL (https)</label>
            <input id="t-url" type="url" value={intake.product_url} onChange={(e) => set('product_url', e.target.value)} placeholder="https://sandbox.yourproduct.example" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-docs">Public documentation URL (https)</label>
            <input id="t-docs" type="url" value={intake.documentation_url} onChange={(e) => set('documentation_url', e.target.value)} placeholder="https://docs.yourproduct.example/quickstart" required />
            <p className="field-hint">Workers start from these public instructions only — exactly like a new agent user.</p>
          </div>
        </section>

        <section className="panel">
          <h2>The workflow</h2>
          <div className="field">
            <label className="field-label" htmlFor="t-objective">Workflow objective (one observable end-to-end result)</label>
            <textarea id="t-objective" rows={4} maxLength={2000} value={intake.workflow_objective} onChange={(e) => set('workflow_objective', e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-expected">Expected result / oracle — what establishes correctness?</label>
            <textarea id="t-expected" rows={4} maxLength={4000} value={intake.expected_result} onChange={(e) => set('expected_result', e.target.value)} required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-fixture">Safe synthetic fixture (inline JSON/text, no real data, no secrets)</label>
            <textarea id="t-fixture" rows={4} maxLength={8000} value={intake.fixture.inline ?? ''} onChange={(e) => set('fixture', { classification: 'synthetic', inline: e.target.value })} />
            <p className="field-hint">Or a public https fixture URL:</p>
            <input aria-label="Fixture URL" type="url" value={intake.fixture.url ?? ''} onChange={(e) => set('fixture', { classification: 'synthetic', inline: intake.fixture.inline, url: e.target.value || undefined })} placeholder="https://…" />
          </div>
        </section>

        <section className="panel">
          <h2>Target and limits</h2>
          <div className="field">
            <label className="field-label" htmlFor="t-target">Test target and release/version</label>
            <input id="t-target" maxLength={500} value={intake.target_environment} onChange={(e) => set('target_environment', e.target.value)} placeholder="https://sandbox.yourproduct.example — release 2026-09" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-release">Release identifier (optional)</label>
            <input id="t-release" maxLength={200} value={intake.release_identifier ?? ''} onChange={(e) => set('release_identifier', e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-auth">Authentication mode</label>
            <select id="t-auth" value={intake.auth_mode} onChange={(e) => set('auth_mode', e.target.value as TestingIntake['auth_mode'])}>
              <option value="none">None — public docs and endpoints</option>
              <option value="worker_owned_test_account">Worker-owned disposable test account (normal signup, explicitly allowed by you)</option>
            </select>
            <p className="field-hint">Workflows that require customer-provided credentials are not supported in v1 and go to manual review.</p>
          </div>
          <div className="field">
            <label className="field-label">
              <input type="checkbox" checked={intake.allowed_operations.read_only}
                onChange={(e) => set('allowed_operations', { ...intake.allowed_operations, read_only: e.target.checked })} /> Read-only operations (default)
            </label>
            {!intake.allowed_operations.read_only && (
              <>
                <p className="field-hint">List each explicit sandbox write step (each needs operator approval):</p>
                <textarea aria-label="Sandbox write steps, one per line" rows={3}
                  value={intake.allowed_operations.sandbox_write_steps.join('\n')}
                  onChange={(e) => set('allowed_operations', { ...intake.allowed_operations, sandbox_write_steps: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 10) })} />
              </>
            )}
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-cov">Coverage preferences (optional — preferences, not promises)</label>
            <input id="t-cov" value={intake.coverage_preferences.join(', ')} onChange={(e) => set('coverage_preferences', e.target.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10))} placeholder="claude-code/mcp, openhands/http" />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-constraints">Known constraints</label>
            <textarea id="t-constraints" rows={3} maxLength={2000} value={intake.known_constraints} onChange={(e) => set('known_constraints', e.target.value)} placeholder="Rate limits, reset procedure, test-account instructions, prohibited actions…" />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="t-suspect">Suspected failure (optional context — a hypothesis, not a finding)</label>
            <textarea id="t-suspect" rows={2} maxLength={2000} value={intake.suspected_failure} onChange={(e) => set('suspected_failure', e.target.value)} />
          </div>
        </section>

        <section className="panel">
          <h2>{publicMode ? 'Your email and authorization' : 'Authorization'}</h2>
          {publicMode && (
            <div className="field">
              <label className="field-label" htmlFor="t-email">Email — for sign-in and status updates</label>
              <input id="t-email" type="email" autoComplete="email" maxLength={320} value={publicEmail}
                onChange={(e) => setPublicEmail(e.target.value)} placeholder="you@company.com" required />
              <p className="field-hint">
                We email you a sign-in link; your request attaches to that address. No password, no
                separate signup form.
              </p>
            </div>
          )}
          <div className="field">
            <label className="field-label">
              <input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} required />{' '}
              I am authorized to commission these specific tests against this target.
            </label>
          </div>
          <div className="field">
            <label className="field-label">
              <input type="checkbox" checked={disclosure} onChange={(e) => setDisclosure(e.target.checked)} required />{' '}
              I understand that approved independent operators receive the test materials above
              (workflow, documentation links, synthetic fixture) to execute the audit.
            </label>
          </div>
        </section>

        {problems.length > 0 && (
          <div className="banner banner-warn" role="status">
            <strong>Before you submit:</strong>
            <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}

        <div className="btn-row">
          {!publicMode && (
            <button type="button" className="btn" disabled={busy} onClick={() => void save(false)}>Save draft</button>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || problems.length > 0}>
            {busy ? 'Saving…' : 'Submit for scope review'}
          </button>
          {publicMode
            ? <a className="btn btn-ghost" href="https://basedagents.ai/testing">Cancel</a>
            : <Link className="btn btn-ghost" to="/testing">Cancel</Link>}
        </div>
        <p className="muted">
          {publicMode
            ? 'Submitting sends the request for review and emails you a sign-in link. No payment has been taken — we confirm coverage and the exact price before you pay.'
            : 'Submitting sends the request for review. No payment has been taken — we confirm coverage before you pay.'}
        </p>
      </form>
    </div>
  );
  return publicMode ? <><AuthNav />{page}</> : page;
}
