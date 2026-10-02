/**
 * Agent Testing — validated contracts: intake, frozen scope, worker brief,
 * worker result, findings and report. One Zod source of truth; the worker
 * result contract is also exported as JSON Schema for workers (spec §11).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 */
import { z } from 'zod';
import { sha256, bytesToHex, canonicalJsonStringify } from '../../crypto/index.js';

// ─── shared helpers ───

const textEncoder = new TextEncoder();

export function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

/** Deterministic hash of a JSON value (canonical key order). */
export function hashJson(value: unknown): string {
  return sha256hex(canonicalJsonStringify(value as Record<string, unknown>));
}

const HTTPS_URL_MAX = 2048;

/** HTTPS URL with no embedded credentials (spec §4.3). */
const httpsUrl = z
  .string()
  .max(HTTPS_URL_MAX)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && u.username === '' && u.password === '';
    } catch {
      return false;
    }
  }, 'must be an https:// URL without embedded credentials');

// ─── secret heuristics (server-side backstop, spec §4.3 / §14) ───
//
// A warning net, not the contract: the no-secrets rule is contractual and
// operator-reviewed; these patterns catch the obvious accidents. Matches are
// REJECTED and never logged verbatim.

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{30,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'password_assignment', re: /\bpassword\s*[:=]\s*[^\s'"]{6,}/i },
  { name: 'authorization_header', re: /\bauthorization\s*[:=]\s*(?:bearer|basic)\s+\S{8,}/i },
];

/** The names of secret-like patterns found in `text` (empty = none). */
export function likelySecretFindings(text: string): string[] {
  const found: string[] = [];
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) found.push(p.name);
  return found;
}

// ─── intake (spec §4.3) ───

export const PRODUCT_CATEGORIES = ['api', 'mcp', 'other'] as const;
export const AUTH_MODES = ['none', 'worker_owned_test_account'] as const;

export const IntakeSchema = z
  .object({
    product_name: z.string().min(1).max(120),
    product_category: z.enum(PRODUCT_CATEGORIES),
    product_url: httpsUrl,
    documentation_url: httpsUrl,
    workflow_objective: z.string().min(1).max(2000),
    expected_result: z.string().min(1).max(4000),
    fixture: z.object({
      classification: z.literal('synthetic'),
      inline: z.string().max(8000).optional(),
      url: httpsUrl.optional(),
    }).strict(),
    target_environment: z.string().min(1).max(500),
    release_identifier: z.string().max(200).nullable().default(null),
    auth_mode: z.enum(AUTH_MODES),
    allowed_operations: z.object({
      read_only: z.boolean().default(true),
      sandbox_write_steps: z.array(z.string().max(300)).max(10).default([]),
    }).strict().default({ read_only: true, sandbox_write_steps: [] }),
    coverage_preferences: z.array(z.string().max(120)).max(10).default([]),
    known_constraints: z.string().max(2000).default(''),
    authority_declaration: z.literal(true),
    worker_disclosure_acknowledged: z.literal(true),
    suspected_failure: z.string().max(2000).default(''),
  })
  .strict();

export type Intake = z.infer<typeof IntakeSchema>;

/** Secret scan over the free-text intake fields; returns pattern names found. */
export function intakeSecretFindings(intake: Intake): string[] {
  const joined = [
    intake.workflow_objective, intake.expected_result, intake.fixture.inline ?? '',
    intake.known_constraints, intake.suspected_failure, intake.target_environment,
    ...intake.allowed_operations.sandbox_write_steps,
  ].join('\n');
  return likelySecretFindings(joined);
}

// ─── frozen quote scope (operator-approved; hashed) ───

export const EnvironmentRequirementSchema = z
  .object({
    client: z.string().min(1).max(120),
    transport: z.string().min(1).max(120),
    native_execution_required: z.boolean().default(true),
    notes: z.string().max(500).default(''),
  })
  .strict();

export type EnvironmentRequirement = z.infer<typeof EnvironmentRequirementSchema>;

