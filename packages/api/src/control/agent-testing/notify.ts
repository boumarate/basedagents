/**
 * Agent Testing — transactional notifications (spec §16).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * Every notification is queued under a SEMANTIC KEY (INSERT OR IGNORE), so
 * webhook retries and job re-runs never email the same event twice. Delivery
 * happens in the jobs runner through the shared EmailSender. Emails carry
 * links that still require the owner session — a report URL alone grants
 * nothing. Bodies never include report contents or magic links.
 */
import type { DBAdapter } from '../../db/adapter.js';
import type { EmailSender } from '../email.js';
import { consoleOrigin } from '../email.js';
import { ControlStore } from '../store.js';
import { TestingStore } from './store.js';
import { testingEnv } from './catalog.js';

/** Where operator alerts go; unset → alerts stay queued in the console only. */
export function operatorAlertEmail(env: unknown): string | null {
  const e = testingEnv(env);
  return e.TESTING_OPERATOR_EMAIL || e.TESTING_SUPPORT_EMAIL || null;
}

export async function queueCustomerNotification(
  db: DBAdapter,
  store: TestingStore,
  env: unknown,
  input: { semanticKey: string; kind: string; orderId: string | null; ownerId: string; subject: string; body: string; path?: string },
): Promise<void> {
  const owner = await new ControlStore(db).getOwner(input.ownerId);
  if (!owner?.email) return; // buyer accounts are created via verified email; absent = nothing to send
  // Deep-link to the page the email is about; `/testing/orders` without an id
  // is NOT a route (the console's catch-all would dump the reader on /home),
  // so the no-order fallback is the audits list.
  const link = `${consoleOrigin(env)}${input.path ?? (input.orderId ? `/testing/orders/${input.orderId}` : '/testing')}`;
  await store.queueNotification({
    semanticKey: input.semanticKey,
    kind: input.kind,
    recipient: owner.email,
    orderId: input.orderId,
    subject: input.subject,
    body: `${input.body}\n\nSign in to view: ${link}\n\n— BasedAgents Testing`,
  });
}

export async function queueOperatorNotification(
  store: TestingStore,
  env: unknown,
  input: { semanticKey: string; kind: string; orderId: string | null; subject: string; body: string },
): Promise<void> {
  const to = operatorAlertEmail(env);
  if (!to) return;
  const link = `${consoleOrigin(env)}/testing/admin`;
  await store.queueNotification({
    semanticKey: input.semanticKey,
    kind: input.kind,
    recipient: to,
    orderId: input.orderId,
    subject: `[testing-ops] ${input.subject}`,
    body: `${input.body}\n\nOperator queue: ${link}`,
  });
}

/** Deliver due notifications (jobs runner). Failures back off per row. */
export async function sendDueNotifications(
  db: DBAdapter,
  sender: EmailSender,
  nowIso: string,
  limit = 25,
): Promise<{ sent: number; failed: number }> {
  const store = new TestingStore(db);
  const due = await store.notificationsDue(nowIso, limit);
  let sent = 0;
  let failed = 0;
  for (const n of due) {
    try {
      await sender.send({ to: n.recipient, subject: n.subject, text: n.body });
      await store.notificationSent(n.semantic_key);
      sent++;
    } catch (err) {
      await store.notificationFailed(n.semantic_key, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }
  return { sent, failed };
}
