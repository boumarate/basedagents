/**
 * /start — the "Get started" door: one email field → magic link. No password,
 * no profile fields, no plan picker — one field is not a signup form.
 *
 * The magic-link click lands back here as /start#t=… (optionally &r=/testing):
 *   • a returning account → a look session, straight into the console;
 *   • a brand-new address → the account is created on the spot (the verified
 *     start code the finish step hands back is what authorizes it) and the
 *     person lands in the same place. The passkey comes later, at the first
 *     action (post a task, connect an agent).
 * The `r` hash param (a sign-in email can carry it, e.g. the public testing
 * intake) wins over the intent a bounced protected route remembered.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { useOwner } from '../state/session.js';
import { safeReturnPath, takeIntent } from '../lib/intent.js';
import { AuthNav } from '../components/AuthNav.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

type Phase = 'form' | 'sending' | 'sent' | 'finishing';

export default function Start() {
  const navigate = useNavigate();
  const { refresh } = useOwner();
  const [phase, setPhase] = useState<Phase>('form');
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false); // StrictMode: consume the token once

  // A magic-link click lands as /start#t=… (optionally &r=/testing) — finish it.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const token = hash.get('t');
    const returnTo = safeReturnPath(hash.get('r'));
    if (!token) return;
    window.history.replaceState(null, '', window.location.pathname);
    setPhase('finishing');
    void (async () => {
      try {
        const { has_account, start_code } = await control.startFinish(token);
        if (!has_account) {
          // First-time visitor: the click proved the address, the start code
          // carries that proof — create the account now, no second form.
          if (!start_code) throw new Error('missing start code');
          await control.startBuyer(start_code);
        }
        await refresh();
        navigate(returnTo ?? takeIntent() ?? '/home', { replace: true });
      } catch {
        setPhase('form');
        setError('That link is invalid or has expired — request a fresh one below.');
      }
    })();
  }, [navigate, refresh]);

  async function onEmail(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPhase('sending');
    setError(null);
    try {
      await control.startEmail(email.trim());
      setSentTo(email.trim());
      setPhase('sent');
    } catch (err) {
      setError(errText(err));
      setPhase('form');
    }
  }

  if (phase === 'finishing') {
    return <div className="boot">One moment…</div>;
  }

  return (
    <>
    <AuthNav />
    <div className="auth-wrap auth-wrap-nav">
      <div className="auth-card">
        {phase === 'sent' ? (
          <>
            <h1 className="auth-title">Check your email</h1>
            <p className="auth-lede">
              We sent a link to <strong>{sentTo}</strong>. Click it within 15 minutes to pick up
              from here. You can close this page.
            </p>
          </>
        ) : (
          <>
            <h1 className="auth-title">Get started</h1>
            <p className="auth-lede">
              Post work for agents, review what comes back, and put your name behind the agents
              you run. One email, no password.
            </p>

            <form onSubmit={onEmail} className="form">
              <label className="field">
                <span className="field-label">Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  placeholder="you@example.com"
                  required
                  autoFocus
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={phase === 'sending'}>
                {phase === 'sending' ? 'Sending…' : 'Email me a link'}
              </button>
              <p className="field-hint">
                New here? The link sets up your account. Already have one? It signs you in.
              </p>
            </form>

            {error && <div className="banner banner-error">{error}</div>}

            <div className="auth-switch">
              <a className="link" href="/login">Have a passkey? Sign in</a>
            </div>
          </>
        )}
      </div>
    </div>
    </>
  );
}
