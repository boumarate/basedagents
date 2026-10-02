/**
 * Agent Testing — deterministic report assembly and exports (spec §12.4–§12.5).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * The draft is generated from REVIEWED records only. No scores are invented:
 * counts are exact, hypotheses are labeled, the baseline is identified as
 * internal, and a baseline that did not run is disclosed, never a silent
 * pass. Published versions are immutable; a retest appends a new version.
 */
import type { DBAdapter } from '../../db/adapter.js';
import { TestingStore, type OrderRow, type QuoteRow, type RunRow, type ReportRow } from './store.js';
import {
  ReportSchema, FindingSchema, type Report, type Finding, type WorkerResult, hashJson,
} from './schemas.js';
import { parseScope, baselineState, externalRuns } from './planner.js';

const RUN_RESULT_TO_ROW: Record<string, 'product_success' | 'product_failure' | 'inconclusive' | 'evidence_invalid' | 'not_attempted'> = {
  product_success: 'product_success',
  product_failure: 'product_failure',
  inconclusive: 'inconclusive',
  evidence_invalid: 'evidence_invalid',
  pending: 'not_attempted',
  executing: 'not_attempted',
  evidence_submitted: 'not_attempted',
};

function parseResult(json: string | null): WorkerResult | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as WorkerResult;
  } catch {
    return null;
  }
}

/** Distinct observed environment count among valid external runs. */
function distinctEnvironments(rows: Array<{ run: RunRow; result: WorkerResult | null }>): number {
  const keys = new Set<string>();
  for (const { run, result } of rows) {
    if (!['product_success', 'product_failure'].includes(run.result_state)) continue;
    if (result) {
      keys.add([result.environment.client_name, result.environment.client_version ?? '?', result.environment.transport].join('|').toLowerCase());
    } else {
      keys.add(`declared:${run.environment_json}`);
    }
  }
  return keys.size;
}

export interface DraftInputs {
  order: OrderRow;
  quote: QuoteRow;
  runs: RunRow[];
  findings: Finding[];
  version: number;
  reportId: string;
  generatedAt: string;
  previousVersions: Array<{ version: number; published_at: string | null }>;
}

