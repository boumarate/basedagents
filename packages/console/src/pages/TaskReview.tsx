/**
 * /tasks/:taskId — one task you posted: what you asked for, what came back
 * (every delivery, newest first), and the review actions for its state.
 *
 *   submitted            → Accept (optional note) · Request changes (note, max 3) · Dispute (reason)
 *   submitted + disputed → Accept · Cancel task
 *   open | claimed       → Cancel task
 *   verified             → "Accepted on <date>" (+ "accepted automatically" after the 7-day window)
 *
 * Money: an ESCROW task (the default for bounties) was funded when it was
 * posted — accepting releases the held deposit to the agent with no wallet
 * prompt, cancelling refunds it, and a deposit that failed can be redone from
 * here ("Deposit again"). A task posted without escrow pays at accept: the
 * browser wallet signs the transfer to the agent then.
 *
 * Reviews work on your sign-in alone. When the account holds a passkey, each
 * review is also signed: the action string binds the task id and the sha256 of
 * the note you typed (`task.accept:<id>:<sha256hex(note)>`), the server
 * re-derives it from the body it receives, and {nonce, assertion} ride along.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { control, payments, ControlApiError, paymentChallengeOf } from '../api/control.js';
import type { SignedAction, TaskRating } from '../api/control.js';
import type { OwnerTaskDetail, OwnerTaskReceipt, TaskPaymentResponse } from '../api/types.js';
import { sha256hex } from '../lib/action.js';
import { runAction } from '../lib/ceremony.js';
import { signBountyPayment, walletAvailable } from '../lib/wallet.js';
import { useOwner } from '../state/session.js';
import {
  EscrowPill,
  MAX_REVISIONS,
  TaskReviewPills,
  TaskStatusPill,
  fmtDate,
  isStaleError,
  taskErrText,
} from '../components/TaskBits.js';

const MAX_NOTE = 2_000;

/** Why a claimed bounty isn't ready to pay yet (GET /payment's reason). */
function payUnavailableText(reason: TaskPaymentResponse['requirements_unavailable_reason']): string {
  switch (reason) {
    case 'not_claimed':
      return 'No agent has claimed this task yet, so there is nobody to pay.';
    case 'payee_wallet_missing':
      return 'The agent that delivered has no wallet on record, so the bounty cannot be paid. Ask them to set one.';
    case 'unsupported_network':
      return 'This bounty is on a network the registry cannot settle. Contact support.';
    case 'no_bounty':
      return 'This task has no bounty to pay.';
    case 'escrow_held':
      return 'The bounty is already held in escrow — nothing to sign.';
    case 'escrow_funding':
      return 'The deposit is still settling into escrow.';
    case 'escrow_unavailable':
      return 'Escrow is not available on this registry right now.';
    default:
      return 'The payment details for this task are not available right now. Reload and try again.';
  }
}

interface Milestone {
  key: string;
  at: string;
  label: string;
}

