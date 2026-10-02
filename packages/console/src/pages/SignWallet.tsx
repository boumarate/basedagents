/**
 * /sign-wallet#m=<base64url message> — sign a payout-wallet bind message
 * (decision D8) with a browser wallet. `basedagents wallet set <address>`
 * prints this link when it has no wallet key to sign with. The message rides in
 * the URL fragment, so it never reaches a server; this page only asks the
 * wallet to sign it (personal_sign) and shows the signature to paste back into
 * the terminal. No session, nothing sent, no funds moved.
 *
 * Banned-words rule: nothing here renders grant/lease/delegation/identity/
 * credential/owner (scripts/lint-ui-words.mjs).
 */
import { useMemo, useState } from 'react';
import { AuthBrand } from '../components/AuthBrand.js';
import { bindCommand, personalSign, readBindLink, walletAvailable, WalletError } from '../lib/wallet.js';

export default function SignWallet() {
  // Only a bind message in the registry's exact form is shown, signed or turned into a command.
  const link = useMemo(() => readBindLink(window.location.hash), []);
  const parsed = link ? { message: link.message, ...link.fields } : null;
  const [signature, setSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSign(): Promise<void> {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const { signature: sig } = await personalSign(parsed.message, parsed.wallet);
      setSignature(sig);
    } catch (err) {
      setError(err instanceof WalletError || err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const command = link && signature ? bindCommand(link.fields, signature) ?? '' : '';

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <AuthBrand />
        {!parsed ? (
          <>
            <h1 className="auth-title">Nothing to sign</h1>
            <p className="auth-lede">
              Open this page from the link <code>basedagents wallet set 0x…</code> prints in your terminal.
            </p>
          </>
        ) : (
          <>
            <h1 className="auth-title">Confirm your payout wallet</h1>
            <p className="auth-lede">
              Sign this message with <strong>{parsed.wallet}</strong> to prove it is yours. Bounties for{' '}
              <code>{parsed.agent}</code> are then paid there in USDC. Signing costs nothing and moves no funds.
            </p>
            <pre className="code-block prewrap" data-testid="bind-message">{parsed.message}</pre>
            {error && <div className="banner banner-error" role="alert">{error}</div>}
            {!signature ? (
              <>
                {!walletAvailable() && (
                  <div className="banner banner-warn" role="status">
                    No browser wallet found. Install one (e.g. MetaMask, Coinbase Wallet or Rabby), unlock{' '}
                    {parsed.wallet}, and reload this page.
                  </div>
                )}
                <button className="btn btn-primary" onClick={() => void onSign()} disabled={busy || !walletAvailable()}>
                  {busy ? 'Waiting for your wallet…' : 'Sign with my wallet'}
                </button>
              </>
            ) : (
              <>
                <p className="auth-lede">Signed. Paste this into your terminal to finish (valid for 15 minutes):</p>
                <div className="code-block cmd" data-testid="bind-command">{command}</div>
                <button
                  className="btn btn-ghost"
                  onClick={() => { void navigator.clipboard?.writeText(command).then(() => setCopied(true)); }}
                >
                  {copied ? 'Copied' : 'Copy command'}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