/** Build the deterministic report document (pure function → testable). */
export function buildReportDocument(input: DraftInputs): Report {
  const scope = parseScope(input.quote);
  const ext = externalRuns(input.runs);
  const attemptsByRun = input.attemptResults ?? new Map<string, WorkerResult | null>();

  const rows = ext.concat(input.runs.filter((r) => r.kind === 'retest')).map((run) => {
    const result = attemptsByRun.get(run.id) ?? null;
    const declared = JSON.parse(run.environment_json) as { client: string; transport: string };
    return {
      run_id: run.id,
      kind: run.kind,
      slot: run.slot,
      environment: {
        client: declared.client,
        transport: declared.transport,
        observed_client_version: result?.environment.client_version ?? null,
        observed_runtime: result?.environment.runtime ?? null,
        observed_os: result?.environment.os ?? null,
      },
      result: RUN_RESULT_TO_ROW[run.result_state] ?? 'not_attempted',
      environment_demonstrated: run.environment_demonstrated === null ? null : run.environment_demonstrated === 1,
      first_failure_stage: result?.first_failure?.stage ?? null,
      evidence_ids: result?.evidence.map((e) => e.id) ?? [],
    };
  });

  const valid = ext.filter((r) => ['product_success', 'product_failure'].includes(r.result_state));
  const completed = ext.filter((r) => r.result_state === 'product_success').length;
  const failed = ext.filter((r) => r.result_state === 'product_failure').length;
  const inconclusive = ext.filter((r) => r.result_state === 'inconclusive').length;
  const invalid = ext.filter((r) => r.result_state === 'evidence_invalid').length;
  const groups = new Set(ext.map((r) => r.operator_group_id).filter(Boolean));
  const base = baselineState(input.runs);

  const unknowns: string[] = [];
  if (ext.some((r) => r.environment_demonstrated === null && ['product_success', 'product_failure'].includes(r.result_state))) {
    unknowns.push('environment demonstration could not be confirmed for every run');
  }
  if (groups.size === 0) unknowns.push('operator grouping was not recorded');

  const extResults = ext.map((run) => ({ run: run, result: attemptsByRun.get(run.id) ?? null }));

  const evidenceIndex: Report['evidence_index'] = [];
  for (const { run, result } of extResults) {
    for (const ev of result?.evidence ?? []) {
      evidenceIndex.push({ evidence_id: ev.id, run_id: run.id, kind: ev.kind, content_sha256: ev.content_sha256 });
    }
  }

  const blocking = input.findings.filter((f) => f.severity === 'blocking').length;
  const summaryParts = [
    `${valid.length} of ${ext.length} scoped external executions produced reviewed, evidence-valid outcomes` +
      ` (${completed} completed the workflow, ${failed} found a product failure` +
      (inconclusive ? `, ${inconclusive} inconclusive` : '') + (invalid ? `, ${invalid} with invalid evidence` : '') + ').',
    base.ran
      ? `The internal baseline ${base.result === 'product_success' ? 'completed the workflow' : base.result === 'product_failure' ? 'also hit a failure' : 'was inconclusive'} (internal — not an independent operator result).`
      : 'The internal baseline could not be run; incremental-discovery comparisons are limited accordingly.',
    input.findings.length > 0
      ? `${input.findings.length} finding${input.findings.length === 1 ? '' : 's'} (${blocking} blocking) — ordered by workflow impact below.`
      : 'No findings met the reporting bar in the reviewed evidence.',
  ];

  const doc: Report = {
    schema_version: '1.0',
    report_id: input.reportId,
    order_id: input.order.id,
    version: input.version,
    scope_hash: input.quote.scope_hash,
    workflow_objective: scope.workflow_objective,
    expected_result: scope.expected_result,
    release_identifier: scope.release_identifier,
    observation_period: {
      from: observationFrom(extResults),
      to: observationTo(extResults),
    },
    executive_summary: summaryParts.join(' '),
    coverage: {
      external_runs_planned: input.quote.external_run_slots,
      external_runs_valid: valid.length,
      distinct_environments: distinctEnvironments(extResults),
      reviewed_operator_groups: groups.size,
      unknowns,
    },
    execution_matrix: rows,
    baseline: {
      ran: base.ran,
      result: base.result,
      note: base.ran
        ? 'Run with the same workflow and oracle by BasedAgents internally; identified as internal and never counted as an independent worker result.'
        : 'The baseline did not produce a reviewed outcome. This is disclosed, not treated as a pass, and no incremental-discovery claim is made from it.',
    },
    findings: [...input.findings].sort(bySeverity),
    limitations: [
      `Scope covers exactly one workflow against the frozen scope (hash ${input.quote.scope_hash.slice(0, 16)}…); it is not a security audit, certification, or a universal compatibility score.`,
      `${valid.length} reviewed external execution${valid.length === 1 ? '' : 's'} cannot establish market-wide success rates.`,
      'Operator grouping reflects the best reviewed ownership evidence available and is not proof of independence.',
    ],
    retest: {
      included_slots: input.quote.retest_slots,
      used_slots: input.runs.filter((r) => r.kind === 'retest').length,
      deadline_at: input.order.retest_deadline_at,
    },
    evidence_index: evidenceIndex,
    version_history: [
      ...input.previousVersions.map((v) => ({ version: v.version, published_at: v.published_at, note: v.version === 1 ? 'Initial report' : 'Revision' })),
      { version: input.version, published_at: null, note: input.version === 1 ? 'Initial report' : 'Retest addendum / revision' },
    ],
    generated_at: input.generatedAt,
  };
  return ReportSchema.parse(doc);
}

// The typed extra field (attempt results) — declared via interface merging to
// keep DraftInputs literal-friendly at call sites.
export interface DraftInputs {
  attemptResults?: Map<string, WorkerResult | null>;
}

function bySeverity(a: Finding, b: Finding): number {
  const rank = { blocking: 0, degraded: 1, informational: 2 } as const;
  return rank[a.severity] - rank[b.severity];
}

function observationFrom(rows: Array<{ result: WorkerResult | null }>): string | null {
  const times = rows.map((r) => r.result?.started_at).filter((v): v is string => !!v).sort();
  return times[0] ?? null;
}

function observationTo(rows: Array<{ result: WorkerResult | null }>): string | null {
  const times = rows.map((r) => r.result?.finished_at).filter((v): v is string => !!v).sort();
  return times[times.length - 1] ?? null;
}

