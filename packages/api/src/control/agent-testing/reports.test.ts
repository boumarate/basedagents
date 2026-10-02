/**
 * Agent Testing — report assembly unit tests (spec §12.4, §20.5).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 */
import { describe, it, expect } from 'vitest';
import { buildReportDocument, deriveFindings, renderReportMarkdown } from './reports.js';
import type { OrderRow, QuoteRow, RunRow } from './store.js';
import type { WorkerResult } from './schemas.js';
import { buildWorkerResult } from './test-harness.js';

const SCOPE = {
  schema_version: '1.0',
  workflow_objective: 'objective',
  expected_result: 'expected',
  allowed_origins: ['https://sandbox.example'],
  documentation_url: 'https://docs.example/x',
  release_identifier: 'r1',
  auth_mode: 'none',
  read_only: true,
  sandbox_write_steps: [],
  fixture: { classification: 'synthetic', inline: '{}' },
  environment_slots: [
    { client: 'claude-code', transport: 'mcp', native_execution_required: true, notes: '' },
    { client: 'openhands', transport: 'http', native_execution_required: true, notes: '' },
    { client: 'aider', transport: 'http', native_execution_required: true, notes: '' },
  ],
  max_requests: 100,
  max_execution_seconds: 1200,
  constraints_note: '',
};

function quote(): QuoteRow {
  return {
    id: 'tquo_1', request_id: 'treq_1', request_version: 1,
    scope_json: JSON.stringify(SCOPE), scope_hash: 'hash-abc',
    package_key: 'agent_compatibility_audit_v1', package_version: 1, stripe_price_id: 'p',
    subtotal_cents: 20000, currency: 'usd', tax_mode: 'none',
    worker_cap_usdc_atomic: '30000000', worker_bounty_usdc_atomic: '5000000',
    external_run_slots: 3, retest_slots: 1, retest_window_days: 14, min_operator_groups: 2,
    terms_version: 't1', disclosure_version: 'd1',
    delivery_target_at: '2026-10-01T00:00:00.000Z', expires_at: '2026-10-01T00:00:00.000Z',
    status: 'accepted', approved_by: 'ow_op', approve_assertion_id: null, approved_at: null,
    created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
  };
}

function order(): OrderRow {
  return {
    id: 'tord_1', owner_id: 'ow_1', quote_id: 'tquo_1', request_id: 'treq_1', source: 'external_customer',
    payment_state: 'succeeded', refund_state: 'none', dispute_state: 'none', fulfillment_state: 'reviewing',
    paused_from_state: null, risk_hold: 0, cancel_requested_at: null, cancel_request_reason: null,
    collected_cents: 20000, tax_cents: 0, refunded_cents: 0,
    initial_report_id: null, initial_report_published_at: null, retest_deadline_at: null,
    previous_order_id: null, version: 1, created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
  };
}

function run(id: string, kind: RunRow['kind'], slot: number, state: string, group: string | null = null): RunRow {
  return {
    id, order_id: 'tord_1', kind, slot, scope_hash: 'hash-abc',
    environment_json: JSON.stringify(SCOPE.environment_slots[Math.max(0, slot - 1)] ?? { client: 'internal', transport: 'internal' }),
    result_state: state, operator_group_id: group, environment_observed_json: null,
    reviewed_result_json: null, environment_demonstrated: state.startsWith('product') ? 1 : null, slot_satisfied: null,
    reviewed_by: null, reviewed_at: null, review_assertion_id: null,
    parent_finding_id: null, parent_run_id: null, version: 1,
    created_at: '2026-09-21T00:00:00.000Z', updated_at: '2026-09-21T00:00:00.000Z',
  };
}

function resultFor(runId: string, outcome: 'product_success' | 'product_failure' | 'inconclusive'): WorkerResult {
  return buildWorkerResult(
    { assignment_id: runId, scope_hash: 'hash-abc', environment_requirement: { client: 'claude-code', transport: 'mcp' } },
    outcome === 'product_failure' ? { outcome, failureStage: 'authentication' } : { outcome: outcome as 'product_success' },
  ) as unknown as WorkerResult;
}

