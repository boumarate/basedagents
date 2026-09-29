/**
 * Small shared pieces for the task pages (/tasks, /tasks/new, /tasks/:taskId):
 * the status pill, the review-state pills, date formatting, and the friendly
 * error text for the task endpoints' 409/429 codes.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { ControlApiError } from '../api/control.js';
import type { EscrowStatus, OwnerTask } from '../api/types.js';

export const MAX_REVISIONS = 3;

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Task descriptions are Markdown written for the task page; a list card only
 * gets a short plain-text excerpt. Drop the syntax that reads as noise in a
 * card (fences, markers, link targets), collapse whitespace, cut on a word.
 */
export function mdExcerpt(md: string, max = 280): string {
  const text = md
    .replace(/```[\s\S]*?(?:```|$)/g, ' ') // fenced code blocks
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading marks
    .replace(/^\s{0,3}>\s?/gm, '') // blockquote marks
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '') // list markers
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ') // horizontal rules
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*\n]+)\*/g, '$1') // italic
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

/** Human words for a task's lifecycle state (the pill next to its title). */
export function statusLabel(task: Pick<OwnerTask, 'status' | 'review_state'>): { text: string; cls: string } {
  switch (task.status) {
    case 'open':
      return { text: 'Open', cls: 'status' };
    case 'claimed':
      return { text: 'In progress', cls: 'status' };
    case 'submitted':
      return { text: 'Delivered', cls: 'status status-review' };
    case 'verified':
      return { text: 'Accepted', cls: 'status status-approved' };
    case 'cancelled':
      return { text: 'Cancelled', cls: 'status status-denied' };
    case 'closed':
      return { text: 'Closed', cls: 'status' };
    default:
      return { text: String(task.status), cls: 'status' };
  }
}

export function TaskStatusPill({ task }: { task: Pick<OwnerTask, 'status' | 'review_state'> }) {
  const { text, cls } = statusLabel(task);
  return <span className={cls}>{text}</span>;
}

/** Human words for where an escrowed bounty is. */
export function escrowLabel(status: EscrowStatus): string {
  switch (status) {
    case 'funding': return 'Deposit settling';
    case 'unfunded': return 'Deposit failed';
    case 'funded': return 'In escrow';
    case 'releasing': return 'Releasing';
    case 'released': return 'Released';
    case 'refunding': return 'Refunding';
    case 'refunded': return 'Refunded';
    default: return String(status);
  }
}

/** The escrow pill, when the task holds its bounty in escrow. */
export function EscrowPill({ task }: { task: Pick<OwnerTask, 'escrow'> }) {
  const e = task.escrow;
  if (!e) return null;
  const warn = e.status === 'unfunded';
  return <span className={warn ? 'pill pill-warn' : 'pill'}>{escrowLabel(e.status)}</span>;
}

/** The review-state pills: changes requested, disputed, accepted automatically. */
export function TaskReviewPills({ task }: { task: Pick<OwnerTask, 'review_state' | 'accepted_by' | 'status'> }) {
  return (
    <>
      {task.review_state === 'revision_requested' && <span className="pill">Changes requested</span>}
      {task.review_state === 'disputed' && <span className="pill pill-warn">Disputed</span>}
      {task.status === 'verified' && task.accepted_by === 'auto' && (
        <span className="pill" title="Nobody reviewed it within 7 days, so it was accepted for you.">
          Accepted automatically
        </span>
      )}
    </>
  );
}

/**
 * Error copy for the task endpoints. Known 409/429 codes get a sentence that
 * says what to do next; anything else falls back to the server's message.
 */
export function taskErrText(err: unknown): string {
  if (err instanceof ControlApiError) {
    switch (err.code) {
      case 'rate_limited':
        return 'Too many tasks in the last hour.';
      case 'invalid_state':
      case 'conflict':
        return 'This task changed since you loaded it — reloading.';
      case 'max_revisions':
        return `You have already asked for changes ${MAX_REVISIONS} times. Accept, dispute, or cancel this task.`;
      case 'dispute_first':
        return 'A delivered task cannot be cancelled outright. Dispute it first, or accept it.';
      case 'already_accepted':
        return 'This task was already accepted.';
      case 'already_disputed':
        return 'This task is already disputed.';
      case 'payments_unavailable':
        return 'Bounties are not enabled on this registry yet. Post this task without a bounty.';
      case 'payee_wallet_missing':
        return 'The agent that delivered has no wallet on record, so the bounty cannot be paid.';
      case 'insufficient_funds':
        return 'Your wallet does not hold enough USDC to pay this bounty.';
      case 'facilitator_unavailable':
        return 'The payment service is briefly unavailable. Nothing was charged — try again in a moment.';
      case 'payment_invalid':
      case 'payment_malformed':
        return 'The signed payment did not match this task. Nothing was charged — reload and try again.';
      case 'authorization_reused':
        return 'That wallet signature was already used. Reload and sign a fresh one.';
      case 'settlement_in_progress':
        return 'A previous payment for this task is still settling. Give it a moment, then reload.';
      case 'bounty_unsupported_network':
        return 'This bounty is on a network the registry cannot settle. Contact support.';
      case 'escrow_unavailable':
        return 'Holding the bounty in escrow is not available right now. Post it without escrow, or without a bounty.';
      case 'escrow_not_funded':
        return 'The bounty deposit has not settled yet, so this task cannot be claimed.';
      case 'payment_required':
        return 'Your wallet needs to sign the deposit first — reload and try again.';
      default:
        return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True for the codes that mean "your view is stale" — reload after showing them. */
export function isStaleError(err: unknown): boolean {
  return err instanceof ControlApiError && (err.code === 'invalid_state' || err.code === 'conflict');
}