/** Derive findings from reviewed runs (starting point the operator can edit). */
export function deriveFindings(runs: RunRow[], results: Map<string, WorkerResult | null>, baseline: WorkerResult | null): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  for (const run of runs.filter((r) => r.kind !== 'baseline')) {
    const result = results.get(run.id);
    if (!result || run.result_state !== 'product_failure' || !result.first_failure) continue;
    n += 1;
    const baselineHitSame = !!baseline?.first_failure && baseline.first_failure.stage === result.first_failure.stage;
    findings.push(FindingSchema.parse({
      finding_id: `f${n}`,
      category: categorize(result.first_failure.stage),
      severity: 'blocking',
      statement_type: 'observed',
      summary: `${result.first_failure.stage}: ${result.first_failure.description}`.slice(0, 2000),
      affected_run_ids: [run.id],
      supporting_evidence_ids: result.first_failure.evidence_ids,
      first_failure_stage: result.first_failure.stage,
      reproduction_steps: result.steps.slice(0, 10).map((s) => s.action),
      suggested_change: '',
      baseline_relation: baseline === null ? 'not_comparable' : baselineHitSame ? 'also_observed' : 'external_only',
      retest_status: 'none',
    }));
  }
  return findings;
}

function categorize(stage: string): Finding['category'] {
  const s = stage.toLowerCase();
  if (s.includes('doc')) return 'documentation';
  if (s.includes('auth')) return 'authentication';
  if (s.includes('discover') || s.includes('lookup')) return 'discovery';
  if (s.includes('schema') || s.includes('tool')) return 'tool_schema';
  if (s.includes('pars')) return 'response_parsing';
  if (s.includes('output') || s.includes('result')) return 'output_correctness';
  if (s.includes('exec') || s.includes('call') || s.includes('request')) return 'execution';
  return 'other';
}

/** Generate (or refresh) the draft report for an order from reviewed records. */
export async function generateDraftReport(db: DBAdapter, orderId: string, nowIso: string): Promise<ReportRow> {
  const store = new TestingStore(db);
  const order = await store.getOrder(orderId);
  if (!order) throw new Error('order not found');
  const quote = await store.getQuote(order.quote_id);
  if (!quote) throw new Error('quote not found');
  const runs = await store.listRuns(orderId);

  const results = new Map<string, WorkerResult | null>();
  for (const run of runs) {
    const attempt = await store.getActiveAttempt(run.id);
    results.set(run.id, attempt?.result_valid ? parseResult(attempt.result_json) : parseResult(run.reviewed_result_json));
  }
  const baselineRun = runs.find((r) => r.kind === 'baseline');
  const baselineResult = baselineRun ? parseResult(baselineRun.reviewed_result_json) : null;
  const findings = deriveFindings(runs, results, baselineResult);

  const published = await store.listReports(orderId);
  const draft = await store.getDraftReport(orderId);
  const version = draft ? draft.version : published.length + 1;
  const reportId = draft?.id ?? 'pending';
  const doc = buildReportDocument({
    order, quote, runs, findings, version,
    reportId,
    generatedAt: nowIso,
    previousVersions: published.filter((r) => r.status === 'published').map((r) => ({ version: r.version, published_at: r.published_at })),
    attemptResults: results,
  });
  const sourceHash = hashJson({ runs: runs.map((r) => ({ id: r.id, state: r.result_state, version: r.version })), findings });

  if (draft) {
    await store.updateDraftReport(draft.id, JSON.stringify(doc), sourceHash);
    return (await store.getReport(draft.id))!;
  }
  const created = await store.createReportDraft({ orderId, reportJson: JSON.stringify(doc), scopeHash: quote.scope_hash, sourceHash });
  if (!created) throw new Error('draft creation raced');
  // Stamp the real report id into the document.
  const withId = { ...doc, report_id: created.id };
  await store.updateDraftReport(created.id, JSON.stringify(withId), sourceHash);
  return (await store.getReport(created.id))!;
}

// ─── exports (spec §4.6): Markdown + JSON with version/scope/timestamps ───