export const QuoteScopeSchema = z
  .object({
    schema_version: z.literal('1.0'),
    workflow_objective: z.string().min(1).max(2000),
    expected_result: z.string().min(1).max(4000),
    allowed_origins: z.array(httpsUrl).min(1).max(5),
    documentation_url: httpsUrl,
    release_identifier: z.string().max(200).nullable(),
    auth_mode: z.enum(AUTH_MODES),
    read_only: z.boolean(),
    sandbox_write_steps: z.array(z.string().max(300)).max(10),
    fixture: z.object({
      classification: z.literal('synthetic'),
      inline: z.string().max(8000).optional(),
      url: httpsUrl.optional(),
    }).strict(),
    environment_slots: z.array(EnvironmentRequirementSchema).min(1).max(5),
    max_requests: z.number().int().min(1).max(1000),
    max_execution_seconds: z.number().int().min(60).max(7200),
    constraints_note: z.string().max(2000),
  })
  .strict();

export type QuoteScope = z.infer<typeof QuoteScopeSchema>;

export function scopeHash(scope: QuoteScope): string {
  return hashJson(scope);
}

// ─── environment identity (spec §9.2) ───

/** Normalized non-secret fields → deterministic environment fingerprint. */
export function environmentFingerprint(env: {
  client_name: string;
  client_version?: string | null;
  runtime?: string | null;
  os?: string | null;
  architecture?: string | null;
  transport: string;
}): string {
  const norm = (v: string | null | undefined) => (v ?? 'unknown').trim().toLowerCase();
  return sha256hex(
    ['v1', norm(env.client_name), norm(env.client_version), norm(env.runtime), norm(env.os), norm(env.architecture), norm(env.transport)].join('|'),
  ).slice(0, 32);
}

// ─── worker private brief (spec §11.2) ───

export const WorkerBriefSchema = z
  .object({
    schema_version: z.literal('1.0'),
    assignment_id: z.string(),
    run_id: z.string(),
    scope_hash: z.string(),
    task_type: z.literal('external_agent_compatibility_test'),
    objective: z.string(),
    target: z.object({
      documentation_url: z.string(),
      allowed_origins: z.array(z.string()),
      release_identifier: z.string().nullable(),
    }),
    environment_requirement: z.object({
      client: z.string(),
      transport: z.string(),
      native_execution_required: z.boolean(),
    }),
    fixture: z.object({
      classification: z.literal('synthetic'),
      input: z.unknown(),
      expected_output: z.unknown(),
      comparison_rules: z.array(z.string()),
    }),
    procedure: z.array(z.string()),
    constraints: z.object({
      maximum_external_spend_usd_cents: z.literal(0),
      maximum_requests: z.number().int(),
      maximum_execution_seconds: z.number().int(),
      production_writes: z.boolean(),
      allowed_sandbox_write_steps: z.array(z.string()),
      customer_credentials_provided: z.literal(false),
      public_posting: z.literal(false),
      unapproved_source_inspection: z.literal(false),
    }),
    acceptance: z.object({
      positive_product_result_required: z.literal(false),
      actual_execution_required: z.literal(true),
      required_environment_evidence: z.literal(true),
      redacted_trace_required: z.literal(true),
      result_schema_version: z.literal('1.0'),
    }),
  })
  .strict();

export type WorkerBrief = z.infer<typeof WorkerBriefSchema>;

// ─── worker result (spec §11.3) ───

/** Size ceilings: 30 steps, 30 evidence items, 4 KiB per text item, 64 KiB total. */
export const RESULT_LIMITS = {
  maxSteps: 30,
  maxEvidence: 30,
  maxTextBytes: 4096,
  maxTotalBytes: 65536,
} as const;

