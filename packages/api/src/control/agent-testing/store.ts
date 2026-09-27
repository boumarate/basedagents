/**
 * Agent Testing — persistence. Every state transition is an atomic
 * conditional write (`UPDATE … WHERE <expected state>` / guarded
 * `INSERT … SELECT … WHERE`), compatible with both SQLite and D1: the
 * change count is the gate, reads before it only shape errors.
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * Money: USD cents as INTEGER columns; USDC atomic amounts as digit strings
 * (validated at the boundary, summed via CAST — every value fits in 64 bits).
 */
import type { DBAdapter } from '../../db/adapter.js';
import { generatePublicId } from '../../lib/ids.js';

const nowIso = () => new Date().toISOString();

/** Digit-string USDC atomic amount (6 dp), bounded far below 2^53. */
export function isAtomicAmount(v: string): boolean {
  return /^[0-9]{1,15}$/.test(v);
}

export function assertAtomic(v: string, label: string): string {
  if (!isAtomicAmount(v)) throw new Error(`${label} must be a digit string of USDC atomic units`);
  return v;
}

// ─── row types ───

export interface RequestRow {
  id: string; owner_id: string; intake_json: string; status: string; version: number;
  operator_note: string | null; source: string; previous_order_id: string | null;
  created_at: string; updated_at: string;
}

export interface IntakeInboxRow {
  id: string; email: string; request_id: string; intake_json: string; status: string;
  claimed_owner_id: string | null; created_at: string; updated_at: string; expires_at: string;
}

export interface QuoteRow {
  id: string; request_id: string; request_version: number; scope_json: string; scope_hash: string;
  package_key: string; package_version: number; stripe_price_id: string | null;
  subtotal_cents: number; currency: string; tax_mode: string;
  worker_cap_usdc_atomic: string; worker_bounty_usdc_atomic: string;
  external_run_slots: number; retest_slots: number; retest_window_days: number; min_operator_groups: number;
  terms_version: string; disclosure_version: string; delivery_target_at: string; expires_at: string;
  status: string; approved_by: string | null; approve_assertion_id: string | null; approved_at: string | null;
  created_at: string; updated_at: string;
}

export interface OrderRow {
  id: string; owner_id: string; quote_id: string; request_id: string; source: string;
  payment_state: string; refund_state: string; dispute_state: string; fulfillment_state: string;
  paused_from_state: string | null; risk_hold: number;
  cancel_requested_at: string | null; cancel_request_reason: string | null;
  collected_cents: number; tax_cents: number; refunded_cents: number;
  initial_report_id: string | null; initial_report_published_at: string | null; retest_deadline_at: string | null;
  previous_order_id: string | null; version: number; created_at: string; updated_at: string;
}

export interface CheckoutAttemptRow {
  id: string; order_id: string; attempt: number; operation_key: string;
  stripe_session_id: string | null; stripe_payment_intent_id: string | null; state: string;
  quoted_subtotal_cents: number; quoted_currency: string;
  confirmed_subtotal_cents: number | null; confirmed_tax_cents: number | null;
  confirmed_total_cents: number | null; confirmed_currency: string | null;
  checkout_url: string | null; livemode: number | null; last_error: string | null;
  reconciled_at: string | null; created_at: string; updated_at: string;
}

export interface RunRow {
  id: string; order_id: string; kind: 'baseline' | 'external' | 'retest'; slot: number;
  scope_hash: string; environment_json: string; result_state: string;
  operator_group_id: string | null; environment_observed_json: string | null;
  reviewed_result_json: string | null; environment_demonstrated: number | null; slot_satisfied: number | null;
  reviewed_by: string | null; reviewed_at: string | null; review_assertion_id: string | null;
  parent_finding_id: string | null; parent_run_id: string | null;
  version: number; created_at: string; updated_at: string;
}

export interface RunAttemptRow {
  id: string; run_id: string; attempt: number; task_id: string | null; publication_ref: string;
  agent_id: string | null; brief_revision: number; brief_json: string; reservation_id: string | null;
  state: string; active: number; task_status_mirror: string | null; payment_status_mirror: string | null;
  result_json: string | null; result_receipt_id: string | null; result_valid: number | null;
  result_invalid_reason: string | null; evidence_hashes_json: string | null; last_error: string | null;
  created_at: string; updated_at: string;
}

export interface EligibilityRow {
  agent_id: string; operator_group_id: string; group_confidence: string;
  capabilities_json: string; environments_json: string; evidence_refs_json: string | null;
  provenance: string; status: string; reviewed_by: string | null; reviewed_at: string;
  expires_at: string | null; notes: string | null; created_at: string; updated_at: string;
}

export interface ReservationRow {
  id: string; order_id: string; operation_ref: string; purpose: string; amount_atomic: string;
  state: string; attempt_id: string | null; payment_ref: string | null; created_at: string; updated_at: string;
}

export interface ReportRow {
  id: string; order_id: string; version: number; report_json: string; scope_hash: string; source_hash: string;
  status: string; approved_by: string | null; approve_assertion_id: string | null; published_at: string | null;
  created_at: string; updated_at: string;
}

export interface InboxRow {
  event_id: string; event_type: string; payload_json: string; payload_hash: string; livemode: number;
  state: string; attempts: number; lease_expires_at: string | null; next_attempt_at: string | null;
  last_error: string | null; received_at: string; processed_at: string | null;
}

export interface OperationRow {
  id: string; kind: string; semantic_key: string; order_id: string | null; payload_json: string;
  state: string; attempts: number; lease_expires_at: string | null; next_attempt_at: string | null;
  last_error: string | null; result_json: string | null; created_at: string; updated_at: string;
}

export interface NotificationRow {
  semantic_key: string; kind: string; recipient: string; order_id: string | null;
  subject: string; body: string; state: string; attempts: number; next_attempt_at: string | null;
  last_error: string | null; created_at: string; sent_at: string | null;
}

// Reservation states that count toward the commitment (spec §10.3): everything
// not confirmed returned. `released` is the only state outside the sum.
const COMMITTED_STATES = `('reserved','committed','settled','release_pending')`;

export class TestingStore {
  constructor(private db: DBAdapter) {}

  // ─── audit + metrics ───

