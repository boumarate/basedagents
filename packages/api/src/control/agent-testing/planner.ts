/**
 * Agent Testing — deterministic run plans (spec §9.3).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * A paid order gets exactly:
 *   B0  internal baseline (slot 0) — identified as internal, never presented
 *       as an independent worker result;
 *   E1…En external executions, one per approved environment slot;
 *   R1  a retest ENTITLEMENT only: a budget earmark, no run row and no task
 *       until an eligible retest is actually requested and approved.
 *
 * Creating the plan publishes NOTHING: operator approval gates every task.
 */
import type { DBAdapter } from '../../db/adapter.js';
import { TestingStore, type OrderRow, type QuoteRow, type RunRow } from './store.js';
import { QuoteScopeSchema, type QuoteScope } from './schemas.js';

export function parseScope(quote: QuoteRow): QuoteScope {
  return QuoteScopeSchema.parse(JSON.parse(quote.scope_json));
}

export interface PlanResult {
  runs: RunRow[];
  earmarkReserved: boolean;
}

/**
 * Create the fixed initial plan for a PAID order. Idempotent end to end:
 * run rows are unique on (order, kind, slot); the retest earmark reservation
 * is unique on its operation ref. Never creates more work than the package
 * sold (no "ten tasks per purchase").
 */
export async function createInitialPlan(db: DBAdapter, orderId: string): Promise<PlanResult> {
  const store = new TestingStore(db);
  const order = await store.getOrder(orderId);
  if (!order) throw new Error(`order ${orderId} not found`);
  if (order.payment_state !== 'succeeded') throw new Error(`order ${orderId} is not paid (${order.payment_state})`);
  const quote = await store.getQuote(order.quote_id);
  if (!quote) throw new Error(`order ${orderId} has no quote`);
  const scope = parseScope(quote);

  const runs: RunRow[] = [];

  const baseline = await store.createRun({
    orderId,
    kind: 'baseline',
    slot: 0,
    scopeHash: quote.scope_hash,
    environmentJson: JSON.stringify({ client: 'basedagents-internal', transport: 'internal', native_execution_required: false, notes: 'Internal baseline — not an independent operator result.' }),
  });
  if (baseline) runs.push(baseline);

  const slots = scope.environment_slots.slice(0, quote.external_run_slots);
  for (let i = 0; i < slots.length; i++) {
    const run = await store.createRun({
      orderId,
      kind: 'external',
      slot: i + 1,
      scopeHash: quote.scope_hash,
      environmentJson: JSON.stringify(slots[i]),
    });
    if (run) runs.push(run);
  }

  // R1: earmark the included retest's bounty inside the order cap (spec §17.1).
  // An internal reservation only — no escrow transfer, no task. Replacement
  // work cannot consume it because the earmark occupies the cap sum.
  let earmarkReserved = false;
  if (quote.retest_slots > 0) {
    const earmark = await store.reserveBudget({
      orderId,
      operationRef: `earmark:${orderId}`,
      purpose: 'retest_earmark',
      amountAtomic: quote.worker_bounty_usdc_atomic,
      capAtomic: quote.worker_cap_usdc_atomic,
    });
    earmarkReserved = earmark.ok;
  }

  await store.audit({
    actor: 'system:planner',
    action: 'plan_created',
    objectKind: 'order',
    objectId: orderId,
    reason: `baseline + ${slots.length} external slots + ${quote.retest_slots} retest earmark`,
  });
  return { runs, earmarkReserved };
}

/** Baseline comparison inputs are complete when B0 has a reviewed outcome (or was recorded as not runnable). */
export function baselineState(runs: RunRow[]): { ran: boolean; result: 'product_success' | 'product_failure' | 'inconclusive' | 'not_run' } {
  const b0 = runs.find((r) => r.kind === 'baseline');
  if (!b0) return { ran: false, result: 'not_run' };
  if (b0.result_state === 'product_success' || b0.result_state === 'product_failure' || b0.result_state === 'inconclusive') {
    return { ran: true, result: b0.result_state };
  }
  return { ran: false, result: 'not_run' };
}

export function externalRuns(runs: RunRow[]): RunRow[] {
  return runs.filter((r) => r.kind === 'external');
}

/** Valid reviewed external outcomes (coverage numerator: reviewed, evidence-valid runs only). */
export function validExternalOutcomes(runs: RunRow[]): RunRow[] {
  return externalRuns(runs).filter((r) => ['product_success', 'product_failure'].includes(r.result_state));
}

export type OrderForPlan = OrderRow;