describe('report document (spec §12.4)', () => {
  it('inconclusive and invalid runs stay in the denominator; counts are exact; no invented scores', () => {
    const runs = [
      run('b0', 'baseline', 0, 'product_success'),
      run('e1', 'external', 1, 'product_success', 'g1'),
      run('e2', 'external', 2, 'inconclusive', 'g2'),
      run('e3', 'external', 3, 'evidence_invalid', 'g1'),
    ];
    const results = new Map<string, WorkerResult | null>([['e1', resultFor('e1', 'product_success')], ['e2', null], ['e3', null]]);
    const doc = buildReportDocument({
      order: order(), quote: quote(), runs, findings: [], version: 1, reportId: 'trpt_1',
      generatedAt: '2026-09-26T00:00:00.000Z', previousVersions: [], attemptResults: results,
    });
    expect(doc.coverage.external_runs_planned).toBe(3);
    expect(doc.coverage.external_runs_valid).toBe(1); // only reviewed success/failure count
    const matrix = Object.fromEntries(doc.execution_matrix.map((r) => [r.run_id, r.result]));
    expect(matrix.e2).toBe('inconclusive');
    expect(matrix.e3).toBe('evidence_invalid');
    expect(doc.executive_summary).toContain('1 of 3');
    expect(JSON.stringify(doc)).not.toMatch(/\b\d{1,3}\s*\/\s*100\b/); // no "92/100" style scores
    const md = renderReportMarkdown(doc);
    expect(md).toContain('| e2 |');
    expect(md).toContain('inconclusive');
  });

  it('a baseline that did not run is disclosed and blocks incremental claims (not a silent pass)', () => {
    const runs = [run('b0', 'baseline', 0, 'pending'), run('e1', 'external', 1, 'product_failure', 'g1')];
    const results = new Map<string, WorkerResult | null>([['e1', resultFor('e1', 'product_failure')]]);
    const findings = deriveFindings(runs, results, null);
    expect(findings[0].baseline_relation).toBe('not_comparable');
    const doc = buildReportDocument({
      order: order(), quote: quote(), runs, findings, version: 1, reportId: 'trpt_1',
      generatedAt: '2026-09-26T00:00:00.000Z', previousVersions: [], attemptResults: results,
    });
    expect(doc.baseline.ran).toBe(false);
    expect(doc.baseline.result).toBe('not_run');
    expect(doc.baseline.note).toContain('disclosed');
  });

  it('findings carry evidence references from their own runs; hypotheses stay labeled', () => {
    const runs = [run('b0', 'baseline', 0, 'product_success'), run('e1', 'external', 1, 'product_failure', 'g1')];
    const failure = resultFor('e1', 'product_failure');
    const results = new Map<string, WorkerResult | null>([['e1', failure]]);
    const findings = deriveFindings(runs, results, resultFor('b0', 'product_success'));
    expect(findings).toHaveLength(1);
    expect(findings[0].statement_type).toBe('observed');
    expect(findings[0].affected_run_ids).toEqual(['e1']);
    expect(findings[0].supporting_evidence_ids.length).toBeGreaterThan(0);
    for (const ev of findings[0].supporting_evidence_ids) {
      expect(failure.evidence.map((e) => e.id)).toContain(ev);
    }
    expect(findings[0].category).toBe('authentication'); // from the failure stage
    // Baseline succeeded, external failed → external_only incremental relation.
    expect(findings[0].baseline_relation).toBe('external_only');
  });

  it('severity ordering puts blocking first in the document', () => {
    const runs = [run('e1', 'external', 1, 'product_failure', 'g1')];
    const results = new Map<string, WorkerResult | null>([['e1', resultFor('e1', 'product_failure')]]);
    const auto = deriveFindings(runs, results, null);
    const doc = buildReportDocument({
      order: order(), quote: quote(), runs, version: 1, reportId: 'trpt_1',
      generatedAt: '2026-09-26T00:00:00.000Z', previousVersions: [],
      attemptResults: results,
      findings: [
        { ...auto[0], finding_id: 'f-info', severity: 'informational' },
        { ...auto[0], finding_id: 'f-block', severity: 'blocking' },
      ],
    });
    expect(doc.findings[0].finding_id).toBe('f-block');
  });
});
