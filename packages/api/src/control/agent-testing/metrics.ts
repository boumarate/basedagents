/**
 * Agent Testing — operator metrics (spec §18), derived from server records
 * only. Founder-funded and test-fixture orders are excluded from external
 * demand numbers. Unknown costs stay null — never zero.
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 */
import type { DBAdapter } from '../../db/adapter.js';

async function n(db: DBAdapter, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.get<{ n: number | null }>(sql, ...params);
  return row?.n ?? 0;
}

export async function operatorMetrics(db: DBAdapter): Promise<Record<string, unknown>> {
  const external = `source = 'external_customer'`;

  const uniquePayingCustomers = await n(db,
    `SELECT COUNT(DISTINCT owner_id) AS n FROM testing_orders WHERE payment_state = 'succeeded' AND ${external}`);
  const initialPayments = await n(db,
    `SELECT COUNT(*) AS n FROM testing_orders WHERE payment_state = 'succeeded' AND ${external} AND previous_order_id IS NULL`);
  const repeatPayments = await n(db,
    `SELECT COUNT(*) AS n FROM testing_orders WHERE payment_state = 'succeeded' AND ${external} AND previous_order_id IS NOT NULL`);
  const customersWithRepeat = await n(db,
    `SELECT COUNT(*) AS n FROM (
       SELECT owner_id FROM testing_orders WHERE payment_state = 'succeeded' AND ${external}
       GROUP BY owner_id HAVING COUNT(*) >= 2)`);

  const quotesApproved = await n(db, `SELECT COUNT(*) AS n FROM testing_quotes WHERE status IN ('approved','accepted','expired')`);
  const quotesPaid = await n(db,
    `SELECT COUNT(*) AS n FROM testing_quotes q JOIN testing_orders o ON o.quote_id = q.id WHERE o.payment_state = 'succeeded'`);

  const money = await db.get<{ collected: number | null; tax: number | null; refunded: number | null }>(
    `SELECT SUM(collected_cents) AS collected, SUM(tax_cents) AS tax, SUM(refunded_cents) AS refunded
     FROM testing_orders WHERE payment_state = 'succeeded'`);

  const worker = await db.get<{ committed: number | null; settled: number | null; released: number | null }>(
    `SELECT
       SUM(CASE WHEN state IN ('reserved','committed','release_pending') THEN CAST(amount_atomic AS INTEGER) ELSE 0 END) AS committed,
       SUM(CASE WHEN state = 'settled' THEN CAST(amount_atomic AS INTEGER) ELSE 0 END) AS settled,
       SUM(CASE WHEN state = 'released' THEN CAST(amount_atomic AS INTEGER) ELSE 0 END) AS released
     FROM testing_budget_reservations`);

  const delivered = await n(db, `SELECT COUNT(*) AS n FROM testing_orders WHERE fulfillment_state = 'delivered'`);
  const late = await n(db,
    `SELECT COUNT(*) AS n FROM testing_orders o JOIN testing_quotes q ON q.id = o.quote_id
     WHERE o.initial_report_published_at IS NOT NULL AND o.initial_report_published_at > q.delivery_target_at`);
  const invalidSubmissions = await n(db, `SELECT COUNT(*) AS n FROM testing_run_attempts WHERE result_valid = 0`);
  const inconclusiveRuns = await n(db, `SELECT COUNT(*) AS n FROM testing_runs WHERE result_state = 'inconclusive'`);
  const refunds = await n(db, `SELECT COUNT(*) AS n FROM testing_orders WHERE refund_state IN ('partial','full')`);
  const disputes = await n(db, `SELECT COUNT(*) AS n FROM testing_orders WHERE dispute_state <> 'none'`);

  const usefulYes = await n(db, `SELECT COUNT(*) AS n FROM testing_feedback WHERE useful = 'yes'`);
  const actionTaken = await n(db, `SELECT COUNT(*) AS n FROM testing_feedback WHERE action_taken IS NOT NULL AND action_taken <> ''`);
  const externalOnlyIncremental = await n(db, `SELECT COUNT(*) AS n FROM testing_feedback WHERE incremental = 'external_only'`);

  const relatedPartyOrders = await n(db, `SELECT COUNT(*) AS n FROM testing_orders WHERE source <> 'external_customer'`);

  const events = await db.all<{ event: string; n: number }>(
    `SELECT event, COUNT(*) AS n FROM testing_metric_events GROUP BY event ORDER BY event`);

  const collected = money?.collected ?? 0;
  const refunded = money?.refunded ?? 0;

  return {
    external_demand: {
      unique_paying_customers: uniquePayingCustomers,
      initial_payments: initialPayments,
      repeat_payments: repeatPayments,
      customers_with_second_purchase: customersWithRepeat,
      related_party_or_test_orders_excluded: relatedPartyOrders,
      // Spec §18: 3 unrelated paying customers, ≥2 with a second paid
      // purchase — shown as raw counts, never manufactured.
      validation_target: { customers: 3, with_second_purchase: 2 },
    },
    conversion: {
      quotes_approved: quotesApproved,
      quotes_paid: quotesPaid,
      approved_to_paid: quotesApproved > 0 ? Number((quotesPaid / quotesApproved).toFixed(3)) : null,
    },
    customer_cash_cents: {
      collected_total: collected,
      tax_collected: money?.tax ?? 0,
      refunded: refunded,
      net_after_refunds: collected - refunded,
      processor_fees: null, // unknown until fee reconciliation is wired — never assumed zero
      note: 'Cash receipts, not recognized revenue or accounting profit.',
    },
    worker_usdc_atomic: {
      outstanding_commitments: String(worker?.committed ?? 0),
      settled_payouts: String(worker?.settled ?? 0),
      released_unspent: String(worker?.released ?? 0),
      note: 'Escrow deposits and their releases are one liability lifecycle, counted once.',
    },
    delivery: {
      delivered_orders: delivered,
      late_orders: late,
      invalid_submissions: invalidSubmissions,
      inconclusive_runs: inconclusiveRuns,
      refunded_orders: refunds,
      disputed_orders: disputes,
      operator_review_time: null, // not instrumented in v1 — stays unknown, not zero
    },
    customer_value: {
      feedback_useful_yes: usefulYes,
      feedback_action_taken: actionTaken,
      feedback_external_only_incremental: externalOnlyIncremental,
    },
    funnel_events: Object.fromEntries(events.map((e) => [e.event, e.n])),
  };
}