export function renderReportMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# Agent Compatibility Audit — Report v${report.version}`);
  lines.push('');
  lines.push(`- **Report:** ${report.report_id} (version ${report.version})`);
  lines.push(`- **Scope hash:** \`${report.scope_hash}\``);
  lines.push(`- **Release under test:** ${report.release_identifier ?? 'not recorded'}`);
  lines.push(`- **Observation period:** ${report.observation_period.from ?? 'n/a'} → ${report.observation_period.to ?? 'n/a'}`);
  lines.push(`- **Generated:** ${report.generated_at}`);
  lines.push('');
  lines.push('## Workflow');
  lines.push('');
  lines.push(report.workflow_objective);
  lines.push('');
  lines.push(`**Expected result:** ${report.expected_result}`);
  lines.push('');
  lines.push('## Executive summary');
  lines.push('');
  lines.push(report.executive_summary);
  lines.push('');
  lines.push('## Coverage');
  lines.push('');
  lines.push(`- External runs: ${report.coverage.external_runs_valid} valid of ${report.coverage.external_runs_planned} planned`);
  lines.push(`- Distinct environments observed: ${report.coverage.distinct_environments}`);
  lines.push(`- Reviewed operator groups: ${report.coverage.reviewed_operator_groups}`);
  for (const u of report.coverage.unknowns) lines.push(`- Unknown: ${u}`);
  lines.push('');
  lines.push('## Execution matrix');
  lines.push('');
  lines.push('| Run | Kind | Environment | Result | Environment demonstrated | First failure |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of report.execution_matrix) {
    lines.push(`| ${row.run_id} | ${row.kind} | ${row.environment.client} / ${row.environment.transport} | ${row.result.replace(/_/g, ' ')} | ${row.environment_demonstrated === null ? 'unknown' : row.environment_demonstrated ? 'yes' : 'no'} | ${row.first_failure_stage ?? '—'} |`);
  }
  lines.push('');
  lines.push('## Baseline comparison');
  lines.push('');
  lines.push(`Baseline ${report.baseline.ran ? `result: **${report.baseline.result.replace(/_/g, ' ')}**` : 'did not run'}. ${report.baseline.note}`);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (report.findings.length === 0) lines.push('_No findings met the reporting bar in the reviewed evidence._');
  for (const f of report.findings) {
    lines.push(`### ${f.finding_id} — ${f.severity.toUpperCase()} (${f.category.replace(/_/g, ' ')}) — ${f.statement_type}`);
    lines.push('');
    lines.push(f.summary);
    lines.push('');
    lines.push(`- Affected runs: ${f.affected_run_ids.join(', ')}`);
    if (f.supporting_evidence_ids.length) lines.push(`- Evidence: ${f.supporting_evidence_ids.join(', ')}`);
    lines.push(`- Relative to baseline: ${f.baseline_relation.replace(/_/g, ' ')}`);
    if (f.first_failure_stage) lines.push(`- First failure stage: ${f.first_failure_stage}`);
    if (f.reproduction_steps.length) {
      lines.push('- Reproduction:');
      f.reproduction_steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
    }
    if (f.suggested_change) lines.push(`- Suggested change (recommendation, distinct from the observation): ${f.suggested_change}`);
    if (f.retest_status !== 'none') lines.push(`- Retest status: ${f.retest_status.replace(/_/g, ' ')}`);
    lines.push('');
  }
  lines.push('## Limitations');
  lines.push('');
  for (const l of report.limitations) lines.push(`- ${l}`);
  lines.push('');
  lines.push('## Retest entitlement');
  lines.push('');
  lines.push(`- Included targeted retests: ${report.retest.included_slots}, used: ${report.retest.used_slots}` +
    (report.retest.deadline_at ? `, request by ${report.retest.deadline_at}` : ''));
  lines.push('');
  lines.push('## Evidence index');
  lines.push('');
  for (const e of report.evidence_index) lines.push(`- ${e.evidence_id} (run ${e.run_id}, ${e.kind}) sha256 \`${e.content_sha256}\``);
  if (report.evidence_index.length === 0) lines.push('_No evidence records._');
  lines.push('');
  lines.push('## Version history');
  lines.push('');
  for (const v of report.version_history) lines.push(`- v${v.version}: ${v.note}${v.published_at ? ` (published ${v.published_at})` : ' (unpublished)'}`);
  lines.push('');
  return lines.join('\n');
}

export function parseReportRow(row: ReportRow): Report {
  return ReportSchema.parse(JSON.parse(row.report_json));
}