  async audit(input: {
    actor: string; action: string; objectKind: string; objectId: string;
    beforeVersion?: number | null; afterVersion?: number | null; reason?: string | null;
    detailHash?: string | null; assertionId?: string | null;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO testing_audit_log (id, actor, action, object_kind, object_id, before_version, after_version, reason, detail_hash, assertion_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      generatePublicId('taud'), input.actor, input.action, input.objectKind, input.objectId,
      input.beforeVersion ?? null, input.afterVersion ?? null, input.reason ?? null,
      input.detailHash ?? null, input.assertionId ?? null, nowIso(),
    );
  }

  /** First-party product event — never workflow contents (spec §18). */
  async metricEvent(event: string, refs: { orderId?: string | null; requestId?: string | null } = {}): Promise<void> {
    try {
      await this.db.run(
        'INSERT INTO testing_metric_events (event, order_id, request_id, created_at) VALUES (?, ?, ?, ?)',
        event, refs.orderId ?? null, refs.requestId ?? null, nowIso(),
      );
    } catch {
      // telemetry only
    }
  }

  // ─── requests ───

  async createRequest(input: { ownerId: string; intakeJson: string; source?: string; previousOrderId?: string | null }): Promise<RequestRow> {
    const id = generatePublicId('treq');
    const now = nowIso();
    await this.db.run(
      `INSERT INTO testing_requests (id, owner_id, intake_json, status, version, source, previous_order_id, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?)`,
      id, input.ownerId, input.intakeJson, input.source ?? 'external_customer', input.previousOrderId ?? null, now, now,
    );
    return (await this.getRequest(id))!;
  }

  async getRequest(id: string): Promise<RequestRow | null> {
    return this.db.get<RequestRow>('SELECT * FROM testing_requests WHERE id = ?', id);
  }

  async getOwnRequest(id: string, ownerId: string): Promise<RequestRow | null> {
    return this.db.get<RequestRow>('SELECT * FROM testing_requests WHERE id = ? AND owner_id = ?', id, ownerId);
  }

  async listRequestsByOwner(ownerId: string, limit = 50): Promise<RequestRow[]> {
    return this.db.all<RequestRow>(
      'SELECT * FROM testing_requests WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?', ownerId, limit,
    );
  }

  async listRequestsByStatus(status: string, limit = 100): Promise<RequestRow[]> {
    return this.db.all<RequestRow>(
      'SELECT * FROM testing_requests WHERE status = ? ORDER BY updated_at ASC LIMIT ?', status, limit,
    );
  }

  /** Version-guarded draft edit; editing from needs_changes returns it to draft. */
  async updateRequestIntake(id: string, ownerId: string, expectedVersion: number, intakeJson: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_requests SET intake_json = ?, version = version + 1, status = 'draft', updated_at = ?
       WHERE id = ? AND owner_id = ? AND version = ? AND status IN ('draft','needs_changes')`,
      intakeJson, nowIso(), id, ownerId, expectedVersion,
    );
    return res.changes === 1;
  }

  /** request: draft → submitted (customer). */
  async submitRequest(id: string, ownerId: string, expectedVersion: number): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_requests SET status = 'submitted', updated_at = ? WHERE id = ? AND owner_id = ? AND version = ? AND status = 'draft'`,
      nowIso(), id, ownerId, expectedVersion,
    );
    return res.changes === 1;
  }