export const RUN_OUTCOMES = ['product_success', 'product_failure', 'inconclusive'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

const boundedText = z.string().max(RESULT_LIMITS.maxTextBytes);

export const WorkerResultSchema = z
  .object({
    schema_version: z.literal('1.0'),
    assignment_id: z.string().min(1).max(128),
    scope_hash: z.string().min(1).max(128),
    started_at: z.string().datetime({ offset: true }),
    finished_at: z.string().datetime({ offset: true }),
    outcome: z.enum(RUN_OUTCOMES),
    environment: z.object({
      client_name: z.string().min(1).max(200),
      client_version: z.string().max(200).nullable(),
      runtime: z.string().max(200).nullable(),
      os: z.string().max(200).nullable(),
      architecture: z.string().max(200).nullable(),
      model_identifier: z.string().max(200).nullable(),
      transport: z.string().min(1).max(200),
      configuration_redacted: z.record(z.string().max(500)).default({}),
    }),
    steps: z.array(z.object({
      index: z.number().int().min(1),
      action: boundedText,
      observed_at: z.string().datetime({ offset: true }),
      result: boundedText,
      evidence_ids: z.array(z.string().max(64)).max(10).default([]),
    })).min(1).max(RESULT_LIMITS.maxSteps),
    evidence: z.array(z.object({
      id: z.string().min(1).max(64),
      kind: z.enum(['redacted_tool_output', 'redacted_http_exchange', 'observed_text', 'comparison']),
      content: boundedText,
      request_id: z.string().max(200).nullable().default(null),
      content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })).max(RESULT_LIMITS.maxEvidence),
    output: z.unknown(),
    expected_output_comparison: z.object({
      matched: z.boolean().nullable(),
      checks: z.array(z.object({ rule: boundedText, passed: z.boolean() })).max(20).default([]),
    }),
    first_failure: z.object({
      stage: z.string().max(200),
      description: boundedText,
      evidence_ids: z.array(z.string().max(64)).max(10).default([]),
    }).nullable().default(null),
    hypotheses: z.array(z.object({
      statement: boundedText,
      evidence_ids: z.array(z.string().max(64)).max(10).default([]),
    })).max(10).default([]),
    limitations: z.array(boundedText).max(10).default([]),
    attestations: z.object({
      actual_execution: z.literal(true),
      authorized_materials_only: z.literal(true),
      secrets_redacted: z.literal(true),
    }),
  })
  .strict();

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

// ─── finding model (spec §12.3) ───

export const FINDING_CATEGORIES = [
  'documentation', 'authentication', 'discovery', 'tool_schema',
  'execution', 'response_parsing', 'output_correctness', 'other',
] as const;
export const FINDING_SEVERITIES = ['blocking', 'degraded', 'informational'] as const;
export const STATEMENT_TYPES = ['observed', 'hypothesis'] as const;
export const BASELINE_RELATIONS = ['also_observed', 'external_only', 'not_comparable'] as const;

export const FindingSchema = z
  .object({
    finding_id: z.string().min(1).max(64),
    category: z.enum(FINDING_CATEGORIES),
    severity: z.enum(FINDING_SEVERITIES),
    statement_type: z.enum(STATEMENT_TYPES),
    summary: z.string().min(1).max(2000),
    affected_run_ids: z.array(z.string()).min(1).max(10),
    supporting_evidence_ids: z.array(z.string()).max(20).default([]),
    first_failure_stage: z.string().max(200).nullable().default(null),
    reproduction_steps: z.array(z.string().max(1000)).max(15).default([]),
    suggested_change: z.string().max(2000).default(''),
    baseline_relation: z.enum(BASELINE_RELATIONS),
    retest_status: z.enum(['none', 'requested', 'retested_fixed', 'retested_still_failing', 'retested_inconclusive']).default('none'),
  })
  .strict();

export type Finding = z.infer<typeof FindingSchema>;

// ─── report (spec §12.4) ───

export const ReportRunRowSchema = z.object({
  run_id: z.string(),
  kind: z.enum(['baseline', 'external', 'retest']),
  slot: z.number().int(),
  environment: z.object({
    client: z.string(),
    transport: z.string(),
    observed_client_version: z.string().nullable(),
    observed_runtime: z.string().nullable(),
    observed_os: z.string().nullable(),
  }),
  result: z.enum(['product_success', 'product_failure', 'inconclusive', 'evidence_invalid', 'not_attempted']),
  environment_demonstrated: z.boolean().nullable(),
  first_failure_stage: z.string().nullable(),
  evidence_ids: z.array(z.string()).default([]),
});

export const ReportSchema = z
  .object({
    schema_version: z.literal('1.0'),
    report_id: z.string(),
    order_id: z.string(),
    version: z.number().int().min(1),
    scope_hash: z.string(),
    workflow_objective: z.string(),
    expected_result: z.string(),
    release_identifier: z.string().nullable(),
    observation_period: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
    executive_summary: z.string().max(4000),
    coverage: z.object({
      external_runs_planned: z.number().int(),
      external_runs_valid: z.number().int(),
      distinct_environments: z.number().int(),
      reviewed_operator_groups: z.number().int(),
      unknowns: z.array(z.string()).default([]),
    }),
    execution_matrix: z.array(ReportRunRowSchema),
    baseline: z.object({
      ran: z.boolean(),
      result: z.enum(['product_success', 'product_failure', 'inconclusive', 'not_run']),
      note: z.string().max(2000),
    }),
    findings: z.array(FindingSchema),
    limitations: z.array(z.string().max(1000)),
    retest: z.object({
      included_slots: z.number().int(),
      used_slots: z.number().int(),
      deadline_at: z.string().nullable(),
    }),
    evidence_index: z.array(z.object({
      evidence_id: z.string(),
      run_id: z.string(),
      kind: z.string(),
      content_sha256: z.string(),
    })),
    version_history: z.array(z.object({
      version: z.number().int(),
      published_at: z.string().nullable(),
      note: z.string().max(500),
    })),
    generated_at: z.string(),
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;

// ─── JSON Schema export for workers (spec §11.2 / §22.3) ───
//
// Hand-maintained JSON Schema mirroring WorkerResultSchema — kept small and
// versioned; the Zod schema is authoritative and the contract test asserts
// that documents valid here parse there.
export const WORKER_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://basedagents.ai/schema/testing/worker-result-1.0.json',
  title: 'BasedAgents Agent Testing — worker result v1.0',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version', 'assignment_id', 'scope_hash', 'started_at', 'finished_at', 'outcome',
    'environment', 'steps', 'evidence', 'output', 'expected_output_comparison', 'attestations',
  ],
  properties: {
    schema_version: { const: '1.0' },
    assignment_id: { type: 'string', maxLength: 128 },
    scope_hash: { type: 'string', maxLength: 128 },
    started_at: { type: 'string', format: 'date-time' },
    finished_at: { type: 'string', format: 'date-time' },
    outcome: { enum: ['product_success', 'product_failure', 'inconclusive'] },
    environment: {
      type: 'object',
      required: ['client_name', 'transport'],
      properties: {
        client_name: { type: 'string', maxLength: 200 },
        client_version: { type: ['string', 'null'], maxLength: 200 },
        runtime: { type: ['string', 'null'], maxLength: 200 },
        os: { type: ['string', 'null'], maxLength: 200 },
        architecture: { type: ['string', 'null'], maxLength: 200 },
        model_identifier: { type: ['string', 'null'], maxLength: 200 },
        transport: { type: 'string', maxLength: 200 },
        configuration_redacted: { type: 'object' },
      },
    },
    steps: {
      type: 'array', minItems: 1, maxItems: RESULT_LIMITS.maxSteps,
      items: {
        type: 'object',
        required: ['index', 'action', 'observed_at', 'result'],
        properties: {
          index: { type: 'integer', minimum: 1 },
          action: { type: 'string', maxLength: RESULT_LIMITS.maxTextBytes },
          observed_at: { type: 'string', format: 'date-time' },
          result: { type: 'string', maxLength: RESULT_LIMITS.maxTextBytes },
          evidence_ids: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        },
      },
    },
    evidence: {
      type: 'array', maxItems: RESULT_LIMITS.maxEvidence,
      items: {
        type: 'object',
        required: ['id', 'kind', 'content', 'content_sha256'],
        properties: {
          id: { type: 'string', maxLength: 64 },
          kind: { enum: ['redacted_tool_output', 'redacted_http_exchange', 'observed_text', 'comparison'] },
          content: { type: 'string', maxLength: RESULT_LIMITS.maxTextBytes },
          request_id: { type: ['string', 'null'], maxLength: 200 },
          content_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
      },
    },
    output: {},
    expected_output_comparison: {
      type: 'object',
      required: ['matched'],
      properties: {
        matched: { type: ['boolean', 'null'] },
        checks: { type: 'array', items: { type: 'object', required: ['rule', 'passed'], properties: { rule: { type: 'string' }, passed: { type: 'boolean' } } }, maxItems: 20 },
      },
    },
    first_failure: {
      type: ['object', 'null'],
      required: ['stage', 'description'],
      properties: {
        stage: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: RESULT_LIMITS.maxTextBytes },
        evidence_ids: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      },
    },
    hypotheses: {
      type: 'array', maxItems: 10,
      items: { type: 'object', required: ['statement'], properties: { statement: { type: 'string' }, evidence_ids: { type: 'array', items: { type: 'string' }, maxItems: 10 } } },
    },
    limitations: { type: 'array', items: { type: 'string', maxLength: RESULT_LIMITS.maxTextBytes }, maxItems: 10 },
    attestations: {
      type: 'object',
      required: ['actual_execution', 'authorized_materials_only', 'secrets_redacted'],
      properties: {
        actual_execution: { const: true },
        authorized_materials_only: { const: true },
        secrets_redacted: { const: true },
      },
    },
  },
};
