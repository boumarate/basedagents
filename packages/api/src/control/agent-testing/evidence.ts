/**
 * Agent Testing — automated evidence triage (spec §12.1).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * These checks validate SHAPE and consistency: schema, scope hash, assignment
 * binding, timestamps, size ceilings, hash integrity, secret patterns and
 * duplicate evidence across attempts. Passing them is triage, not proof of
 * authentic execution — the operator decision (admin.ts) stays mandatory, and
 * worker text is DATA: it never alters budgets, permissions or decisions.
 */
import type { DBAdapter } from '../../db/adapter.js';
import { TestingStore, type RunAttemptRow, type RunRow } from './store.js';
import {
  WorkerResultSchema, RESULT_LIMITS, likelySecretFindings, sha256hex,
  environmentFingerprint, type WorkerResult, type EnvironmentRequirement,
} from './schemas.js';

export type ValidationOutcome =
  | { valid: true; result: WorkerResult; evidenceHashes: string[]; warnings: string[] }
  | { valid: false; reason: string; warnings: string[] };

/**
 * Validate a worker submission against its attempt. `content` is the raw
 * submission text (untrusted). Never throws; never logs secret material.
 */
export async function validateWorkerSubmission(
  db: DBAdapter,
  attempt: RunAttemptRow,
  run: RunRow,
  orderId: string,
  content: string,
  nowIso: string,
): Promise<ValidationOutcome> {
  const warnings: string[] = [];
  if (new TextEncoder().encode(content).length > RESULT_LIMITS.maxTotalBytes) {
    return { valid: false, reason: `submission exceeds ${RESULT_LIMITS.maxTotalBytes} bytes`, warnings };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    return { valid: false, reason: 'submission is not valid JSON', warnings };
  }
  const parsed = WorkerResultSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { valid: false, reason: `schema violation at ${first?.path.join('.') || '(root)'}: ${first?.message ?? 'invalid'}`, warnings };
  }
  const result = parsed.data;

  // Binding: this exact assignment and frozen scope.
  if (result.assignment_id !== attempt.id) {
    return { valid: false, reason: 'assignment_id does not match this assignment', warnings };
  }
  if (result.scope_hash !== run.scope_hash) {
    return { valid: false, reason: 'scope_hash does not match the frozen scope', warnings };
  }

  // Timestamps: ordered, not in the future (small skew tolerated).
  const started = Date.parse(result.started_at);
  const finished = Date.parse(result.finished_at);
  const now = Date.parse(nowIso);
  if (!(started < finished)) return { valid: false, reason: 'started_at must be before finished_at', warnings };
  if (finished > now + 5 * 60_000) return { valid: false, reason: 'finished_at is in the future', warnings };

  // Evidence integrity + step references.
  const evidenceIds = new Set(result.evidence.map((e) => e.id));
  for (const ev of result.evidence) {
    if (sha256hex(ev.content) !== ev.content_sha256) {
      return { valid: false, reason: `evidence ${ev.id} content does not match its content_sha256`, warnings };
    }
  }
  for (const step of result.steps) {
    for (const id of step.evidence_ids) {
      if (!evidenceIds.has(id)) return { valid: false, reason: `step ${step.index} cites unknown evidence ${id}`, warnings };
    }
  }
  if (result.first_failure) {
    for (const id of result.first_failure.evidence_ids) {
      if (!evidenceIds.has(id)) return { valid: false, reason: `first_failure cites unknown evidence ${id}`, warnings };
    }
  }
  for (const h of result.hypotheses) {
    for (const id of h.evidence_ids) {
      if (!evidenceIds.has(id)) return { valid: false, reason: 'a hypothesis cites unknown evidence', warnings };
    }
  }
  // A product_failure needs a first failure point; a hypothesis is not an observation.
  if (result.outcome === 'product_failure' && !result.first_failure) {
    return { valid: false, reason: 'product_failure requires a first_failure record', warnings };
  }

  // Prohibited secret patterns anywhere in evidence/steps → rejected (pattern
  // names only; the matching text is never persisted or logged).
  const textBlob = [
    ...result.evidence.map((e) => e.content),
    ...result.steps.map((s) => `${s.action}\n${s.result}`),
  ].join('\n');
  const secrets = likelySecretFindings(textBlob);
  if (secrets.length > 0) {
    return { valid: false, reason: `evidence contains secret-like material (${secrets.join(', ')}); resubmit redacted`, warnings };
  }

  // Required environment fields: client_name + transport present (schema),
  // unknowns stay null — but a claimed native requirement with everything
  // unknown is flagged for the reviewer rather than auto-rejected.
  const envReq = JSON.parse(run.environment_json) as EnvironmentRequirement;
  if (envReq.native_execution_required && !result.environment.os && !result.environment.runtime) {
    warnings.push('environment requires native execution but neither os nor runtime was observed');
  }
  if (result.environment.client_name.trim().toLowerCase() !== envReq.client.trim().toLowerCase()) {
    warnings.push(`declared client "${result.environment.client_name}" differs from required "${envReq.client}"`);
  }
  if (result.environment.transport.trim().toLowerCase() !== envReq.transport.trim().toLowerCase()) {
    warnings.push(`declared transport "${result.environment.transport}" differs from required "${envReq.transport}"`);
  }

  // Duplicate evidence across attempts of the same order → copied submission.
  const store = new TestingStore(db);
  const hashes = result.evidence.map((e) => e.content_sha256);
  for (const h of hashes) {
    if (await store.evidenceHashSeenElsewhere(orderId, attempt.id, h)) {
      return { valid: false, reason: 'evidence duplicates another submission in this order', warnings };
    }
  }

  return { valid: true, result, evidenceHashes: hashes, warnings };
}

/** The observed environment fingerprint of a validated result. */
export function observedFingerprint(result: WorkerResult): string {
  return environmentFingerprint({
    client_name: result.environment.client_name,
    client_version: result.environment.client_version,
    runtime: result.environment.runtime,
    os: result.environment.os,
    architecture: result.environment.architecture,
    transport: result.environment.transport,
  });
}