  /** request: submitted → needs_changes | declined (operator). */
  async setRequestDecision(id: string, to: 'needs_changes' | 'declined', note: string | null): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_requests SET status = ?, operator_note = ?, updated_at = ? WHERE id = ? AND status = 'submitted'`,
      to, note, nowIso(), id,
    );
    return res.changes === 1;
  }

  /** Tag an order/request as founder/test work (excluded from external demand metrics). */
  async setRequestSource(id: string, source: 'external_customer' | 'founder_sample' | 'test_fixture'): Promise<boolean> {
    const res = await this.db.run('UPDATE testing_requests SET source = ?, updated_at = ? WHERE id = ?', source, nowIso(), id);
    return res.changes === 1;
  }

  // ─── public intake inbox (migration 0043) ───
  //
  // Pre-authentication submissions. A row here is owned by nobody: it becomes
  // a real request only at ADOPTION, after the submitter's email is verified
  // by a sign-in. The request id is pre-minted at submission so adoption is
  // idempotent (INSERT OR IGNORE) under concurrent list calls and retries.

  async createInboxSubmission(input: { email: string; intakeJson: string; ttlDays: number }): Promise<{ id: string; requestId: string }> {
    const id = generatePublicId('tinb');
    const requestId = generatePublicId('treq');
    const now = new Date();
    await this.db.run(
      `INSERT INTO testing_intake_inbox (id, email, request_id, intake_json, status, claimed_owner_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      id, input.email, requestId, input.intakeJson, now.toISOString(), now.toISOString(),
      new Date(now.getTime() + input.ttlDays * 86_400_000).toISOString(),
    );
    return { id, requestId };
  }

  async countPendingInboxByEmail(email: string, now: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM testing_intake_inbox WHERE email = ? AND status = 'pending' AND expires_at > ?`,
      email, now,
    );
    return row?.n ?? 0;
  }

  async countPendingInbox(now: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM testing_intake_inbox WHERE status = 'pending' AND expires_at > ?`, now,
    );
    return row?.n ?? 0;
  }

  async listPendingInboxByEmail(email: string, now: string): Promise<IntakeInboxRow[]> {
    return this.db.all<IntakeInboxRow>(
      `SELECT * FROM testing_intake_inbox WHERE email = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at ASC LIMIT 10`,
      email, now,
    );
  }

  /**
   * Adopt one verified inbox row into a real 'submitted' request owned by
   * `ownerId`. Returns true when THIS call created the request (drives the
   * one-time operator alert); the claim UPDATE afterwards is idempotent, and
   * a crash between the two heals on the next adoption pass.
   */
  async adoptInboxRow(row: IntakeInboxRow, ownerId: string, now: string): Promise<boolean> {
    const ins = await this.db.run(
      `INSERT OR IGNORE INTO testing_requests (id, owner_id, intake_json, status, version, source, previous_order_id, created_at, updated_at)
       VALUES (?, ?, ?, 'submitted', 1, 'external_customer', NULL, ?, ?)`,
      row.request_id, ownerId, row.intake_json, row.created_at, now,
    );
    await this.db.run(
      `UPDATE testing_intake_inbox SET status = 'claimed', claimed_owner_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      ownerId, now, row.id,
    );
    return ins.changes === 1;
  }

  /** Jobs sweep: pending rows past their TTL flip to 'expired' (never adopted). */
  async expireInboxRows(now: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE testing_intake_inbox SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?`,
      now, now,
    );
    return res.changes;
  }

  // ─── quotes ───

  /**
   * Approve a quote for one exact request version: request must still be
   * `submitted` at that version. Both writes (quote insert + request →
   * quoted) commit atomically; the UNIQUE (request_id, request_version)
   * makes a duplicate approval a no-op conflict.
   */
  async approveQuote(input: {
    requestId: string; requestVersion: number; scopeJson: string; scopeHash: string;
    packageKey: string; packageVersion: number; stripePriceId: string | null;
    subtotalCents: number; currency: string; taxMode: string;
    workerCapAtomic: string; workerBountyAtomic: string;
    externalRunSlots: number; retestSlots: number; retestWindowDays: number; minOperatorGroups: number;
    termsVersion: string; disclosureVersion: string; deliveryTargetAt: string; expiresAt: string;
    approvedBy: string; assertionId: string | null;
  }): Promise<QuoteRow | null> {
    assertAtomic(input.workerCapAtomic, 'worker cap');
    assertAtomic(input.workerBountyAtomic, 'worker bounty');
    const id = generatePublicId('tquo');
    const now = nowIso();
    const [gate] = await this.db.batch([
      {
        sql: `UPDATE testing_requests SET status = 'quoted', updated_at = ? WHERE id = ? AND version = ? AND status = 'submitted'`,
        params: [now, input.requestId, input.requestVersion],
      },
      {
        sql: `INSERT INTO testing_quotes
            (id, request_id, request_version, scope_json, scope_hash, package_key, package_version, stripe_price_id,
             subtotal_cents, currency, tax_mode, worker_cap_usdc_atomic, worker_bounty_usdc_atomic,
             external_run_slots, retest_slots, retest_window_days, min_operator_groups,
             terms_version, disclosure_version, delivery_target_at, expires_at,
             status, approved_by, approve_assertion_id, approved_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?
          WHERE changes() = 1`,
        params: [
          id, input.requestId, input.requestVersion, input.scopeJson, input.scopeHash,
          input.packageKey, input.packageVersion, input.stripePriceId,
          input.subtotalCents, input.currency, input.taxMode, input.workerCapAtomic, input.workerBountyAtomic,
          input.externalRunSlots, input.retestSlots, input.retestWindowDays, input.minOperatorGroups,
          input.termsVersion, input.disclosureVersion, input.deliveryTargetAt, input.expiresAt,
          input.approvedBy, input.assertionId, now, now, now,
        ],
      },
    ]);
    if (gate.changes !== 1) return null;
    return this.getQuote(id);
  }

  async getQuote(id: string): Promise<QuoteRow | null> {
    return this.db.get<QuoteRow>('SELECT * FROM testing_quotes WHERE id = ?', id);
  }

  async getQuoteForRequest(requestId: string): Promise<QuoteRow | null> {
    return this.db.get<QuoteRow>(
      'SELECT * FROM testing_quotes WHERE request_id = ? ORDER BY request_version DESC LIMIT 1', requestId,
    );
  }

  /** quote: approved → superseded|withdrawn|expired (+ request back to needs_changes for change requests). */
  async supersedeQuote(id: string, to: 'superseded' | 'withdrawn' | 'expired'): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_quotes SET status = ?, updated_at = ? WHERE id = ? AND status = 'approved'`,
      to, nowIso(), id,
    );
    return res.changes === 1;
  }

  async expireQuotes(now: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE testing_quotes SET status = 'expired', updated_at = ? WHERE status = 'approved' AND expires_at <= ?`,
      now, now,
    );
    return res.changes;
  }

  // ─── orders + checkout attempts ───

  /**
   * Accept a quote and create its ONE order, atomically: quote approved →
   * accepted gated on unexpired, order insert guarded by that gate; the
   * UNIQUE(quote_id) makes replays converge on the existing order.
   */
  async createOrderForQuote(input: {
    quote: QuoteRow; ownerId: string; source: string; previousOrderId?: string | null;
  }): Promise<OrderRow | null> {
    const existing = await this.getOrderByQuote(input.quote.id);
    if (existing) return existing;
    const id = generatePublicId('tord');
    const now = nowIso();
    const [gate] = await this.db.batch([
      {
        sql: `UPDATE testing_quotes SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'approved' AND expires_at > ?`,
        params: [now, input.quote.id, now],
      },
      {
        sql: `INSERT INTO testing_orders (id, owner_id, quote_id, request_id, source, previous_order_id, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        params: [id, input.ownerId, input.quote.id, input.quote.request_id, input.source, input.previousOrderId ?? null, now, now],
      },
    ]);
    if (gate.changes !== 1) return this.getOrderByQuote(input.quote.id);
    return this.getOrder(id);
  }

  async getOrder(id: string): Promise<OrderRow | null> {
    return this.db.get<OrderRow>('SELECT * FROM testing_orders WHERE id = ?', id);
  }

  async getOwnOrder(id: string, ownerId: string): Promise<OrderRow | null> {
    return this.db.get<OrderRow>('SELECT * FROM testing_orders WHERE id = ? AND owner_id = ?', id, ownerId);
  }

  async getOrderByQuote(quoteId: string): Promise<OrderRow | null> {
    return this.db.get<OrderRow>('SELECT * FROM testing_orders WHERE quote_id = ?', quoteId);
  }

  async listOrdersByOwner(ownerId: string, limit = 50, before?: string): Promise<OrderRow[]> {
    if (before) {
      return this.db.all<OrderRow>(
        'SELECT * FROM testing_orders WHERE owner_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
        ownerId, before, limit,
      );
    }
    return this.db.all<OrderRow>(
      'SELECT * FROM testing_orders WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?', ownerId, limit,
    );
  }

  async listOrdersByFulfillment(states: string[], limit = 200): Promise<OrderRow[]> {
    const marks = states.map(() => '?').join(',');
    return this.db.all<OrderRow>(
      `SELECT * FROM testing_orders WHERE fulfillment_state IN (${marks}) ORDER BY updated_at ASC LIMIT ?`,
      ...states, limit,
    );
  }

  async countActivePaidOrders(): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM testing_orders WHERE payment_state = 'succeeded'
        AND fulfillment_state NOT IN ('delivered','cancelled','cannot_fulfill')`,
    );
    return row?.n ?? 0;
  }

  async createCheckoutAttempt(input: {
    orderId: string; operationKey: string; quotedSubtotalCents: number; quotedCurrency: string;
  }): Promise<CheckoutAttemptRow | null> {
    const existing = await this.getCheckoutAttemptByOperationKey(input.operationKey);
    if (existing) return existing;
    const id = generatePublicId('tchk');
    const now = nowIso();
    try {
      const res = await this.db.run(
        `INSERT INTO testing_checkout_attempts (id, order_id, attempt, operation_key, state, quoted_subtotal_cents, quoted_currency, created_at, updated_at)
         SELECT ?, ?, COALESCE((SELECT MAX(attempt) FROM testing_checkout_attempts WHERE order_id = ?), 0) + 1, ?, 'creating', ?, ?, ?, ?`,
        id, input.orderId, input.orderId, input.operationKey, input.quotedSubtotalCents, input.quotedCurrency, now, now,
      );
      if (res.changes !== 1) return null;
    } catch {
      // Lost the UNIQUE(operation_key) race — return the winner.
      return this.getCheckoutAttemptByOperationKey(input.operationKey);
    }
    return this.db.get<CheckoutAttemptRow>('SELECT * FROM testing_checkout_attempts WHERE id = ?', id);
  }

  async getCheckoutAttempt(id: string): Promise<CheckoutAttemptRow | null> {
    return this.db.get<CheckoutAttemptRow>('SELECT * FROM testing_checkout_attempts WHERE id = ?', id);
  }

  async getCheckoutAttemptByOperationKey(key: string): Promise<CheckoutAttemptRow | null> {
    return this.db.get<CheckoutAttemptRow>('SELECT * FROM testing_checkout_attempts WHERE operation_key = ?', key);
  }

  async getCheckoutAttemptBySession(sessionId: string): Promise<CheckoutAttemptRow | null> {
    return this.db.get<CheckoutAttemptRow>('SELECT * FROM testing_checkout_attempts WHERE stripe_session_id = ?', sessionId);
  }

  async getCheckoutAttemptByPaymentIntent(pi: string): Promise<CheckoutAttemptRow | null> {
    return this.db.get<CheckoutAttemptRow>('SELECT * FROM testing_checkout_attempts WHERE stripe_payment_intent_id = ?', pi);
  }

  async listCheckoutAttempts(orderId: string): Promise<CheckoutAttemptRow[]> {
    return this.db.all<CheckoutAttemptRow>(
      'SELECT * FROM testing_checkout_attempts WHERE order_id = ? ORDER BY attempt ASC', orderId,
    );
  }

  /** Store the created Stripe session on a `creating` attempt (creating → open). */
  async attachStripeSession(attemptId: string, sessionId: string, url: string | null, livemode: boolean): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_checkout_attempts SET stripe_session_id = ?, checkout_url = ?, livemode = ?, state = 'open', updated_at = ?
       WHERE id = ? AND state = 'creating' AND stripe_session_id IS NULL`,
      sessionId, url, livemode ? 1 : 0, nowIso(), attemptId,
    );
    return res.changes === 1;
  }

  async failCheckoutAttempt(attemptId: string, error: string, from: string[] = ['creating', 'open']): Promise<boolean> {
    const marks = from.map(() => '?').join(',');
    const res = await this.db.run(
      `UPDATE testing_checkout_attempts SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND state IN (${marks})`,
      error.slice(0, 500), nowIso(), attemptId, ...from,
    );
    return res.changes === 1;
  }

  async expireCheckoutAttempt(attemptId: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_checkout_attempts SET state = 'expired', updated_at = ? WHERE id = ? AND state IN ('creating','open')`,
      nowIso(), attemptId,
    );
    return res.changes === 1;
  }

  /**
   * Record a verified successful payment on the attempt (→ completed) with the
   * processor-confirmed amounts. Guarded so an out-of-order failure/expiry
   * can never overwrite it later, and a second success can never re-complete.
   */
  async completeCheckoutAttempt(input: {
    attemptId: string; paymentIntentId: string | null;
    subtotalCents: number; taxCents: number; totalCents: number; currency: string; livemode: boolean;
  }): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_checkout_attempts SET state = 'completed', stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
         confirmed_subtotal_cents = ?, confirmed_tax_cents = ?, confirmed_total_cents = ?, confirmed_currency = ?, livemode = ?, updated_at = ?
       WHERE id = ? AND state IN ('creating','open','expired','failed')`,
      input.paymentIntentId, input.subtotalCents, input.taxCents, input.totalCents, input.currency,
      input.livemode ? 1 : 0, nowIso(), input.attemptId,
    );
    return res.changes === 1;
  }

  async markCheckoutNeedsReconciliation(attemptId: string, error: string): Promise<void> {
    await this.db.run(
      `UPDATE testing_checkout_attempts SET state = 'needs_reconciliation', last_error = ?, updated_at = ? WHERE id = ?`,
      error.slice(0, 500), nowIso(), attemptId,
    );
  }

  // ─── order billing state transitions (each independent + guarded) ───

  /** payment: unpaid|processing|failed → succeeded. A second success returns false (reconciliation). */
  async orderPaymentSucceeded(orderId: string, collectedCents: number, taxCents: number): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_orders SET payment_state = 'succeeded', collected_cents = ?, tax_cents = ?,
         fulfillment_state = CASE WHEN fulfillment_state = 'awaiting_payment' THEN 'ready' ELSE fulfillment_state END,
         updated_at = ?
       WHERE id = ? AND payment_state IN ('unpaid','processing','failed')`,
      collectedCents, taxCents, nowIso(), orderId,
    );
    return res.changes === 1;
  }

  /** payment: unpaid|processing → failed. Never demotes succeeded. */
  async orderPaymentFailed(orderId: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_orders SET payment_state = 'failed', updated_at = ? WHERE id = ? AND payment_state IN ('unpaid','processing')`,
      nowIso(), orderId,
    );
    return res.changes === 1;
  }

  /** refund_state + refunded amount from canonical charge facts (idempotent overwrite of facts). */
  async setOrderRefundFacts(orderId: string, refundState: 'none' | 'pending' | 'partial' | 'full' | 'failed', refundedCents: number): Promise<void> {
    await this.db.run(
      `UPDATE testing_orders SET refund_state = ?, refunded_cents = ?, updated_at = ? WHERE id = ?`,
      refundState, refundedCents, nowIso(), orderId,
    );
  }

  async setOrderDisputeState(orderId: string, state: 'open' | 'won' | 'lost', riskHold: boolean): Promise<void> {
    await this.db.run(
      `UPDATE testing_orders SET dispute_state = ?, risk_hold = ?, updated_at = ? WHERE id = ?`,
      state, riskHold ? 1 : 0, nowIso(), orderId,
    );
  }

  async setOrderRiskHold(orderId: string, hold: boolean): Promise<void> {
    await this.db.run('UPDATE testing_orders SET risk_hold = ?, updated_at = ? WHERE id = ?', hold ? 1 : 0, nowIso(), orderId);
  }

  /** Guarded fulfillment transition. */
  async orderFulfillmentGate(orderId: string, from: string[], to: string): Promise<boolean> {
    const marks = from.map(() => '?').join(',');
    const res = await this.db.run(
      `UPDATE testing_orders SET fulfillment_state = ?, updated_at = ? WHERE id = ? AND fulfillment_state IN (${marks})`,
      to, nowIso(), orderId, ...from,
    );
    return res.changes === 1;
  }

  async pauseOrder(orderId: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_orders SET paused_from_state = fulfillment_state, fulfillment_state = 'paused', updated_at = ?
       WHERE id = ? AND fulfillment_state IN ('needs_inputs','ready','running','reviewing')`,
      nowIso(), orderId,
    );
    return res.changes === 1;
  }

  async resumeOrder(orderId: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_orders SET fulfillment_state = COALESCE(paused_from_state, 'ready'), paused_from_state = NULL, updated_at = ?
       WHERE id = ? AND fulfillment_state = 'paused'`,
      nowIso(), orderId,
    );
    return res.changes === 1;
  }

  async recordCancelRequest(orderId: string, ownerId: string, reason: string | null): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_orders SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_request_reason = COALESCE(?, cancel_request_reason), updated_at = ?
       WHERE id = ? AND owner_id = ?`,
      nowIso(), reason, nowIso(), orderId, ownerId,
    );
    return res.changes === 1;
  }

  /** Set the published-report linkage + retest deadline (first publication only). */
  async setInitialReport(orderId: string, reportId: string, publishedAt: string, retestDeadlineAt: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_orders SET initial_report_id = ?, initial_report_published_at = ?, retest_deadline_at = ?, updated_at = ?
       WHERE id = ? AND initial_report_id IS NULL`,
      reportId, publishedAt, retestDeadlineAt, nowIso(), orderId,
    );
    return res.changes === 1;
  }

  // ─── runs + attempts ───

  async createRun(input: {
    orderId: string; kind: 'baseline' | 'external' | 'retest'; slot: number; scopeHash: string;
    environmentJson: string; parentFindingId?: string | null; parentRunId?: string | null;
  }): Promise<RunRow | null> {
    const id = generatePublicId('trun');
    const now = nowIso();
    try {
      await this.db.run(
        `INSERT INTO testing_runs (id, order_id, kind, slot, scope_hash, environment_json, parent_finding_id, parent_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.orderId, input.kind, input.slot, input.scopeHash, input.environmentJson,
        input.parentFindingId ?? null, input.parentRunId ?? null, now, now,
      );
    } catch {
      // UNIQUE(order, kind, slot) — plan already exists; return the existing row.
      return this.db.get<RunRow>(
        'SELECT * FROM testing_runs WHERE order_id = ? AND kind = ? AND slot = ?', input.orderId, input.kind, input.slot,
      );
    }
    return this.getRun(id);
  }

  async getRun(id: string): Promise<RunRow | null> {
    return this.db.get<RunRow>('SELECT * FROM testing_runs WHERE id = ?', id);
  }

  async listRuns(orderId: string): Promise<RunRow[]> {
    return this.db.all<RunRow>(
      `SELECT * FROM testing_runs WHERE order_id = ? ORDER BY CASE kind WHEN 'baseline' THEN 0 WHEN 'external' THEN 1 ELSE 2 END, slot ASC`,
      orderId,
    );
  }

  async runResultGate(runId: string, from: string[], to: string): Promise<boolean> {
    const marks = from.map(() => '?').join(',');
    const res = await this.db.run(
      `UPDATE testing_runs SET result_state = ?, version = version + 1, updated_at = ? WHERE id = ? AND result_state IN (${marks})`,
      to, nowIso(), runId, ...from,
    );
    return res.changes === 1;
  }

  /** Operator review outcome: stored with the reviewer + assertion, version-guarded. */
  async reviewRun(input: {
    runId: string; expectedVersion: number; resultState: string; reviewedResultJson: string;
    environmentDemonstrated: boolean | null; slotSatisfied: boolean | null;
    operatorGroupId: string | null; environmentObservedJson: string | null;
    reviewedBy: string; assertionId: string | null;
  }): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_runs SET result_state = ?, reviewed_result_json = ?, environment_demonstrated = ?, slot_satisfied = ?,
         operator_group_id = COALESCE(?, operator_group_id), environment_observed_json = COALESCE(?, environment_observed_json),
         reviewed_by = ?, reviewed_at = ?, review_assertion_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
      input.resultState, input.reviewedResultJson,
      input.environmentDemonstrated === null ? null : (input.environmentDemonstrated ? 1 : 0),
      input.slotSatisfied === null ? null : (input.slotSatisfied ? 1 : 0),
      input.operatorGroupId, input.environmentObservedJson,
      input.reviewedBy, nowIso(), input.assertionId, nowIso(), input.runId, input.expectedVersion,
    );
    return res.changes === 1;
  }

  /**
   * New attempt for a run — the one-active-per-run invariant is the partial
   * unique index; a second concurrent insert throws and returns null.
   */
  async createRunAttempt(input: {
    runId: string; publicationRef: string; briefJson: string; reservationId: string | null;
  }): Promise<RunAttemptRow | null> {
    const id = generatePublicId('tatt');
    const now = nowIso();
    try {
      await this.db.run(
        `INSERT INTO testing_run_attempts (id, run_id, attempt, publication_ref, brief_json, reservation_id, state, active, created_at, updated_at)
         SELECT ?, ?, COALESCE((SELECT MAX(attempt) FROM testing_run_attempts WHERE run_id = ?), 0) + 1, ?, ?, ?, 'publishing', 1, ?, ?`,
        id, input.runId, input.runId, input.publicationRef, input.briefJson, input.reservationId, now, now,
      );
    } catch {
      return null; // active attempt already exists, or publication_ref replay
    }
    return this.getRunAttempt(id);
  }

  async getRunAttempt(id: string): Promise<RunAttemptRow | null> {
    return this.db.get<RunAttemptRow>('SELECT * FROM testing_run_attempts WHERE id = ?', id);
  }

  async getAttemptByPublicationRef(ref: string): Promise<RunAttemptRow | null> {
    return this.db.get<RunAttemptRow>('SELECT * FROM testing_run_attempts WHERE publication_ref = ?', ref);
  }

  async getActiveAttempt(runId: string): Promise<RunAttemptRow | null> {
    return this.db.get<RunAttemptRow>('SELECT * FROM testing_run_attempts WHERE run_id = ? AND active = 1', runId);
  }

  async getAttemptByTask(taskId: string): Promise<RunAttemptRow | null> {
    return this.db.get<RunAttemptRow>('SELECT * FROM testing_run_attempts WHERE task_id = ?', taskId);
  }

  async listAttempts(runId: string): Promise<RunAttemptRow[]> {
    return this.db.all<RunAttemptRow>('SELECT * FROM testing_run_attempts WHERE run_id = ? ORDER BY attempt ASC', runId);
  }

  async listActiveAttemptsWithTasks(limit = 200): Promise<RunAttemptRow[]> {
    // 'accepted' stays in the sweep until its reservation is settled/released.
    return this.db.all<RunAttemptRow>(
      `SELECT * FROM testing_run_attempts a WHERE active = 1 AND task_id IS NOT NULL AND (
         state IN ('published','claimed','submitted')
         OR (state = 'accepted' AND reservation_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM testing_budget_reservations r WHERE r.id = a.reservation_id AND r.state NOT IN ('settled','released')))
       ) ORDER BY updated_at ASC LIMIT ?`,
      limit,
    );
  }

  /** Link the created core task id (publishing → published). Idempotent for the same task. */
  async attachTaskToAttempt(attemptId: string, taskId: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_run_attempts SET task_id = ?, state = 'published', updated_at = ? WHERE id = ? AND state = 'publishing' AND task_id IS NULL`,
      taskId, nowIso(), attemptId,
    );
    if (res.changes === 1) return true;
    const row = await this.getRunAttempt(attemptId);
    return row?.task_id === taskId;
  }

  async attemptStateGate(attemptId: string, from: string[], to: string, patch: {
    agentId?: string | null; taskStatus?: string | null; paymentStatus?: string | null; lastError?: string | null;
  } = {}): Promise<boolean> {
    const marks = from.map(() => '?').join(',');
    const res = await this.db.run(
      `UPDATE testing_run_attempts SET state = ?,
         agent_id = COALESCE(?, agent_id), task_status_mirror = COALESCE(?, task_status_mirror),
         payment_status_mirror = COALESCE(?, payment_status_mirror), last_error = COALESCE(?, last_error), updated_at = ?
       WHERE id = ? AND state IN (${marks})`,
      to, patch.agentId ?? null, patch.taskStatus ?? null, patch.paymentStatus ?? null, patch.lastError ?? null,
      nowIso(), attemptId, ...from,
    );
    return res.changes === 1;
  }

  async updateAttemptMirrors(attemptId: string, taskStatus: string | null, paymentStatus: string | null): Promise<void> {
    await this.db.run(
      `UPDATE testing_run_attempts SET task_status_mirror = ?, payment_status_mirror = ?, updated_at = ? WHERE id = ?`,
      taskStatus, paymentStatus, nowIso(), attemptId,
    );
  }

  /** Store a validated (or rejected) worker submission on the attempt. */
  async storeAttemptResult(input: {
    attemptId: string; resultJson: string | null; receiptId: string | null;
    valid: boolean; invalidReason: string | null; evidenceHashesJson: string | null;
  }): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_run_attempts SET result_json = ?, result_receipt_id = ?, result_valid = ?, result_invalid_reason = ?,
         evidence_hashes_json = ?, state = 'submitted', updated_at = ?
       WHERE id = ? AND state IN ('published','claimed','submitted')`,
      input.resultJson, input.receiptId, input.valid ? 1 : 0, input.invalidReason,
      input.evidenceHashesJson, nowIso(), input.attemptId,
    );
    return res.changes === 1;
  }

  /** Retire the active attempt (resolve rights first — caller's job). */
  async retireAttempt(attemptId: string, to: 'invalid' | 'replaced' | 'cancelled' | 'failed', reason: string | null): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_run_attempts SET active = 0, state = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ? AND active = 1`,
      to, reason, nowIso(), attemptId,
    );
    return res.changes === 1;
  }

  /** Duplicate-evidence probe across a whole order (spec §12.1). */
  async evidenceHashSeenElsewhere(orderId: string, attemptId: string, hash: string): Promise<boolean> {
    const row = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM testing_run_attempts a JOIN testing_runs r ON r.id = a.run_id
       WHERE r.order_id = ? AND a.id <> ? AND a.evidence_hashes_json LIKE '%' || ? || '%'`,
      orderId, attemptId, hash,
    );
    return (row?.n ?? 0) > 0;
  }

  // ─── worker eligibility ───

  async upsertEligibility(input: {
    agentId: string; operatorGroupId: string; groupConfidence: string; capabilitiesJson: string;
    environmentsJson: string; evidenceRefsJson: string | null; provenance: string; status: string;
    reviewedBy: string | null; expiresAt: string | null; notes: string | null;
  }): Promise<void> {
    const now = nowIso();
    const existing = await this.getEligibility(input.agentId);
    if (existing) {
      await this.db.run(
        `UPDATE testing_worker_eligibility SET operator_group_id = ?, group_confidence = ?, capabilities_json = ?, environments_json = ?,
           evidence_refs_json = ?, provenance = ?, status = ?, reviewed_by = ?, reviewed_at = ?, expires_at = ?, notes = ?, updated_at = ?
         WHERE agent_id = ?`,
        input.operatorGroupId, input.groupConfidence, input.capabilitiesJson, input.environmentsJson,
        input.evidenceRefsJson, input.provenance, input.status, input.reviewedBy, now, input.expiresAt, input.notes, now,
        input.agentId,
      );
    } else {
      await this.db.run(
        `INSERT INTO testing_worker_eligibility
           (agent_id, operator_group_id, group_confidence, capabilities_json, environments_json, evidence_refs_json,
            provenance, status, reviewed_by, reviewed_at, expires_at, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.agentId, input.operatorGroupId, input.groupConfidence, input.capabilitiesJson, input.environmentsJson,
        input.evidenceRefsJson, input.provenance, input.status, input.reviewedBy, now, input.expiresAt, input.notes, now, now,
      );
    }
  }

  async getEligibility(agentId: string): Promise<EligibilityRow | null> {
    return this.db.get<EligibilityRow>('SELECT * FROM testing_worker_eligibility WHERE agent_id = ?', agentId);
  }

  async listEligibility(): Promise<EligibilityRow[]> {
    return this.db.all<EligibilityRow>('SELECT * FROM testing_worker_eligibility ORDER BY updated_at DESC');
  }

  /** Approved + unexpired eligibility rows as of `now`. */
  async listApprovedEligibility(now: string): Promise<EligibilityRow[]> {
    return this.db.all<EligibilityRow>(
      `SELECT * FROM testing_worker_eligibility WHERE status = 'approved' AND (expires_at IS NULL OR expires_at > ?)`,
      now,
    );
  }

  // ─── budget reservations (atomic cap math) ───

  /**
   * Reserve `amount` against the order's cap in ONE guarded insert: the sum of
   * every open reservation plus this one must stay ≤ cap. `operation_ref` is
   * the idempotency key — a replay returns the existing row.
   */
  async reserveBudget(input: {
    orderId: string; operationRef: string; purpose: string; amountAtomic: string; capAtomic: string; attemptId?: string | null;
  }): Promise<{ ok: true; row: ReservationRow } | { ok: false; reason: 'budget_exceeded' | 'conflict' }> {
    assertAtomic(input.amountAtomic, 'reservation amount');
    assertAtomic(input.capAtomic, 'order cap');
    const existing = await this.getReservationByRef(input.operationRef);
    if (existing) return { ok: true, row: existing };
    const id = generatePublicId('trsv');
    const now = nowIso();
    try {
      const res = await this.db.run(
        `INSERT INTO testing_budget_reservations (id, order_id, operation_ref, purpose, amount_atomic, state, attempt_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, 'reserved', ?, ?, ?
         WHERE (SELECT COALESCE(SUM(CAST(amount_atomic AS INTEGER)), 0) FROM testing_budget_reservations
                 WHERE order_id = ? AND state IN ${COMMITTED_STATES}) + CAST(? AS INTEGER) <= CAST(? AS INTEGER)`,
        id, input.orderId, input.operationRef, input.purpose, input.amountAtomic, input.attemptId ?? null, now, now,
        input.orderId, input.amountAtomic, input.capAtomic,
      );
      if (res.changes !== 1) return { ok: false, reason: 'budget_exceeded' };
    } catch {
      const replay = await this.getReservationByRef(input.operationRef);
      if (replay) return { ok: true, row: replay };
      return { ok: false, reason: 'conflict' };
    }
    return { ok: true, row: (await this.getReservationByRef(input.operationRef))! };
  }

  async getReservationByRef(ref: string): Promise<ReservationRow | null> {
    return this.db.get<ReservationRow>('SELECT * FROM testing_budget_reservations WHERE operation_ref = ?', ref);
  }

  async getReservation(id: string): Promise<ReservationRow | null> {
    return this.db.get<ReservationRow>('SELECT * FROM testing_budget_reservations WHERE id = ?', id);
  }

  async listReservations(orderId: string): Promise<ReservationRow[]> {
    return this.db.all<ReservationRow>('SELECT * FROM testing_budget_reservations WHERE order_id = ? ORDER BY created_at ASC', orderId);
  }

  async reservationGate(id: string, from: string[], to: string, patch: { attemptId?: string | null; paymentRef?: string | null; purpose?: string | null } = {}): Promise<boolean> {
    const marks = from.map(() => '?').join(',');
    const res = await this.db.run(
      `UPDATE testing_budget_reservations SET state = ?, attempt_id = COALESCE(?, attempt_id),
         payment_ref = COALESCE(?, payment_ref), purpose = COALESCE(?, purpose), updated_at = ?
       WHERE id = ? AND state IN (${marks})`,
      to, patch.attemptId ?? null, patch.paymentRef ?? null, patch.purpose ?? null, nowIso(), id, ...from,
    );
    return res.changes === 1;
  }

  /** cap − open commitments, as a bigint (for display / preview only — never the guard). */
  async remainingBudget(orderId: string, capAtomic: string): Promise<bigint> {
    const row = await this.db.get<{ total: number | null }>(
      `SELECT SUM(CAST(amount_atomic AS INTEGER)) AS total FROM testing_budget_reservations
       WHERE order_id = ? AND state IN ${COMMITTED_STATES}`,
      orderId,
    );
    return BigInt(capAtomic) - BigInt(row?.total ?? 0);
  }

  // ─── reports ───

  async createReportDraft(input: { orderId: string; reportJson: string; scopeHash: string; sourceHash: string }): Promise<ReportRow | null> {
    const id = generatePublicId('trpt');
    const now = nowIso();
    try {
      await this.db.run(
        `INSERT INTO testing_reports (id, order_id, version, report_json, scope_hash, source_hash, status, created_at, updated_at)
         SELECT ?, ?, COALESCE((SELECT MAX(version) FROM testing_reports WHERE order_id = ?), 0) + 1, ?, ?, ?, 'draft', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM testing_reports WHERE order_id = ? AND status = 'draft')`,
        id, input.orderId, input.orderId, input.reportJson, input.scopeHash, input.sourceHash, now, now, input.orderId,
      );
    } catch {
      return null;
    }
    return this.getReport(id);
  }

  async getReport(id: string): Promise<ReportRow | null> {
    return this.db.get<ReportRow>('SELECT * FROM testing_reports WHERE id = ?', id);
  }

  async listReports(orderId: string): Promise<ReportRow[]> {
    return this.db.all<ReportRow>('SELECT * FROM testing_reports WHERE order_id = ? ORDER BY version ASC', orderId);
  }

  async getDraftReport(orderId: string): Promise<ReportRow | null> {
    return this.db.get<ReportRow>(`SELECT * FROM testing_reports WHERE order_id = ? AND status = 'draft'`, orderId);
  }

  async getLatestPublishedReport(orderId: string): Promise<ReportRow | null> {
    return this.db.get<ReportRow>(
      `SELECT * FROM testing_reports WHERE order_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`, orderId,
    );
  }

  /** Operator edit of a DRAFT report body (published versions are immutable). */
  async updateDraftReport(reportId: string, reportJson: string, sourceHash: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_reports SET report_json = ?, source_hash = ?, updated_at = ? WHERE id = ? AND status = 'draft'`,
      reportJson, sourceHash, nowIso(), reportId,
    );
    return res.changes === 1;
  }

  /** draft → published, exactly once, with approver + assertion. */
  async publishReport(reportId: string, approvedBy: string, assertionId: string | null): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE testing_reports SET status = 'published', approved_by = ?, approve_assertion_id = ?, published_at = ?, updated_at = ?
       WHERE id = ? AND status = 'draft'`,
      approvedBy, assertionId, nowIso(), nowIso(), reportId,
    );
    return res.changes === 1;
  }

  // ─── feedback ───

  async addFeedback(input: {
    orderId: string; ownerId: string; useful: string | null; actionTaken: string | null;
    incremental: string | null; comment: string | null;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO testing_feedback (id, order_id, owner_id, useful, action_taken, incremental, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      generatePublicId('tfbk'), input.orderId, input.ownerId, input.useful, input.actionTaken,
      input.incremental, input.comment, nowIso(),
    );
  }

  // ─── Stripe inbox (received → processing(lease) → processed | retryable_failed | manual_review) ───

  /** Durably store a verified event BEFORE acknowledging. Duplicate ids are absorbed. */
  async inboxReceive(input: { eventId: string; eventType: string; payloadJson: string; payloadHash: string; livemode: boolean }): Promise<void> {
    await this.db.run(
      `INSERT OR IGNORE INTO testing_stripe_events (event_id, event_type, payload_json, payload_hash, livemode, state, received_at)
       VALUES (?, ?, ?, ?, ?, 'received', ?)`,
      input.eventId, input.eventType, input.payloadJson, input.payloadHash, input.livemode ? 1 : 0, nowIso(),
    );
  }

  async inboxGet(eventId: string): Promise<InboxRow | null> {
    return this.db.get<InboxRow>('SELECT * FROM testing_stripe_events WHERE event_id = ?', eventId);
  }

  /**
   * Claim one due inbox event with a lease. A crash after claiming leaves the
   * lease to expire; the next runner re-claims. Never a permanent suppression.
   */
  async inboxClaim(eventId: string, now: string, leaseSeconds = 120): Promise<boolean> {
    const lease = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
    const res = await this.db.run(
      `UPDATE testing_stripe_events SET state = 'processing', attempts = attempts + 1, lease_expires_at = ?
       WHERE event_id = ? AND (
         state IN ('received','retryable_failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         OR (state = 'processing' AND lease_expires_at <= ?))`,
      lease, eventId, now, now,
    );
    return res.changes === 1;
  }

  async inboxDue(now: string, limit = 25): Promise<InboxRow[]> {
    return this.db.all<InboxRow>(
      `SELECT * FROM testing_stripe_events WHERE
         (state IN ('received','retryable_failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (state = 'processing' AND lease_expires_at <= ?)
       ORDER BY received_at ASC LIMIT ?`,
      now, now, limit,
    );
  }

  async inboxProcessed(eventId: string): Promise<void> {
    await this.db.run(
      `UPDATE testing_stripe_events SET state = 'processed', processed_at = ?, lease_expires_at = NULL, next_attempt_at = NULL WHERE event_id = ?`,
      nowIso(), eventId,
    );
  }

  async inboxFailed(eventId: string, error: string, maxAttempts = 8): Promise<void> {
    const row = await this.inboxGet(eventId);
    const attempts = row?.attempts ?? 1;
    if (attempts >= maxAttempts) {
      await this.db.run(
        `UPDATE testing_stripe_events SET state = 'manual_review', last_error = ?, lease_expires_at = NULL, next_attempt_at = NULL WHERE event_id = ?`,
        error.slice(0, 500), eventId,
      );
      return;
    }
    const backoffMs = Math.min(60_000 * 2 ** attempts, 3_600_000);
    await this.db.run(
      `UPDATE testing_stripe_events SET state = 'retryable_failed', last_error = ?, lease_expires_at = NULL, next_attempt_at = ? WHERE event_id = ?`,
      error.slice(0, 500), new Date(Date.now() + backoffMs).toISOString(), eventId,
    );
  }

  // ─── durable operations ───

  /** Enqueue an operation; the semantic key makes replays a no-op returning the existing row. */
  async enqueueOperation(input: { kind: string; semanticKey: string; orderId?: string | null; payloadJson: string }): Promise<OperationRow> {
    const id = generatePublicId('top');
    const now = nowIso();
    await this.db.run(
      `INSERT OR IGNORE INTO testing_operations (id, kind, semantic_key, order_id, payload_json, state, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id, input.kind, input.semanticKey, input.orderId ?? null, input.payloadJson, now, now, now,
    );
    // Re-enqueueing a semantic key whose operation parked in manual_review is
    // the operator's RETRY (runbook: "fix the cause; re-approve") — revive it
    // for the next runner pass. Pending/processing/succeeded rows are left
    // untouched, so idempotency and never-double-spend are preserved.
    await this.db.run(
      `UPDATE testing_operations SET state = 'pending', next_attempt_at = ?, last_error = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE semantic_key = ? AND state = 'manual_review'`,
      now, now, input.semanticKey,
    );
    return (await this.getOperationByKey(input.semanticKey))!;
  }

  async getOperationByKey(key: string): Promise<OperationRow | null> {
    return this.db.get<OperationRow>('SELECT * FROM testing_operations WHERE semantic_key = ?', key);
  }

  async operationsDue(now: string, limit = 25): Promise<OperationRow[]> {
    return this.db.all<OperationRow>(
      `SELECT * FROM testing_operations WHERE
         (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (state = 'processing' AND lease_expires_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
      now, now, limit,
    );
  }

  async listOperationsByOrder(orderId: string): Promise<OperationRow[]> {
    return this.db.all<OperationRow>('SELECT * FROM testing_operations WHERE order_id = ? ORDER BY created_at ASC', orderId);
  }

  async listOperationsByState(states: string[], limit = 100): Promise<OperationRow[]> {
    const marks = states.map(() => '?').join(',');
    return this.db.all<OperationRow>(
      `SELECT * FROM testing_operations WHERE state IN (${marks}) ORDER BY updated_at ASC LIMIT ?`, ...states, limit,
    );
  }

  async operationClaim(id: string, now: string, leaseSeconds = 120): Promise<boolean> {
    const lease = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
    const res = await this.db.run(
      `UPDATE testing_operations SET state = 'processing', attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND (
         (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (state = 'processing' AND lease_expires_at <= ?))`,
      lease, now, id, now, now,
    );
    return res.changes === 1;
  }

  async operationSucceeded(id: string, resultJson: string | null): Promise<void> {
    await this.db.run(
      `UPDATE testing_operations SET state = 'succeeded', result_json = ?, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      resultJson, nowIso(), id,
    );
  }

  async operationFailed(id: string, error: string, opts: { maxAttempts?: number; manual?: boolean } = {}): Promise<void> {
    const row = await this.db.get<OperationRow>('SELECT * FROM testing_operations WHERE id = ?', id);
    const attempts = row?.attempts ?? 1;
    const max = opts.maxAttempts ?? 6;
    if (opts.manual || attempts >= max) {
      await this.db.run(
        `UPDATE testing_operations SET state = 'manual_review', last_error = ?, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        error.slice(0, 500), nowIso(), id,
      );
      return;
    }
    const backoffMs = Math.min(30_000 * 2 ** attempts, 3_600_000);
    await this.db.run(
      `UPDATE testing_operations SET state = 'pending', last_error = ?, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      error.slice(0, 500), new Date(Date.now() + backoffMs).toISOString(), nowIso(), id,
    );
  }

  /** Persist a durable field on an operation payload (e.g. a pre-generated task id) before an external call. */
  async updateOperationPayload(id: string, payloadJson: string): Promise<void> {
    await this.db.run('UPDATE testing_operations SET payload_json = ?, updated_at = ? WHERE id = ?', payloadJson, nowIso(), id);
  }

  // ─── notifications (semantic-key dedupe) ───

  async queueNotification(input: { semanticKey: string; kind: string; recipient: string; orderId?: string | null; subject: string; body: string }): Promise<boolean> {
    const now = nowIso();
    const res = await this.db.run(
      `INSERT OR IGNORE INTO testing_notifications (semantic_key, kind, recipient, order_id, subject, body, state, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      input.semanticKey, input.kind, input.recipient, input.orderId ?? null, input.subject, input.body, now, now,
    );
    return res.changes === 1;
  }

  /** Void a queued-but-unsent alert whose condition no longer holds. */
  async dropPendingNotification(semanticKey: string): Promise<boolean> {
    const res = await this.db.run(
      `DELETE FROM testing_notifications WHERE semantic_key = ? AND state = 'pending'`, semanticKey,
    );
    return res.changes === 1;
  }

  async notificationsDue(now: string, limit = 25): Promise<NotificationRow[]> {
    return this.db.all<NotificationRow>(
      `SELECT * FROM testing_notifications WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC LIMIT ?`,
      now, limit,
    );
  }

  async notificationSent(key: string): Promise<void> {
    await this.db.run(`UPDATE testing_notifications SET state = 'sent', sent_at = ?, next_attempt_at = NULL WHERE semantic_key = ?`, nowIso(), key);
  }

  async notificationFailed(key: string, error: string, maxAttempts = 5): Promise<void> {
    const row = await this.db.get<NotificationRow>('SELECT * FROM testing_notifications WHERE semantic_key = ?', key);
    const attempts = (row?.attempts ?? 0) + 1;
    if (attempts >= maxAttempts) {
      await this.db.run(
        `UPDATE testing_notifications SET state = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL WHERE semantic_key = ?`,
        attempts, error.slice(0, 300), key,
      );
      return;
    }
    await this.db.run(
      `UPDATE testing_notifications SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE semantic_key = ?`,
      attempts, error.slice(0, 300), new Date(Date.now() + Math.min(60_000 * 2 ** attempts, 1_800_000)).toISOString(), key,
    );
  }

  // ─── claim allowlist (managed tasks) ───

  async setTaskAllowlist(taskId: string, agentIds: string[]): Promise<void> {
    const now = nowIso();
    const statements = [
      { sql: 'DELETE FROM task_claim_allowlist WHERE task_id = ?', params: [taskId] as unknown[] },
      ...agentIds.map((agentId) => ({
        sql: 'INSERT OR IGNORE INTO task_claim_allowlist (task_id, agent_id, created_at) VALUES (?, ?, ?)',
        params: [taskId, agentId, now] as unknown[],
      })),
    ];
    await this.db.batch(statements);
  }

  // ─── retention (spec §14.4) ───

  /** Delete stale unsubmitted drafts; returns the number removed. */
  async deleteStaleDrafts(cutoffIso: string): Promise<number> {
    const res = await this.db.run(
      `DELETE FROM testing_requests WHERE status = 'draft' AND updated_at < ?
         AND NOT EXISTS (SELECT 1 FROM testing_quotes q WHERE q.request_id = testing_requests.id)`,
      cutoffIso,
    );
    return res.changes;
  }

  /** Strip worker evidence bodies past the evidence retention window (keeps audit metadata). */
  async redactExpiredEvidence(cutoffIso: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE testing_run_attempts SET result_json = NULL, evidence_hashes_json = NULL, updated_at = ?
       WHERE result_json IS NOT NULL AND run_id IN (
         SELECT r.id FROM testing_runs r JOIN testing_orders o ON o.id = r.order_id
         WHERE o.initial_report_published_at IS NOT NULL AND o.initial_report_published_at < ? AND o.risk_hold = 0
       )`,
      nowIso(), cutoffIso,
    );
    return res.changes;
  }
}
