import { useState } from 'react';
import { Link } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import { createPasskey, passkeysSupported } from '../lib/webauthn.js';
import { AuthBrand } from '../components/AuthBrand.js';

function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Account recovery (CONTROL_PLANE.md §6) — a PUBLIC page, no session.
 *
 * Two entries:
 *   - no token in the URL → ask for the email, mail the magic link;
 *   - arrived via the emailed link (#t=<token>) → ask for the recovery code,
 *     then enroll a NEW passkey. Success revokes every other passkey and all
 *     sessions; the agents connected to the account stay connected.
 *
 * The token rides the URL FRAGMENT so it never appears in server logs.
 */
export default function Recover() {
  // Read once at mount; the fragment never navigates within the SPA.
  const [token] = useState(() => {
    const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(window.location.hash);
    return m ? m[1] : null;
  });

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ revoked: number; nextStep: string } | null>(null);

  const supported = passkeysSupported();

  async function onSendLink(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await control.recoverBegin(email.trim());
      setSent(true); // uniform response — the server never says whether the email exists
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRecover(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const opt = await control.recoverOptions(token, code.trim());
      const reg = await createPasskey(opt.options);
      const fin = await control.recoverFinish(token, code.trim(), reg);
      setDone({ revoked: fin.revoked_passkeys, nextStep: fin.next_step });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <AuthBrand> <span className="brand-sub">Console</span></AuthBrand>
        <h1 className="auth-title">Account recovery</h1>

        {done ? (
          <>
            <div className="banner banner-warn">
              New passkey enrolled. {done.revoked} old passkey{done.revoked === 1 ? '' : 's'} and all
              sessions were revoked.
            </div>
            <p className="auth-lede">{done.nextStep}</p>
            <Link className="btn btn-primary" to="/login">Sign in with the new passkey</Link>
          </>
        ) : token ? (
          <>
            <p className="auth-lede">
              Enter your recovery code to enroll a <strong>new</strong> passkey. Every other passkey
              and session will be revoked. Your tasks and connected agents are not touched.
            </p>
            {!supported && (
              <div className="banner banner-warn">This browser has no passkey support.</div>
            )}
            <form onSubmit={onRecover} className="form">
              <label className="field">
                <span className="field-label">Recovery code</span>
                <input
                  type="text"
                  value={code}
                  onChange={(ev) => setCode(ev.target.value)}
                  placeholder="xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx"
                  spellCheck={false}
                  autoComplete="off"
                  required
                />
                <span className="field-hint">The one-time code you saved from your Home page.</span>
              </label>
              <button className="btn btn-primary" type="submit" disabled={busy || !supported}>
                {busy ? 'Waiting for passkey…' : 'Enroll new passkey'}
              </button>
            </form>
          </>
        ) : sent ? (
          <p className="auth-lede">
            If that email belongs to an account, a recovery link is on its way. Open it within
            15 minutes — you will also need your recovery code.
          </p>
        ) : (
          <>
            <p className="auth-lede">
              Lost your passkeys? Recovery takes your account email <em>and</em> your one-time
              recovery code — neither works alone.
            </p>
            <form onSubmit={onSendLink} className="form">
              <label className="field">
                <span className="field-label">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a recovery link'}
              </button>
            </form>
          </>
        )}

        {error && <div className="banner banner-error">{error}</div>}

        {!done && (
          <div className="auth-switch">
            <Link className="link" to="/login">Back to sign in</Link>
          </div>
        )}
      </div>
    </div>
  );
}
