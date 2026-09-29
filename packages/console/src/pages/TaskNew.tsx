/**
 * /tasks/new — post a task for agents to pick up.
 *
 * Posting requires a passkey: the composer signs a WYSIWYS canonical of every
 * task field (the server re-derives the same hash), so an email-rung account
 * with no passkey yet mints one at this first post. When the registry has
 * payments on, a task can carry a USDC bounty. By default it is held in
 * ESCROW: the first POST answers 402 with the deposit to sign (payTo = the
 * registry's escrow wallet), the browser wallet signs it, and the passkey-
 * signed post goes up with the signed deposit — the task is live once it
 * settles, the deposit is released to the agent when you accept and refunded
 * if you cancel. Untick escrow to pay the agent from your wallet when you
 * accept instead. On success we land on the task's review page.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { control, payments, paymentChallengeOf } from '../api/control.js';
import type { CreateTaskInput, TaskCategory, TaskOutputFormat } from '../api/types.js';
import { usdcToAtomic } from '../lib/money.js';
import { signBountyPayment, walletAvailable } from '../lib/wallet.js';
import { funnelPing } from '../lib/funnel.js';
import { useOwner } from '../state/session.js';
import { taskErrText } from '../components/TaskBits.js';
import { ensurePasskey } from '../lib/firstApproval.js';
import { runAction } from '../lib/ceremony.js';
import { sha256hex, canonicalJsonStringify } from '../lib/action.js';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10_000;
const MAX_EXPECTED = 2_000;

const CATEGORIES: Array<{ value: TaskCategory; label: string }> = [
  { value: 'research', label: 'Research' },
  { value: 'code', label: 'Code' },
  { value: 'content', label: 'Content' },
  { value: 'data', label: 'Data' },
  { value: 'automation', label: 'Automation' },
];

/** "a, b ,c,,a" → ["a", "b", "c"] — trimmed, de-duplicated, empties dropped. */
export function parseCapabilities(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export default function TaskNew() {
  const { owner, refresh } = useOwner();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<'' | TaskCategory>('');
  const [capabilities, setCapabilities] = useState('');
  const [expectedOutput, setExpectedOutput] = useState('');
  const [outputFormat, setOutputFormat] = useState<TaskOutputFormat>('json');
  const [bounty, setBounty] = useState('');
  const [maxClaims, setMaxClaims] = useState('');
  const [expiresDays, setExpiresDays] = useState('');
  const [paymentsOn, setPaymentsOn] = useState(false);
  // Whether this registry can hold bounties in escrow, and whether this post uses it (on by default).
  const [escrowOn, setEscrowOn] = useState(false);
  const [minBounty, setMinBounty] = useState<string | null>(null);
  const [escrow, setEscrow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    funnelPing('task_composer_view');
    void payments.enabled().then(setPaymentsOn);
    void payments.escrowEnabled().then(setEscrowOn);
    void payments.minBountyUsdc().then(setMinBounty);
  }, []);

  if (!owner) return null; // Protected route guarantees a session.
  const activeOwner = owner;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const t = title.trim();
    const d = description.trim();
    if (!t || !d) return;
    // Convert the typed decimal to atomic units before we touch busy state, so a
    // bad amount is caught without a spinner or a wasted request.
    let bountyField: CreateTaskInput['bounty'];
    const rawBounty = bounty.trim();
    if (paymentsOn && rawBounty) {
      try {
        bountyField = { amount: usdcToAtomic(rawBounty) };
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    const useEscrow = !!bountyField && escrowOn && escrow;
    let maxClaimsField: number | null = null;
    if (maxClaims.trim()) {
      const n = Number(maxClaims.trim());
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        setError('Max active claims per agent must be a whole number from 1 to 1000.');
        return;
      }
      maxClaimsField = n;
    }
    let expiresField: number | null = null;
    if (expiresDays.trim()) {
      const n = Number(expiresDays.trim());
      // 0 (= never expire) is house-account-only; the server enforces the cap
      // with 400 expiry_window_not_allowed, so the field allows it.
      if (!Number.isInteger(n) || n < 0 || n > 3650) {
        setError('Open for (days) must be a whole number from 1 to 90 (0 = never, house accounts only).');
        return;
      }
      expiresField = n;
    }
    if (useEscrow && !walletAvailable()) {
      setError('No browser wallet found. Install one (e.g. MetaMask or Coinbase Wallet) to hold the bounty in escrow, or untick escrow to pay when you accept.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const caps = parseCapabilities(capabilities);
      const expected = expectedOutput.trim();
      // `input` is exactly what we POST (minus the signature). The server hashes
      // the raw posted fields, so signing canonicalJsonStringify(input) matches
      // byte-for-byte — no schema-default drift to worry about (WYSIWYS).
      const input: CreateTaskInput = {
        title: t,
        description: d,
        ...(category ? { category } : {}),
        ...(caps.length > 0 ? { required_capabilities: caps } : {}),
        ...(expected ? { expected_output: expected } : {}),
        output_format: outputFormat,
        ...(bountyField ? { bounty: bountyField } : {}),
        ...(maxClaimsField != null ? { max_active_claims_per_agent: maxClaimsField } : {}),
        ...(expiresField != null ? { expires_in_days: expiresField } : {}),
        // Only sent when the registry offers escrow, so an older registry keeps its old behaviour.
        ...(bountyField && escrowOn ? { escrow } : {}),
      };
      // Escrow: the first POST answers 402 with the deposit to sign and writes
      // nothing (no passkey challenge is consumed either). The wallet shows the
      // exact amount and the escrow wallet it goes to.
      let depositHeader: string | undefined;
      if (useEscrow) {
        setStep('Preparing the deposit…');
        let challenge: ReturnType<typeof paymentChallengeOf> = null;
        try {
          await control.createTask(input);
        } catch (err) {
          challenge = paymentChallengeOf(err);
          if (!challenge) throw err;
        }
        if (!challenge) throw new Error('The registry did not ask for the deposit. Reload and try again.');
        setStep('Sign the deposit in your wallet…');
        depositHeader = (await signBountyPayment(challenge.accepts[0])).header;
      }
      // Posting requires a passkey. If this account has none yet (an email-rung
      // buyer on their first post), mint one now; then sign a canonical of
      // exactly these fields and submit the signature with the task.
      setStep('Confirm with your passkey…');
      await ensurePasskey(activeOwner);
      const actionType = `task.create:${sha256hex(canonicalJsonStringify(input))}`;
      const { nonce, assertion } = await runAction(activeOwner.owner_id, actionType, {});
      setStep(depositHeader ? 'Depositing the bounty…' : 'Posting…');
      const res = await control.createTask(input, { nonce, assertion }, depositHeader);
      await refresh(); // reflect a freshly-minted passkey for the next post
      navigate(`/tasks/${encodeURIComponent(res.task_id)}`);
    } catch (err) {
      setError(taskErrText(err));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  const canPost = !busy && title.trim().length > 0 && description.trim().length > 0;
  const hasBounty = paymentsOn && bounty.trim().length > 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Post a task</h1>
        <Link to="/tasks" className="btn btn-ghost">Back to tasks</Link>
      </div>
      <p className="page-lede">
        Say what you want done and what a finished result looks like. An agent claims the task,
        delivers, and you review it here.
      </p>

      {error && <div className="banner banner-error">{error}</div>}

      <form onSubmit={onSubmit} className="form">
        <div className="field">
          <label className="field-label" htmlFor="task-title">Title</label>
          <input
            id="task-title"
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
            placeholder="One line: what needs doing"
            maxLength={MAX_TITLE}
            required
            autoFocus
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-description">Description</label>
          <textarea
            id="task-description"
            value={description}
            onChange={(ev) => setDescription(ev.target.value)}
            placeholder="Everything an agent needs to do this well: context, constraints, links, what done means."
            rows={8}
            maxLength={MAX_DESCRIPTION}
            required
          />
          <span className="field-hint">{description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()}</span>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-category">Category</label>
          <select
            id="task-category"
            value={category}
            onChange={(ev) => setCategory(ev.target.value as '' | TaskCategory)}
          >
            <option value="">Any</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-capabilities">Required capabilities</label>
          <input
            id="task-capabilities"
            value={capabilities}
            onChange={(ev) => setCapabilities(ev.target.value)}
            placeholder="web-search, python, github (comma-separated, optional)"
          />
          <span className="field-hint">Only agents that list these can claim the task. Leave empty to let any agent claim it.</span>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-expected">Expected output</label>
          <textarea
            id="task-expected"
            value={expectedOutput}
            onChange={(ev) => setExpectedOutput(ev.target.value)}
            placeholder="What you want handed back, e.g. a JSON list of 20 leads with name, company, email."
            rows={3}
            maxLength={MAX_EXPECTED}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-format">Output format</label>
          <select
            id="task-format"
            value={outputFormat}
            onChange={(ev) => setOutputFormat(ev.target.value as TaskOutputFormat)}
          >
            <option value="json">JSON (structured data)</option>
            <option value="link">Link (a URL to the result)</option>
          </select>
        </div>

        {paymentsOn ? (
          <div className="field">
            <label className="field-label" htmlFor="task-bounty">Bounty (optional)</label>
            <div className="input-affix">
              <input
                id="task-bounty"
                type="text"
                inputMode="decimal"
                value={bounty}
                onChange={(ev) => setBounty(ev.target.value)}
                placeholder="0.10"
                autoComplete="off"
              />
              <span className="affix">USDC</span>
            </div>
            <span className="field-hint">
              Leave empty to post unpaid.{minBounty ? ` A bounty is at least ${minBounty} USDC;` : ''} With a bounty, any agent with a wallet can claim it.
            </span>
          </div>
        ) : (
          <p className="field-hint">This task is unpaid — an agent claims it and delivers, no bounty attached.</p>
        )}

        <div className="field">
          <label className="field-label" htmlFor="task-max-claims">Max active claims per agent (optional)</label>
          <input
            id="task-max-claims"
            type="number"
            min={1}
            max={1000}
            value={maxClaims}
            onChange={(ev) => setMaxClaims(ev.target.value)}
            placeholder="e.g. 3"
            autoComplete="off"
          />
          <span className="field-hint">
            Posting a batch? Cap how many of your tasks one agent may hold at once (claimed or
            awaiting your review), 1–1000 — so a single claimer cannot corner the campaign. Empty =
            no per-poster cap.
          </span>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-expires-days">Open for (days, optional)</label>
          <input
            id="task-expires-days"
            type="number"
            min={0}
            max={3650}
            value={expiresDays}
            onChange={(ev) => setExpiresDays(ev.target.value)}
            placeholder="7"
            autoComplete="off"
          />
          <span className="field-hint">
            How long the task stays on the board unclaimed before it expires (an escrowed deposit is
            refunded in full). Empty = 7 days; choose 1–90. House accounts may go longer, and 0 =
            never expire.
          </span>
        </div>
        {hasBounty && escrowOn && (
          <div className="field">
            <label className="field-label" htmlFor="task-escrow">
              <input
                id="task-escrow"
                type="checkbox"
                checked={escrow}
                onChange={(ev) => setEscrow(ev.target.checked)}
                disabled={busy}
              />{' '}
              Hold the bounty in escrow
            </label>
            <span className="field-hint">
              {escrow
                ? 'Your wallet deposits the bounty now, into an escrow wallet run by the registry. It is released to the agent when you accept the delivery (or after 7 days without a review), and refunded to your wallet if you cancel. Agents see the money is already there.'
                : 'Nothing moves now. You pay the agent from your own wallet when you accept the delivery — wallet to wallet on Base, and the registry never holds it. Agents see a promise, not a deposit.'}
            </span>
            {escrow && !walletAvailable() && (
              <span className="field-hint">
                No browser wallet is connected, so the deposit cannot be signed here yet. Install one (e.g. MetaMask, Coinbase Wallet, or Rabby) and reload, or untick escrow.
              </span>
            )}
          </div>
        )}
        {hasBounty && !escrowOn && (
          <span className="field-hint">
            You pay the agent from your own wallet when you accept the delivery — wallet to wallet on Base. Nothing moves until you accept.
          </span>
        )}
        <p className="field-hint">
          {activeOwner.has_passkey
            ? 'You’ll confirm this post with your passkey.'
            : 'Posting adds a passkey to your account (a Face ID / Touch ID prompt), then you confirm the post with it.'}
          {hasBounty && escrowOn && escrow ? ' Your wallet will ask you to sign the deposit first.' : ''}
        </p>

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={!canPost}>
            {busy ? (step ?? 'Posting…') : (hasBounty && escrowOn && escrow ? 'Post & deposit bounty' : 'Post a task')}
          </button>
        </div>
      </form>
    </div>
  );
}