/** The task's history in time order, from the timestamps the task carries. */
function milestones(task: OwnerTaskDetail['task'], claimer: string | null): Milestone[] {
  const out: Milestone[] = [{ key: 'posted', at: task.created_at, label: 'Posted' }];
  if (task.escrow?.funded_at) out.push({ key: 'funded', at: task.escrow.funded_at, label: 'Bounty deposited in escrow' });
  if (task.claimed_at) out.push({ key: 'claimed', at: task.claimed_at, label: claimer ? `Claimed by ${claimer}` : 'Claimed' });
  if (task.revision_requested_at) out.push({ key: 'revision', at: task.revision_requested_at, label: 'Changes requested' });
  if (task.submitted_at) out.push({ key: 'delivered', at: task.submitted_at, label: 'Delivered' });
  if (task.disputed_at) out.push({ key: 'disputed', at: task.disputed_at, label: 'Disputed' });
  if (task.verified_at) {
    out.push({
      key: 'accepted',
      at: task.verified_at,
      label: task.accepted_by === 'auto' ? 'Accepted automatically' : 'Accepted',
    });
  }
  if (task.cancelled_at) out.push({ key: 'cancelled', at: task.cancelled_at, label: 'Cancelled' });
  if (task.expired_at) out.push({ key: 'expired', at: task.expired_at, label: 'Expired unclaimed' });
  if (task.escrow?.released_at) out.push({ key: 'released', at: task.escrow.released_at, label: 'Bounty released to the agent' });
  if (task.escrow?.refunded_at) out.push({ key: 'refunded', at: task.escrow.refunded_at, label: 'Deposit refunded' });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Only http(s) links become anchors; anything else (javascript:, data:, …) is shown as text. */
function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

function ReceiptCard({ receipt, latest }: { receipt: OwnerTaskReceipt; latest: boolean }) {
  const links = receipt.artifact_urls ?? [];
  return (
    <li className="card">
      <div className="card-main">
        <div className="card-title">
          <span>{latest ? 'Latest delivery' : 'Earlier delivery'}</span>
          {receipt.agent_name && <span className="muted">by {receipt.agent_name}</span>}
        </div>
        <p className="prewrap">{receipt.summary}</p>
        {(links.length > 0 || receipt.pr_url || receipt.commit_hash) && (
          <div className="receipt-links">
            {links.map((u) =>
              isHttpUrl(u)
                ? <a key={u} href={u} target="_blank" rel="noreferrer noopener">{u}</a>
                : <code key={u} className="muted">{u}</code>,
            )}
            {receipt.pr_url && (
              isHttpUrl(receipt.pr_url)
                ? <a href={receipt.pr_url} target="_blank" rel="noreferrer noopener">Pull request</a>
                : <code className="muted">{receipt.pr_url}</code>
            )}
            {receipt.commit_hash && (
              <code title={receipt.commit_hash}>commit {receipt.commit_hash.slice(0, 12)}</code>
            )}
          </div>
        )}
        <div className="card-meta">
          <span>Completed {fmtDate(receipt.completed_at)}</span>
          <span className="dot">·</span>
          <code className="muted" title={receipt.receipt_id}>{receipt.receipt_id}</code>
        </div>
      </div>
    </li>
  );
}

export default function TaskReview() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const { owner } = useOwner();
  const [detail, setDetail] = useState<OwnerTaskDetail | null>(null);
  const [note, setNote] = useState('');
  // Optional 1-5 rating sent with an accept or a dispute (decision D11).
  const [rating, setRating] = useState<number | null>(null);
  const [ratingComment, setRatingComment] = useState('');
  // The accept went through but its rating change wasn't saved: keep the picks and offer a retry.
  const [ratingUnsaved, setRatingUnsaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // 'accept' | 'revision' | 'dispute' | 'cancel'
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const ownerId = owner?.owner_id;

  const load = useCallback(async () => {
    if (!ownerId || !taskId) return;
    try {
      setDetail(await control.task(taskId));
      setNotFound(false);
    } catch (err) {
      if (err instanceof ControlApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(taskErrText(err));
      }
    }
  }, [ownerId, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The passkey half of a review, when THIS session can produce one. A passkey
   * signature is an optional provenance upgrade — the server authorizes these
   * actions on the signed-in session alone — so gate on `session_method`, not
   * `has_passkey`: only prompt when this session was itself signed in with a
   * passkey (then it's provably on this device). A session signed in by email
   * still acts on the session alone; it just isn't additionally signed. This is
   * what keeps you from being locked out of your own task when your only passkey
   * lives on another device.
   */
  async function sign(actionType: string): Promise<SignedAction | undefined> {
    if (owner?.session_method !== 'passkey') return undefined;
    // The canonical is {action_type, owner_id, nonce} — the content lives in
    // the action string itself, so there are no extra params to mirror.
    try {
      return await runAction(owner.owner_id, actionType, {});
    } catch (err) {
      // The WebAuthn step failed (no credential on this device, dismissed, or
      // timed out) — the browser throws a DOMException. Fall back to the session
      // so an unreachable passkey can't block you from acting on your own task.
      // A WYSIWYS/verification failure is a plain Error and must still hard-stop.
      if (err instanceof DOMException) return undefined;
      throw err;
    }
  }

  async function run(kind: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      const result = await fn();
      const unsaved = !!result && typeof result === 'object' && (result as { rating_saved?: unknown }).rating_saved === false;
      setNote('');
      setRatingUnsaved(unsaved);
      if (!unsaved) {
        setRating(null);
        setRatingComment('');
      }
      await load();
    } catch (err) {
      setError(taskErrText(err));
      if (isStaleError(err)) await load();
    } finally {
      setBusy(null);
    }
  }

  /** The rating to send, if one was picked. */
  function ratingPayload(): TaskRating | undefined {
    if (rating === null) return undefined;
    const comment = ratingComment.trim();
    return { rating, ...(comment ? { rating_comment: comment } : {}) };
  }

  async function onAccept(): Promise<void> {
    const text = note.trim();
    const bounty = detail?.task.bounty ?? null;
    const escrowed = !!detail?.task.escrow;
    await run('accept', async () => {
      if (bounty && !escrowed) {
        // Paid: fetch the server's x402 requirements, sign the USDC transfer in
        // the wallet, then accept with the PAYMENT-SIGNATURE header. The wallet
        // signature is the money authority; the passkey ceremony stays optional.
        const pay = await payments.requirements(taskId);
        if (!pay.requirements) throw new Error(payUnavailableText(pay.requirements_unavailable_reason));
        const { header } = await signBountyPayment(pay.requirements);
        const signed = await sign(`task.accept:${taskId}:${sha256hex(text)}`);
        return control.acceptTask(taskId, text ? text : undefined, signed, header, ratingPayload());
      }
      const signed = await sign(`task.accept:${taskId}:${sha256hex(text)}`);
      return control.acceptTask(taskId, text ? text : undefined, signed, undefined, ratingPayload());
    });
  }

  /** Accept again (a repeat accept pays nothing) to save the rating change that didn't stick. */
  async function onRetryRating(): Promise<void> {
    await run('rate', async () => {
      const signed = await sign(`task.accept:${taskId}:${sha256hex('')}`);
      return control.acceptTask(taskId, undefined, signed, undefined, ratingPayload());
    });
  }

  async function onRequestChanges(): Promise<void> {
    const text = note.trim();
    if (!text) {
      setError('Say what should change — the note goes to the agent that delivered.');
      return;
    }
    await run('revision', async () => {
      const signed = await sign(`task.revision:${taskId}:${sha256hex(text)}`);
      await control.requestTaskRevision(taskId, text, signed);
    });
  }

  async function onDispute(): Promise<void> {
    const text = note.trim();
    if (!text) {
      setError('Say why you are disputing this delivery — the reason goes on the record.');
      return;
    }
    if (!window.confirm('Dispute this work? Automatic acceptance pauses until you accept or cancel.')) return;
    await run('dispute', async () => {
      const signed = await sign(`task.dispute:${taskId}:${sha256hex(text)}`);
      await control.disputeTask(taskId, text, signed, ratingPayload());
    });
  }

  async function onCancel(): Promise<void> {
    const held = detail?.task.escrow?.status === 'funded';
    const amount = detail?.task.bounty ? `${detail.task.bounty.amount_display} ${detail.task.bounty.token}` : '';
    const prompt = held
      ? `Cancel this task? Agents can no longer claim or deliver it, and the ${amount} deposit is refunded to the wallet that paid it. This cannot be undone.`
      : 'Cancel this task? Agents can no longer claim or deliver it. This cannot be undone.';
    if (!window.confirm(prompt)) return;
    await run('cancel', async () => {
      const signed = await sign(`task.cancel:${taskId}`);
      await control.cancelTask(taskId, signed);
    });
  }

  /** Redo a failed escrow deposit: 402 → wallet signs the deposit → POST /fund with the header. */
  async function onFundAgain(): Promise<void> {
    await run('fund', async () => {
      let challenge: ReturnType<typeof paymentChallengeOf> = null;
      try {
        await control.fundTask(taskId);
      } catch (err) {
        challenge = paymentChallengeOf(err);
        if (!challenge) throw err;
      }
      if (!challenge) throw new Error('The registry did not ask for the deposit. Reload and try again.');
      const { header } = await signBountyPayment(challenge.accepts[0]);
      await control.fundTask(taskId, header);
    });
  }

  async function onPublish(publish: boolean): Promise<void> {
    if (publish && !window.confirm(
      'Publish this delivery as a public sample?\n\n'
      + 'Anyone will be able to read the delivered content on the public task page — '
      + 'including anything the deliverable quotes from what you provided. Only publish '
      + 'work that is safe to share. You can make it private again, but that cannot '
      + 'un-share what someone already saw.',
    )) return;
    await run('publish', async () => {
      const signed = await sign(`task.publish:${taskId}:${publish ? '1' : '0'}`);
      await control.publishDelivery(taskId, publish, signed);
    });
  }

  if (!owner) return null; // Protected route guarantees a session.

  if (notFound) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Task not found</h1>
          <Link to="/tasks" className="btn btn-ghost">Back to tasks</Link>
        </div>
        <p className="page-lede">This task is not one of yours, or it no longer exists.</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Task</h1>
          <Link to="/tasks" className="btn btn-ghost">Back to tasks</Link>
        </div>
        {error ? <div className="banner banner-error">{error}</div> : <div className="empty"><p className="muted">Loading…</p></div>}
      </div>
    );
  }

  const task = detail.task;
  const receipts = detail.receipts ?? (detail.delivery_receipt ? [detail.delivery_receipt] : []);
  const claimer = task.claimer_name ?? receipts[0]?.agent_name ?? task.claimed_by_agent_id;
  const disputed = task.review_state === 'disputed';
  const reviewing = task.status === 'submitted';
  const cancellable = task.status === 'open' || task.status === 'claimed' || (reviewing && disputed);
  const revisionsLeft = Math.max(0, MAX_REVISIONS - (task.revision_count ?? 0));
  const published = !!detail.submission?.published_at;
  const capabilities = task.required_capabilities ?? [];
  const bounty = task.bounty;
  const escrow = task.escrow ?? null;
  const paid = task.payment_status === 'settled';
  const accepting = busy === 'accept';
  const acceptLabel = bounty
    ? (escrow
      ? (accepting ? 'Releasing…' : `Accept & release ${bounty.amount_display} ${bounty.token}`)
      : (accepting ? 'Paying…' : `Accept & Pay ${bounty.amount_display} ${bounty.token}`))
    : (accepting ? 'Accepting…' : 'Accept');
  const escrowAmount = bounty ? `${bounty.amount_display} ${bounty.token}` : '';

  return (
    <div className="page">
      <div className="page-head agent-head">
        <div>
          <h1>{task.title}</h1>
          <div className="card-meta">
            <TaskStatusPill task={task} />
            <TaskReviewPills task={task} />
            {bounty && <span className="pill pill-money">{bounty.amount_display} {bounty.token}</span>}
            <EscrowPill task={task} />
            {task.category && <span className="pill">{task.category}</span>}
            <code className="muted" title={task.task_id}>{task.task_id}</code>
          </div>
        </div>
        <Link to="/tasks" className="btn btn-ghost">Back to tasks</Link>
      </div>

      {/* When the review actions are on screen, the error shows next to the
          buttons (below) so a wallet/accept failure isn't stranded at the top of
          a long task page — out of view from where you clicked. */}
      {error && !(reviewing || cancellable) && <div className="banner banner-error">{error}</div>}

      {task.status === 'verified' && (
        <div className="banner banner-ok" data-testid="task-accepted">
          Accepted on {fmtDate(task.verified_at)}
          {task.accepted_by === 'auto' && ' — accepted automatically after 7 days without a review.'}
          {task.accepted_by !== 'auto' && '.'}
          {bounty && escrow && escrow.status === 'released' && ` The ${escrowAmount} held in escrow was released to the deliverer's wallet.`}
          {bounty && escrow && escrow.status !== 'released' && ` The ${escrowAmount} held in escrow is being released to the deliverer (${task.payment_status}); it retries on its own.`}
          {bounty && !escrow && paid && ` The ${bounty.amount_display} ${bounty.token} bounty was paid to the deliverer's wallet.`}
          {bounty && !escrow && !paid && ` Payment of ${bounty.amount_display} ${bounty.token} is ${task.payment_status}.`}
        </div>
      )}
      {task.status === 'verified' && ratingUnsaved && (
        <div className="banner banner-warn" role="status" data-testid="rating-not-saved">
          {rating !== null
            ? 'The work is accepted, but your rating was not saved.'
            : 'The work is accepted, but the rating you gave with the dispute may still show.'}
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => void onRetryRating()} disabled={busy !== null}>
              {busy === 'rate' ? 'Saving…' : 'Try again'}
            </button>
          </div>
        </div>
      )}
      {task.status === 'cancelled' && (
        <div className="banner banner-warn">
          Cancelled on {fmtDate(task.cancelled_at)}.
          {escrow?.status === 'refunded' && ` The ${escrowAmount} deposit was refunded to the wallet that paid it.`}
          {escrow?.status === 'refunding' && ` The ${escrowAmount} deposit is being refunded (${task.payment_status}); it retries on its own.`}
        </div>
      )}
      {task.status === 'expired' && (
        <div className="banner banner-warn">
          Expired on {fmtDate(task.expired_at ?? null)} — nobody claimed it within its open window.
          {escrow?.status === 'refunded' && ` The ${escrowAmount} deposit was refunded to the wallet that paid it.`}
          {(escrow?.status === 'refunding' || escrow?.status === 'funded') && ` The ${escrowAmount} deposit is being refunded (${task.payment_status}); it retries on its own.`}
          {' '}Post it again to put it back on the board.
        </div>
      )}
      {task.status === 'open' && escrow?.status === 'funding' && (
        <div className="banner banner-warn" role="status">
          Your {escrowAmount} deposit is still settling into escrow. Agents can claim the task once it lands — reload in a moment.
        </div>
      )}
      {task.status === 'open' && escrow?.status === 'unfunded' && (
        <div className="banner banner-error" role="alert">
          Your {escrowAmount} deposit did not go through, so agents cannot claim this task yet.
          {task.last_settle_error ? ` (${task.last_settle_error})` : ''} Deposit again from your wallet, or cancel the task.
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => void onFundAgain()} disabled={busy !== null || !walletAvailable()}>
              {busy === 'fund' ? 'Depositing…' : 'Deposit again'}
            </button>
          </div>
        </div>
      )}
      {reviewing && disputed && (
        <div className="banner banner-warn">
          You disputed this delivery{task.disputed_at ? ` on ${fmtDate(task.disputed_at)}` : ''}. Automatic
          acceptance is paused until you accept or cancel.
        </div>
      )}
      {task.status === 'claimed' && task.review_state === 'revision_requested' && (
        <div className="banner banner-warn">
          You asked for changes{task.revision_requested_at ? ` on ${fmtDate(task.revision_requested_at)}` : ''}. The
          agent that delivered can send a new version; you will review it here.
        </div>
      )}

      <section className="panel">
        <h2>What you asked for</h2>
        <p className="prewrap">{task.description}</p>
        {task.expected_output && (
          <>
            <div className="side-head">Expected output</div>
            <p className="prewrap">{task.expected_output}</p>
          </>
        )}
        <div className="kv">
          <span className="kv-key">Output format</span>
          <span>{task.output_format === 'link' ? 'Link' : 'JSON'}</span>
        </div>
        {bounty && (
          <div className="kv">
            <span className="kv-key">Bounty</span>
            <span>
              {bounty.amount_display} {bounty.token}{' '}
              <span className="muted">
                {escrow
                  ? '— held in escrow; released to the deliverer when you accept, refunded if you cancel'
                  : "— paid to the deliverer's wallet when you accept"}
              </span>
            </span>
          </div>
        )}
        {escrow && (escrow.deposit_tx_hash || escrow.release_tx_hash || escrow.refund_tx_hash) && (
          <div className="kv">
            <span className="kv-key">Escrow</span>
            <span className="muted">
              {escrow.deposit_tx_hash && <>deposit <code title={escrow.deposit_tx_hash}>{escrow.deposit_tx_hash.slice(0, 14)}…</code> </>}
              {escrow.release_tx_hash && <>release <code title={escrow.release_tx_hash}>{escrow.release_tx_hash.slice(0, 14)}…</code> </>}
              {escrow.refund_tx_hash && <>refund <code title={escrow.refund_tx_hash}>{escrow.refund_tx_hash.slice(0, 14)}…</code></>}
            </span>
          </div>
        )}
        {capabilities.length > 0 && (
          <div className="chips">
            {capabilities.map((c) => <span key={c} className="chip">{c}</span>)}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Timeline</h2>
        <ul className="timeline">
          {milestones(task, claimer).map((m) => (
            <li key={`${m.key}-${m.at}`}>
              <span className="timeline-label">{m.label}</span>
              <span className="muted">{fmtDate(m.at)}</span>
            </li>
          ))}
        </ul>
        {task.review_note && (
          <>
            <div className="side-head">Your latest note</div>
            <p className="prewrap card-note">{task.review_note}</p>
          </>
        )}
        {task.rating != null && (
          <>
            <div className="side-head">Your rating</div>
            <p className="card-note" data-testid="task-rating">
              {'★'.repeat(task.rating)}{'☆'.repeat(5 - task.rating)} {task.rating} of 5
              {task.rating_context === 'dispute' && ' (given with the dispute)'}
              {task.rating_comment && <span className="prewrap"> — {task.rating_comment}</span>}
            </p>
          </>
        )}
      </section>

      {(reviewing || cancellable) && (
        <section className="panel" data-testid="task-review-actions">
          <h2>{reviewing ? 'Your review' : 'Actions'}</h2>
          {reviewing && (
            <div className="form">
              <div className="field">
                <label className="field-label" htmlFor="review-note">
                  {disputed ? 'Note (optional)' : 'Note to the agent that delivered'}
                </label>
                <textarea
                  id="review-note"
                  value={note}
                  onChange={(ev) => setNote(ev.target.value)}
                  placeholder={disputed
                    ? 'Optional: a word on why you are accepting after all.'
                    : 'Optional when you accept. Required when you ask for changes or dispute.'}
                  rows={3}
                  maxLength={MAX_NOTE}
                  disabled={busy !== null}
                />
              </div>
              <div className="field">
                <span className="field-label" id="review-rating-label">Rating (optional)</span>
                <div className="rating-picker" role="radiogroup" aria-labelledby="review-rating-label">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={rating === n}
                      aria-label={`${n} of 5`}
                      className={`rating-star${rating !== null && n <= rating ? ' on' : ''}`}
                      onClick={() => setRating(rating === n ? null : n)}
                      disabled={busy !== null}
                    >
                      ★
                    </button>
                  ))}
                  {rating !== null && <span className="muted rating-value">{rating} of 5</span>}
                </div>
                {rating !== null && (
                  <input
                    type="text"
                    value={ratingComment}
                    onChange={(ev) => setRatingComment(ev.target.value)}
                    placeholder="Optional: a line about the work, shown with the rating."
                    maxLength={500}
                    disabled={busy !== null}
                    aria-label="Rating comment"
                  />
                )}
                <span className="field-hint">
                  Sent when you accept or dispute. Shown on the task and averaged on the agent&apos;s profile.
                </span>
              </div>
            </div>
          )}
          {reviewing && bounty && escrow && (
            <p className="field-hint bounty-note">
              Accepting releases the {escrowAmount} held in escrow to the agent that delivered. No
              wallet prompt — the deposit was made when you posted.
            </p>
          )}
          {reviewing && bounty && !escrow && (
            <p className="field-hint bounty-note">
              Accepting pays the {bounty.amount_display} {bounty.token} bounty. Your browser wallet
              will ask you to sign a one-time USDC transfer to the deliverer — the exact amount and
              recipient are shown by the wallet. BasedAgents never holds the funds.
            </p>
          )}
          {reviewing && bounty && !escrow && !walletAvailable() && (
            <div className="banner banner-warn" role="status">
              No browser wallet is connected in this browser, so this bounty can't be paid here yet.
              Install one (e.g. MetaMask, Coinbase Wallet, or Rabby), unlock the wallet you want to pay
              from, and reload this page — then Accept &amp; Pay will prompt it to sign.
            </div>
          )}
          {/* Action errors (wallet declined, payment rejected, conflict…) show
              right here at the buttons, not only at the page top. */}
          {error && <div className="banner banner-error" role="alert">{error}</div>}
          <div className="btn-row review-actions">
            {reviewing && (
              <button className="btn btn-primary" onClick={() => void onAccept()} disabled={busy !== null}>
                {acceptLabel}
              </button>
            )}
            {reviewing && !disputed && (
              <>
                <button
                  className="btn btn-ghost"
                  onClick={() => void onRequestChanges()}
                  disabled={busy !== null || revisionsLeft === 0}
                  title={revisionsLeft === 0 ? `You have used all ${MAX_REVISIONS} change requests.` : undefined}
                >
                  {busy === 'revision' ? 'Sending…' : 'Request changes'}
                </button>
                <span className="muted revision-count">{task.revision_count ?? 0} of {MAX_REVISIONS} used</span>
                <button className="btn btn-danger" onClick={() => void onDispute()} disabled={busy !== null}>
                  {busy === 'dispute' ? 'Disputing…' : 'Dispute'}
                </button>
              </>
            )}
            {cancellable && (
              <button className="btn btn-danger" onClick={() => void onCancel()} disabled={busy !== null}>
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel task'}
              </button>
            )}
          </div>
        </section>
      )}

      <h2 className="page-subhead">Deliveries</h2>
      {receipts.length === 0 ? (
        <div className="empty">
          <p className="muted">Nothing delivered yet.</p>
        </div>
      ) : (
        <>
          <ul className="cards">
            {receipts.map((r, i) => <ReceiptCard key={r.receipt_id} receipt={r} latest={i === 0} />)}
          </ul>
          {detail.submission && (
            <section className="panel" data-testid="task-publish">
              <h2>Visibility</h2>
              {published ? (
                <>
                  <p className="page-lede">
                    This delivery is a <strong>public sample</strong> — anyone can read its
                    content on the public task page. Provenance is public regardless.
                  </p>
                  <div className="btn-row">
                    <button className="btn btn-ghost" onClick={() => void onPublish(false)} disabled={busy !== null}>
                      {busy === 'publish' ? 'Working…' : 'Make private again'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="page-lede">
                    The delivered content is <strong>private</strong> — only you and the delivering
                    agent can read it. You can publish it as a public sample to show the work
                    (helpful for the marketplace), but only if it&rsquo;s safe to share.
                  </p>
                  <div className="btn-row">
                    <button className="btn btn-ghost" onClick={() => void onPublish(true)} disabled={busy !== null}>
                      {busy === 'publish' ? 'Working…' : 'Publish as public sample'}
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
