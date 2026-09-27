/**
 * Agent Testing HTTP client (customer + operator surfaces).
 *
 * PROPRIETARY console code — see ../../LICENSE.
 *
 * Same transport rules as control.ts: the httpOnly session cookie rides
 * `credentials: 'include'`; operator mutations additionally carry the fresh
 * WebAuthn action assertion produced by lib/ceremony.runAction. No token or
 * secret is ever held here, and no price/budget field is client-supplied.
 */
import { API_BASE, ControlApiError } from './control.js';
import type { OwnerAssertion } from './types.js';

const OWNER = `${API_BASE}/v1/owner/testing`;
const ADMIN = `${API_BASE}/v1/owner/admin/testing`;
const PUBLIC = `${API_BASE}/v1/testing`;

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = parsed as { error?: string; message?: string };
    throw new ControlApiError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`, parsed);
  }
  return parsed as T;
}

// ─── shapes (server-defined; the console never re-derives money) ───

export interface TestingCatalog {
  available: boolean;
  checkout_available?: boolean;
  checkout_unavailable_reason?: string | null;
  package?: {
    price_cents: number; currency: string; external_runs: number; internal_baseline_runs: number;
    included_targeted_retests: number; retest_request_window_days: number; quote_validity_days: number;
    minimum_distinct_operator_groups: number;
  };
  coverage?: { environments: Array<{ client: string; transport: string }>; note: string };
  disclosures?: Record<string, string>;
  support_email?: string;
  message?: string;
}

export interface TestingIntake {
  product_name: string;
  product_category: 'api' | 'mcp' | 'other';
  product_url: string;
  documentation_url: string;
  workflow_objective: string;
  expected_result: string;
  fixture: { classification: 'synthetic'; inline?: string; url?: string };
  target_environment: string;
  release_identifier: string | null;
  auth_mode: 'none' | 'worker_owned_test_account';
  allowed_operations: { read_only: boolean; sandbox_write_steps: string[] };
  coverage_preferences: string[];
  known_constraints: string;
  authority_declaration: true;
  worker_disclosure_acknowledged: true;
  suspected_failure: string;
}

export interface TestingRequest {
  id: string;
  status: 'draft' | 'submitted' | 'needs_changes' | 'declined' | 'quoted';
  version: number;
  intake: TestingIntake;
  operator_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestingQuote {
  id: string;
  request_id: string;
  request_version: number;
  status: string;
  scope: {
    workflow_objective: string; expected_result: string; allowed_origins: string[];
    documentation_url: string; release_identifier: string | null; auth_mode: string;
    read_only: boolean; sandbox_write_steps: string[];
    environment_slots: Array<{ client: string; transport: string; native_execution_required: boolean }>;
    max_requests: number; max_execution_seconds: number; constraints_note: string;
  };
  scope_hash: string;
  subtotal_cents: number;
  currency: string;
  external_run_slots: number;
  retest_slots: number;
  retest_window_days: number;
  min_operator_groups: number;
  terms_version: string;
  disclosure_version: string;
  delivery_target_at: string;
  delivery_target_note: string;
  expires_at: string;
}

export interface TestingOrderSummary {
  id: string;
  stage: string;
  blocker: string | null;
  payment_state: string;
  refund_state: string;
  fulfillment_state: string;
  collected_cents: number;
  refunded_cents: number;
  currency: string;
  delivery_target_at: string | null;
  external_runs_planned: number | null;
  external_runs_complete: number;
  report_id: string | null;
  report_version: number | null;
  retest_deadline_at: string | null;
  cancel_requested_at: string | null;
  created_at: string;
}

export interface TestingOrderDetail extends TestingOrderSummary {
  quote?: TestingQuote;
  runs?: Array<{ id: string; kind: string; slot: number; environment: { client: string; transport: string }; result: string }>;
  retest_requested?: boolean;
}

export interface TestingReportDoc {
  report_id: string; order_id: string; version: number; scope_hash: string;
  workflow_objective: string; expected_result: string; release_identifier: string | null;
  observation_period: { from: string | null; to: string | null };
  executive_summary: string;
  coverage: { external_runs_planned: number; external_runs_valid: number; distinct_environments: number; reviewed_operator_groups: number; unknowns: string[] };
  execution_matrix: Array<{
    run_id: string; kind: string; slot: number;
    environment: { client: string; transport: string; observed_client_version: string | null; observed_runtime: string | null; observed_os: string | null };
    result: string; environment_demonstrated: boolean | null; first_failure_stage: string | null; evidence_ids: string[];
  }>;
  baseline: { ran: boolean; result: string; note: string };
  findings: Array<{
    finding_id: string; category: string; severity: string; statement_type: string; summary: string;
    affected_run_ids: string[]; supporting_evidence_ids: string[]; first_failure_stage: string | null;
    reproduction_steps: string[]; suggested_change: string; baseline_relation: string; retest_status: string;
  }>;
  limitations: string[];
  retest: { included_slots: number; used_slots: number; deadline_at: string | null };
  evidence_index: Array<{ evidence_id: string; run_id: string; kind: string; content_sha256: string }>;
  version_history: Array<{ version: number; published_at: string | null; note: string }>;
  generated_at: string;
}

export type Ceremony = { nonce: string; assertion: OwnerAssertion };

// ─── customer ───

export const testing = {
  catalog(): Promise<TestingCatalog> {
    return req('GET', `${PUBLIC}/catalog`);
  },
  /** No-account intake: the server emails a sign-in link; the request attaches on sign-in. */
  publicIntake(email: string, intake: TestingIntake): Promise<{ ok: true; message: string }> {
    return req('POST', `${PUBLIC}/intake`, { email, intake });
  },
  createRequest(intake: TestingIntake): Promise<{ request: TestingRequest }> {
    return req('POST', `${OWNER}/requests`, intake);
  },
  listRequests(): Promise<{ requests: Array<TestingRequest & { quote: TestingQuote | null }> }> {
    return req('GET', `${OWNER}/requests`);
  },
  getRequest(id: string): Promise<{ request: TestingRequest; quote: TestingQuote | null; order_id: string | null }> {
    return req('GET', `${OWNER}/requests/${encodeURIComponent(id)}`);
  },
  updateRequest(id: string, expectedVersion: number, intake: TestingIntake): Promise<{ request: TestingRequest }> {
    return req('PATCH', `${OWNER}/requests/${encodeURIComponent(id)}`, { expected_version: expectedVersion, intake });
  },
  submitRequest(id: string, expectedVersion: number): Promise<{ request: TestingRequest; acknowledgment: string }> {
    return req('POST', `${OWNER}/requests/${encodeURIComponent(id)}/submit`, { expected_version: expectedVersion });
  },
  requestQuoteChange(quoteId: string, note: string): Promise<{ ok: true }> {
    return req('POST', `${OWNER}/quotes/${encodeURIComponent(quoteId)}/change-request`, { note });
  },
  checkout(quoteId: string, quote: TestingQuote, idempotencyKey: string): Promise<{ checkout_url: string; order_id: string }> {
    return req('POST', `${OWNER}/quotes/${encodeURIComponent(quoteId)}/checkout`, {
      quote_version: quote.request_version,
      scope_hash: quote.scope_hash,
      terms_version: quote.terms_version,
      disclosure_version: quote.disclosure_version,
      idempotency_key: idempotencyKey,
    });
  },
  listOrders(): Promise<{ orders: TestingOrderSummary[]; next_before: string | null }> {
    return req('GET', `${OWNER}/orders`);
  },
  getOrder(id: string): Promise<{ order: TestingOrderDetail }> {
    return req('GET', `${OWNER}/orders/${encodeURIComponent(id)}`);
  },
  requestCancel(orderId: string, reason: string): Promise<{ ok: true; message: string }> {
    return req('POST', `${OWNER}/orders/${encodeURIComponent(orderId)}/cancel-request`, { reason });
  },
  requestRetest(orderId: string, findingId: string, changeDescription: string, updatedTarget: string): Promise<{ ok: true; message: string }> {
    return req('POST', `${OWNER}/orders/${encodeURIComponent(orderId)}/retest-request`, {
      finding_id: findingId, change_description: changeDescription, updated_target: updatedTarget,
    });
  },
  repeat(orderId: string): Promise<{ request: TestingRequest; message: string }> {
    return req('POST', `${OWNER}/orders/${encodeURIComponent(orderId)}/repeat`, {});
  },
  feedback(orderId: string, body: { useful?: 'yes' | 'partial' | 'no'; action_taken?: string; incremental?: string; comment?: string }): Promise<{ ok: true }> {
    return req('POST', `${OWNER}/orders/${encodeURIComponent(orderId)}/feedback`, body);
  },
  getReport(id: string): Promise<{ report: TestingReportDoc; published_at: string }> {
    return req('GET', `${OWNER}/reports/${encodeURIComponent(id)}`);
  },
  exportUrl(id: string, format: 'md' | 'json'): string {
    return `${OWNER}/reports/${encodeURIComponent(id)}/export?format=${format}`;
  },
};

// ─── operator ───

export interface AdminQueue {
  now: string;
  intake_review: Array<{ id: string; owner_id: string; version: number; updated_at: string; source: string }>;
  awaiting_email_verification?: number;
  needs_changes: Array<{ id: string; version: number; updated_at: string }>;
  awaiting_payment: AdminOrderRow[];
  awaiting_task_approval: AdminOrderRow[];
  executing: AdminOrderRow[];
  evidence_review: AdminOrderRow[];
  paused_or_blocked: AdminOrderRow[];
  cancel_requested: AdminOrderRow[];
  delivered?: AdminOrderRow[];
  cancelled?: AdminOrderRow[];
  operations_needing_attention: Array<{ id: string; kind: string; order_id: string | null; last_error: string | null; updated_at: string }>;
}

export interface AdminOrderRow {
  id: string; payment_state: string; fulfillment_state: string; risk_hold: boolean;
  cancel_requested_at: string | null; updated_at: string;
}

export interface AdminRun {
  id: string; kind: 'baseline' | 'external' | 'retest'; slot: number; result_state: string; version: number;
  environment: { client: string; transport: string; native_execution_required?: boolean };
  operator_group_id: string | null; environment_demonstrated: number | null; slot_satisfied: number | null;
  reviewed_by: string | null; reviewed_at: string | null; scope_hash: string;
  attempts: Array<{
    id: string; attempt: number; state: string; active: boolean; task_id: string | null; agent_id: string | null;
    result_valid: number | null; result_invalid_reason: string | null; result_json: string | null;
    task_status: string | null; payment_status: string | null; auto_release_at: string | null; last_error: string | null;
  }>;
}

export interface AdminOrderView {
  order: {
    id: string; owner_id: string; payment_state: string; refund_state: string; dispute_state: string;
    fulfillment_state: string; risk_hold: number; collected_cents: number; refunded_cents: number;
    cancel_requested_at: string | null; cancel_request_reason: string | null;
    initial_report_id: string | null; retest_deadline_at: string | null; created_at: string;
  };
  quote: (TestingQuote & { worker_cap_usdc_atomic: string; worker_bounty_usdc_atomic: string }) | null;
  runs: AdminRun[];
  reservations: Array<{ id: string; purpose: string; amount_atomic: string; state: string; operation_ref: string }>;
  remaining_budget_atomic: string | null;
  reports: Array<{ id: string; version: number; status: string; published_at: string | null }>;
  checkout_attempts: Array<{ id: string; attempt: number; state: string; stripe_session_id: string | null; last_error: string | null }>;
  operations: Array<{ id: string; kind: string; semantic_key: string; state: string; attempts: number; last_error: string | null }>;
}

export const testingAdmin = {
  queue(): Promise<AdminQueue> {
    return req('GET', `${ADMIN}/queue`);
  },
  getRequest(id: string): Promise<{ request: TestingRequest & { intake_json?: string; owner_id: string; source: string }; quote: TestingQuote | null; order_id: string | null }> {
    return req('GET', `${ADMIN}/requests/${encodeURIComponent(id)}`);
  },
  needsChanges(id: string, note: string): Promise<{ ok: true }> {
    return req('POST', `${ADMIN}/requests/${encodeURIComponent(id)}/needs-changes`, { note });
  },
  decline(id: string, note: string): Promise<{ ok: true }> {
    return req('POST', `${ADMIN}/requests/${encodeURIComponent(id)}/decline`, { note });
  },
  setSource(id: string, source: 'external_customer' | 'founder_sample' | 'test_fixture'): Promise<{ ok: true }> {
    return req('POST', `${ADMIN}/requests/${encodeURIComponent(id)}/source`, { source });
  },
  approveQuote(requestId: string, body: { request_version: number; scope: unknown; delivery_target_at: string; checklist_confirmed: true } & Ceremony): Promise<{ quote: TestingQuote }> {
    return req('POST', `${ADMIN}/requests/${encodeURIComponent(requestId)}/approve-quote`, body);
  },
  getOrder(id: string): Promise<AdminOrderView> {
    return req('GET', `${ADMIN}/orders/${encodeURIComponent(id)}`);
  },
  plan(orderId: string): Promise<{ runs: unknown[] }> {
    return req('POST', `${ADMIN}/orders/${encodeURIComponent(orderId)}/plan`, {});
  },
  publishTasks(orderId: string, runIds: string[], ceremony: Ceremony): Promise<{ ok: true; operations: string[] }> {
    return req('POST', `${ADMIN}/orders/${encodeURIComponent(orderId)}/publish-tasks`, { run_ids: runIds, ...ceremony });
  },
  pause(orderId: string): Promise<{ ok: true }> {
    return req('POST', `${ADMIN}/orders/${encodeURIComponent(orderId)}/pause`, {});
  },
  resume(orderId: string, ceremony: Ceremony): Promise<{ ok: true }> {
    return req('POST', `${ADMIN}/orders/${encodeURIComponent(orderId)}/resume`, { ...ceremony });
  },
  cancel(orderId: string, reason: string, ceremony: Ceremony): Promise<{ ok: true; unresolved_tasks: string[] }> {
    return req('POST', `${ADMIN}/orders/${encodeURIComponent(orderId)}/cancel`, { reason, ...ceremony });
  },
  refund(orderId: string, amountCents: number, reason: string, ceremony: Ceremony): Promise<{ ok: true; operation_id: string }> {
    return req('POST', `${ADMIN}/orders/${encodeURIComponent(orderId)}/refund`, { amount_cents: amountCents, reason, ...ceremony });
  },
  reconcile(orderId: string): Promise<{ ok: true }> {
    return req('POST', `${ADMIN}/orders/${encodeURIComponent(orderId)}/reconcile`, {});
  },
  reviewRun(runId: string, body: {
    expected_version: number; evidence: 'valid' | 'needs_revision' | 'invalid';
    outcome: 'product_success' | 'product_failure' | 'inconclusive' | null;
    environment_demonstrated: boolean | null; slot_satisfied: boolean | null;
    operator_group_id?: string | null; marketplace_action: 'accept' | 'revision' | 'dispute' | 'cancel' | 'none'; note: string;
  } & Ceremony): Promise<{ ok: true; marketplace: { ok: boolean; message: string } }> {
    return req('POST', `${ADMIN}/runs/${encodeURIComponent(runId)}/review`, body);
  },
  replaceAttempt(runId: string, reason: string, ceremony: Ceremony): Promise<{ ok: true }> {
    return req('POST', `${ADMIN}/runs/${encodeURIComponent(runId)}/replace-attempt`, { reason, ...ceremony });
  },
  reportDraft(orderId: string): Promise<{ report: { id: string; version: number; status: string; source_hash?: string; document: TestingReportDoc } }> {
    return req('POST', `${ADMIN}/orders/${encodeURIComponent(orderId)}/report-draft`, {});
  },
  publishReport(reportId: string, sourceHash: string, ceremony: Ceremony): Promise<{ ok: true; published_at: string }> {
    return req('POST', `${ADMIN}/reports/${encodeURIComponent(reportId)}/publish`, { source_hash: sourceHash, ...ceremony });
  },
  upsertEligibility(agentId: string, body: {
    operator_group_id: string; group_confidence: 'unverified' | 'declared' | 'operator_reviewed';
    capabilities: string[]; environments: Array<{ client: string; transport: string }>;
    evidence_refs: string[]; provenance: 'self_reported' | 'operator_reviewed';
    status: 'approved' | 'suspended' | 'revoked'; expires_at: string | null; notes: string;
  }): Promise<{ ok: true }> {
    return req('POST', `${ADMIN}/workers/${encodeURIComponent(agentId)}/eligibility`, body);
  },
  listWorkers(): Promise<{ workers: Array<{ agent_id: string; operator_group_id: string; status: string; provenance: string; environments_json: string; expires_at: string | null }> }> {
    return req('GET', `${ADMIN}/workers`);
  },
  metrics(): Promise<Record<string, unknown>> {
    return req('GET', `${ADMIN}/metrics`);
  },
};
