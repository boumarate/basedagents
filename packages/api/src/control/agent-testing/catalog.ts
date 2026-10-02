/**
 * Agent Testing — package catalog, feature flags and production readiness.
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * The launch package is a VERSIONED server-side configuration, not marketing
 * copy: quotes freeze a snapshot of it, so changing the defaults here never
 * rewrites an already-approved quote. All flags default OFF — a fresh deploy
 * sells nothing until an operator deliberately enables it (spec §19).
 *
 * Monetary fields: customer money in integer USD cents; worker commitments in
 * USDC atomic units (6 dp) as decimal strings. Never floats.
 */

export interface TestingPackage {
  package_key: string;
  package_version: number;
  currency: 'usd';
  price_cents: number;
  billing: 'one_time';
  workflows: number;
  initial_external_run_slots: number;
  minimum_distinct_operator_groups: number;
  minimum_distinct_environment_fingerprints: number;
  internal_baseline_runs: number;
  included_targeted_retest_slots: number;
  retest_request_window_days: number;
  quote_validity_days: number;
  worker_bounty_usdc_atomic: string;
  maximum_worker_commitment_usdc_atomic: string;
  maximum_external_spend_per_worker_usd_cents: number;
  maximum_active_orders_default: number;
  terms_version: string;
  disclosure_version: string;
}

/** Proposed launch package (spec §1.3) — defaults, not authorization to spend. */
export const PACKAGE_V1: TestingPackage = {
  package_key: 'agent_compatibility_audit_v1',
  package_version: 1,
  currency: 'usd',
  price_cents: 20000,
  billing: 'one_time',
  workflows: 1,
  initial_external_run_slots: 3,
  minimum_distinct_operator_groups: 2,
  minimum_distinct_environment_fingerprints: 3,
  internal_baseline_runs: 1,
  included_targeted_retest_slots: 1,
  retest_request_window_days: 14,
  quote_validity_days: 7,
  worker_bounty_usdc_atomic: '5000000',
  maximum_worker_commitment_usdc_atomic: '30000000',
  maximum_external_spend_per_worker_usd_cents: 0,
  maximum_active_orders_default: 5,
  terms_version: 'testing-terms-v1',
  disclosure_version: 'testing-disclosure-v1',
};

/** Opaque env map, same pattern as control/config.ts — no Bindings widening. */
export function testingEnv(env: unknown): Record<string, string | undefined> {
  return (env ?? {}) as Record<string, string | undefined>;
}

export interface TestingFlags {
  productEnabled: boolean;
  checkoutEnabled: boolean;
  fulfillmentEnabled: boolean;
  liveApproved: boolean;
}

export function testingFlags(env: unknown): TestingFlags {
  const e = testingEnv(env);
  return {
    productEnabled: e.TESTING_PRODUCT_ENABLED === '1' || e.TESTING_PRODUCT_ENABLED === 'true',
    checkoutEnabled: e.TESTING_CHECKOUT_ENABLED === '1' || e.TESTING_CHECKOUT_ENABLED === 'true',
    fulfillmentEnabled: e.TESTING_FULFILLMENT_ENABLED === '1' || e.TESTING_FULFILLMENT_ENABLED === 'true',
    liveApproved: e.TESTING_PRODUCT_LIVE_APPROVED === '1' || e.TESTING_PRODUCT_LIVE_APPROVED === 'true',
  };
}

/** The active package for this deployment (env may cap orders / override support email). */
export function activePackage(env: unknown): TestingPackage {
  const e = testingEnv(env);
  const pkg = { ...PACKAGE_V1 };
  const maxOrders = parseInt(e.TESTING_MAX_ACTIVE_ORDERS ?? '', 10);
  if (Number.isFinite(maxOrders) && maxOrders > 0) pkg.maximum_active_orders_default = maxOrders;
  const cap = e.TESTING_MAX_WORKER_COMMITMENT_USDC_ATOMIC;
  if (cap && /^[0-9]{1,15}$/.test(cap)) pkg.maximum_worker_commitment_usdc_atomic = cap;
  return pkg;
}

export function supportEmail(env: unknown): string {
  return testingEnv(env).TESTING_SUPPORT_EMAIL || 'support@basedagents.ai';
}

/** Retention windows (spec §14.4), configurable. */
export function retentionDays(env: unknown): { evidence: number; reports: number; drafts: number } {
  const e = testingEnv(env);
  const n = (v: string | undefined, dflt: number) => {
    const parsed = parseInt(v ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : dflt;
  };
  return {
    evidence: n(e.TESTING_EVIDENCE_RETENTION_DAYS, 90),
    reports: n(e.TESTING_REPORT_RETENTION_DAYS, 365),
    drafts: n(e.TESTING_DRAFT_RETENTION_DAYS, 30),
  };
}

/**
 * Why checkout is unavailable right now, or null when every readiness gate is
 * green (spec §19). A missing item DISABLES checkout with useful copy — it
 * never fakes success. `emailConfigured` is passed in by the caller because
 * the sender can be injected (tests) or env-derived (RESEND_API_KEY).
 */
export function checkoutDisabledReason(
  env: unknown,
  opts: { emailConfigured: boolean; stripeConfigured: boolean },
): string | null {
  const flags = testingFlags(env);
  const e = testingEnv(env);
  if (!flags.productEnabled) return 'The testing product is not enabled on this deployment.';
  if (!flags.checkoutEnabled) return 'Checkout is not open yet. You can submit a request — we confirm coverage before any payment is taken.';
  if (!opts.stripeConfigured) return 'Payments are not configured yet.';
  if (!e.STRIPE_PRICE_TESTING_AUDIT) return 'The audit package price is not configured yet.';
  if (!opts.emailConfigured) return 'Transactional email is not configured; purchases would be undeliverable.';
  return null;
}

/**
 * Published coverage for the public catalog: shaped from operator-approved
 * eligibility data by the caller. This module only defines the safe shape —
 * client/transport labels and counts of distinct fingerprints, never worker
 * identities, group ids, or capacity numbers.
 */
export interface PublishedCoverage {
  environments: Array<{ client: string; transport: string }>;
  distinct_environments: number;
  reviewed_operator_groups_at_least: number;
}
