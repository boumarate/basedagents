/**
 * Acquisition reporting: the pure query layer shared by the bearer-token admin
 * endpoint (routes/acquisition.ts) and the console admin page
 * (control/admin.ts). Conversions are DERIVED from committed domain state
 * (tasks, delivery receipts, settled payments via PAID_WHERE) joined to the
 * attribution tables — client-reported telemetry can never appear here as a
 * conversion.
 *
 * Reading the numbers honestly:
 *   - Observed installations are distinct stable installation ids — not npm
 *     downloads, process launches or tools/list calls, and not people.
 *   - The COHORT view groups by when (and from where) an entity was acquired;
 *     the ACTIVITY view counts events inside the period. The two never share
 *     a denominator.
 *   - `unknown` is its own row, never renamed organic/direct/registry.
 *   - Buyer and worker attribution stay separate: one task's buyer and worker
 *     can come from different sources, and their USDC columns are never added
 *     together. Settled worker USDC is payouts, not revenue.
 *   - Human (console) buyers have no acquisition source in this model; they
 *     appear as the separate `human_buyer` bucket keyed on owner creation.
 *   - A 7-day returning agent had a successful meaningful (non-discovery) use
 *     in [entry+7d, entry+14d); cohorts younger than 14 days are immature and
 *     flagged rather than silently mixed in.
 */
import type { DBAdapter } from '../db/adapter.js';
import { PAID_WHERE, houseAccountIds } from '../tasks/settled.js';
import { atomicToDisplay } from '../payments/x402.js';

export interface ReportFilters {
  /** ISO timestamps: from inclusive, to exclusive. */
  from: string;
  to: string;
  source?: string;
  campaign?: string;
  iface?: string;
  /** Default false: internal/house traffic is excluded. */
  includeInternal: boolean;
  /** HOUSE_ACCOUNT_IDS ∪ INTERNAL_AGENT_IDS — never from a client header. */
  internalIds: Set<string>;
  now?: Date;
}

/** Parse the two env lists into the internal-id set (house ∪ monitoring). */
export function internalIdSet(env: { HOUSE_ACCOUNT_IDS?: string; INTERNAL_AGENT_IDS?: string } | undefined): Set<string> {
  const set = houseAccountIds(env?.HOUSE_ACCOUNT_IDS);
  for (const id of houseAccountIds(env?.INTERNAL_AGENT_IDS)) set.add(id);
  return set;
}

export interface InstallationCohortRow {
  source: string;
  observed_installations: number;
  known_at_first_observation: number;
  known_ever: number;
}

export interface AgentCohortRow {
  source: string;
  new_agents: number;
  agents_with_first_claim: number;
  agents_with_first_accepted_delivery: number;
  first_paid_agents: number;
  settled_worker_usdc_atomic: string;
  settled_worker_usdc: string;
  buyers_with_first_funded_task: number;
  repeat_funded_buyers: number;
  returning_7d: number;
  mature_agents: number;
  immature_agents: number;
}

export interface CohortReport {
  view: 'cohort';
  from: string;
  to: string;
  include_internal: boolean;
  installations: InstallationCohortRow[];
  agents: AgentCohortRow[];
  /** The separate human-buyer bucket (owner accounts; no acquisition source). */
  human_buyers: { new_owners: number; buyers_with_first_funded_task: number; repeat_funded_buyers: number };
  coverage: {
    observed_installations: number;
    known_at_first_observation: number;
    known_ever: number;
    /** null = N/A (zero denominator). */
    coverage_at_first_pct: number | null;
    coverage_ever_pct: number | null;
  };
}

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

function internalFilter(f: ReportFilters, column: string): { sql: string; params: unknown[] } {
  if (f.includeInternal || f.internalIds.size === 0) return { sql: '', params: [] };
  const ids = [...f.internalIds];
  return { sql: ` AND ${column} NOT IN (${ids.map(() => '?').join(',')})`, params: ids };
}

export async function cohortReport(db: DBAdapter, f: ReportFilters): Promise<CohortReport> {
  const nowIso = (f.now ?? new Date()).toISOString();

  // ── Installations, by source at the earliest KNOWN observation ──
  const instWhere: string[] = ['first_observed_at >= ?', 'first_observed_at < ?'];
  const instParams: unknown[] = [f.from, f.to];
  if (f.campaign) { instWhere.push(`COALESCE(NULLIF(first_known_campaign, ''), campaign_at_first_observation) = ?`); instParams.push(f.campaign); }
  if (f.iface) { instWhere.push('interface = ?'); instParams.push(f.iface); }
  const installations = await db.all<InstallationCohortRow>(
    `SELECT COALESCE(first_known_source, 'unknown') AS source,
            COUNT(*) AS observed_installations,
            SUM(CASE WHEN source_at_first_observation <> 'unknown' THEN 1 ELSE 0 END) AS known_at_first_observation,
            SUM(CASE WHEN first_known_source IS NOT NULL THEN 1 ELSE 0 END) AS known_ever
     FROM mcp_installations
     WHERE ${instWhere.join(' AND ')}
     GROUP BY 1 ORDER BY observed_installations DESC, source`,
    ...instParams,
  );

  // ── Agent cohort: per-agent committed-state flags, rolled up by source ──
  const internal = internalFilter(f, 'aa.agent_id');
  const agentWhere: string[] = ['aa.registered_at >= ?', 'aa.registered_at < ?'];
  const agentParams: unknown[] = [f.from, f.to];
  if (f.campaign) { agentWhere.push('aa.campaign = ?'); agentParams.push(f.campaign); }
  if (f.iface) { agentWhere.push('aa.interface = ?'); agentParams.push(f.iface); }
  const agentRows = await db.all<{
    source: string; new_agents: number; agents_with_first_claim: number;
    agents_with_first_accepted_delivery: number; first_paid_agents: number;
    settled_worker_usdc_atomic: number; buyers_with_first_funded_task: number;
    repeat_funded_buyers: number; returning_7d: number; mature_agents: number;
  }>(
    `WITH cohort AS (
       SELECT aa.agent_id, aa.source, aa.registered_at
       FROM agent_acquisition aa
       WHERE ${agentWhere.join(' AND ')}${internal.sql}
     ),
     per_agent AS (
       SELECT c.source,
         (SELECT COUNT(*) > 0 FROM tasks t WHERE t.claimed_by_agent_id = c.agent_id AND t.claimed_at IS NOT NULL) AS has_claim,
         (SELECT COUNT(*) > 0 FROM tasks t WHERE t.claimed_by_agent_id = c.agent_id AND t.verified_at IS NOT NULL) AS has_accept,
         (SELECT COUNT(*) > 0 FROM tasks t WHERE t.claimed_by_agent_id = c.agent_id AND ${PAID_WHERE}) AS has_paid,
         COALESCE((SELECT SUM(CAST(t.bounty_amount AS INTEGER)) FROM tasks t WHERE t.claimed_by_agent_id = c.agent_id AND ${PAID_WHERE}), 0) AS paid_atomic,
         (SELECT COUNT(*) FROM tasks t WHERE t.creator_agent_id = c.agent_id AND t.escrow_funded_at IS NOT NULL) AS funded_tasks,
         (date(substr(c.registered_at, 1, 10), '+14 days') <= date(substr(?, 1, 10))) AS mature,
         (SELECT COUNT(*) > 0 FROM installation_usage_daily u
            WHERE u.agent_id = c.agent_id AND u.kind = 'meaningful'
              AND u.day >= date(substr(c.registered_at, 1, 10), '+7 days')
              AND u.day <  date(substr(c.registered_at, 1, 10), '+14 days')) AS returning7
       FROM cohort c
     )
     SELECT source,
       COUNT(*) AS new_agents,
       SUM(has_claim) AS agents_with_first_claim,
       SUM(has_accept) AS agents_with_first_accepted_delivery,
       SUM(has_paid) AS first_paid_agents,
       SUM(paid_atomic) AS settled_worker_usdc_atomic,
       SUM(CASE WHEN funded_tasks >= 1 THEN 1 ELSE 0 END) AS buyers_with_first_funded_task,
       SUM(CASE WHEN funded_tasks >= 2 THEN 1 ELSE 0 END) AS repeat_funded_buyers,
       SUM(CASE WHEN mature AND returning7 THEN 1 ELSE 0 END) AS returning_7d,
       SUM(mature) AS mature_agents
     FROM per_agent GROUP BY source ORDER BY new_agents DESC, source`,
    // Placeholder order mirrors the SQL: cohort WHERE (period + filters +
    // internal ids), then per_agent's maturity timestamp.
    ...agentParams, ...internal.params, nowIso,
  );

  // ── Human buyers: the separate bucket (owners have no acquisition source).
  // `owners` is a control-plane table that an OSS deploy may not carry, so a
  // missing table reads as an empty bucket rather than a failed report. ──
  const ownerInternal = internalFilter(f, 'o.id');
  let humanBuyers = { new_owners: 0, funded: 0, repeat_funded: 0 };
  try {
    humanBuyers = (await db.get<{ new_owners: number; funded: number; repeat_funded: number }>(
      `WITH owner_cohort AS (
         SELECT o.id FROM owners o
         -- normalize: a CURRENT_TIMESTAMP default is 'YYYY-MM-DD HH:MM:SS', not ISO
         WHERE strftime('%Y-%m-%dT%H:%M:%fZ', o.created_at) >= ? AND strftime('%Y-%m-%dT%H:%M:%fZ', o.created_at) < ?${ownerInternal.sql}
       ),
       per_owner AS (
         SELECT (SELECT COUNT(*) FROM tasks t WHERE t.creator_owner_id = oc.id AND t.escrow_funded_at IS NOT NULL) AS funded_tasks
         FROM owner_cohort oc
       )
       SELECT COUNT(*) AS new_owners,
         COALESCE(SUM(CASE WHEN funded_tasks >= 1 THEN 1 ELSE 0 END), 0) AS funded,
         COALESCE(SUM(CASE WHEN funded_tasks >= 2 THEN 1 ELSE 0 END), 0) AS repeat_funded
       FROM per_owner`,
      f.from, f.to, ...ownerInternal.params,
    ))!;
  } catch {
    /* no owners table: control plane absent */
  }

  const sourceFilter = <T extends { source: string }>(rows: T[]): T[] =>
    f.source ? rows.filter((r) => r.source === f.source) : rows;
  const agents: AgentCohortRow[] = sourceFilter(agentRows).map((r) => ({
    source: r.source,
    new_agents: r.new_agents,
    agents_with_first_claim: r.agents_with_first_claim,
    agents_with_first_accepted_delivery: r.agents_with_first_accepted_delivery,
    first_paid_agents: r.first_paid_agents,
    settled_worker_usdc_atomic: String(r.settled_worker_usdc_atomic),
    settled_worker_usdc: atomicToDisplay(String(r.settled_worker_usdc_atomic)),
    buyers_with_first_funded_task: r.buyers_with_first_funded_task,
    repeat_funded_buyers: r.repeat_funded_buyers,
    returning_7d: r.returning_7d,
    mature_agents: r.mature_agents,
    immature_agents: r.new_agents - r.mature_agents,
  }));

  const totalInstalls = installations.reduce((n, r) => n + r.observed_installations, 0);
  const knownAtFirst = installations.reduce((n, r) => n + r.known_at_first_observation, 0);
  const knownEver = installations.reduce((n, r) => n + r.known_ever, 0);

  return {
    view: 'cohort',
    from: f.from,
    to: f.to,
    include_internal: f.includeInternal,
    installations: sourceFilter(installations),
    agents,
    human_buyers: {
      new_owners: humanBuyers.new_owners,
      buyers_with_first_funded_task: humanBuyers.funded,
      repeat_funded_buyers: humanBuyers.repeat_funded,
    },
    coverage: {
      observed_installations: totalInstalls,
      known_at_first_observation: knownAtFirst,
      known_ever: knownEver,
      // Original measure and later-known measure, side by side — the original
      // is never silently revised.
      coverage_at_first_pct: pct(knownAtFirst, totalInstalls),
      coverage_ever_pct: pct(knownEver, totalInstalls),
    },
  };
}

export interface ActivityRow {
  perspective: 'worker' | 'buyer';
  source: string;
  claims: number;
  deliveries: number;
  acceptances: number;
  funded_tasks: number;
  settled_payouts: number;
  settled_worker_usdc_atomic: string;
  settled_worker_usdc: string;
}

export interface ActivityReport {
  view: 'activity';
  from: string;
  to: string;
  include_internal: boolean;
  rows: ActivityRow[];
}

/**
 * Events that OCCURRED in the period, grouped by the acting side's acquisition
 * source (worker events by the claimer's source, funding by the buyer's).
 * Deliberately a different denominator from the cohort view.
 */
export async function activityReport(db: DBAdapter, f: ReportFilters): Promise<ActivityReport> {
  const workerInternal = internalFilter(f, 't.claimed_by_agent_id');
  const workerSource = `COALESCE((SELECT aa.source FROM agent_acquisition aa WHERE aa.agent_id = t.claimed_by_agent_id), 'unknown')`;
  const worker = await db.all<{
    source: string; claims: number; deliveries: number; acceptances: number;
    settled_payouts: number; paid_atomic: number;
  }>(
    `SELECT ${workerSource} AS source,
       SUM(CASE WHEN t.claimed_at >= ? AND t.claimed_at < ? THEN 1 ELSE 0 END) AS claims,
       SUM(CASE WHEN t.submitted_at >= ? AND t.submitted_at < ? THEN 1 ELSE 0 END) AS deliveries,
       SUM(CASE WHEN t.verified_at >= ? AND t.verified_at < ? THEN 1 ELSE 0 END) AS acceptances,
       SUM(CASE WHEN t.settled_at >= ? AND t.settled_at < ? AND ${PAID_WHERE} THEN 1 ELSE 0 END) AS settled_payouts,
       COALESCE(SUM(CASE WHEN t.settled_at >= ? AND t.settled_at < ? AND ${PAID_WHERE} THEN CAST(t.bounty_amount AS INTEGER) ELSE 0 END), 0) AS paid_atomic
     FROM tasks t
     WHERE t.claimed_by_agent_id IS NOT NULL${workerInternal.sql}
     GROUP BY 1 HAVING claims + deliveries + acceptances + settled_payouts > 0
     ORDER BY source`,
    f.from, f.to, f.from, f.to, f.from, f.to, f.from, f.to, f.from, f.to, ...workerInternal.params,
  );

  const buyerInternal = internalFilter(f, `COALESCE(t.creator_agent_id, t.creator_owner_id)`);
  const buyerSource = `CASE WHEN t.creator_owner_id IS NOT NULL THEN 'human_buyer'
    ELSE COALESCE((SELECT aa.source FROM agent_acquisition aa WHERE aa.agent_id = t.creator_agent_id), 'unknown') END`;
  const buyer = await db.all<{ source: string; funded_tasks: number }>(
    `SELECT ${buyerSource} AS source,
       COUNT(*) AS funded_tasks
     FROM tasks t
     WHERE t.escrow_funded_at >= ? AND t.escrow_funded_at < ?${buyerInternal.sql}
     GROUP BY 1 ORDER BY source`,
    f.from, f.to, ...buyerInternal.params,
  );

  const rows: ActivityRow[] = [
    ...worker.map((w) => ({
      perspective: 'worker' as const,
      source: w.source,
      claims: w.claims,
      deliveries: w.deliveries,
      acceptances: w.acceptances,
      funded_tasks: 0,
      settled_payouts: w.settled_payouts,
      settled_worker_usdc_atomic: String(w.paid_atomic),
      settled_worker_usdc: atomicToDisplay(String(w.paid_atomic)),
    })),
    ...buyer.map((b) => ({
      perspective: 'buyer' as const,
      source: b.source,
      claims: 0,
      deliveries: 0,
      acceptances: 0,
      funded_tasks: b.funded_tasks,
      settled_payouts: 0,
      settled_worker_usdc_atomic: '0',
      settled_worker_usdc: '0.00',
    })),
  ];
  const filtered = f.source ? rows.filter((r) => r.source === f.source) : rows;
  return { view: 'activity', from: f.from, to: f.to, include_internal: f.includeInternal, rows: filtered };
}

// ─── Shared query runner for the two admin surfaces ──────────────────────────

const DEFAULT_WINDOW_DAYS = 30;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ReportResult =
  | { kind: 'json'; body: CohortReport | ActivityReport }
  | { kind: 'csv'; body: string; filename: string }
  | { kind: 'error'; status: 400; message: string };

/**
 * Parse the shared query-string contract and run the report. Used by both
 * GET /v1/admin/acquisition (bearer) and GET /v1/owner/admin/acquisition
 * (console session) so the two surfaces can never disagree.
 *
 * Params: from/to (ISO; defaults to the last 30 days), view=cohort|activity,
 * source, campaign, interface, include_internal=1, format=json|csv
 * (+ table=installations|agents|activity for CSV).
 */
export async function runAcquisitionReport(
  db: DBAdapter,
  env: { HOUSE_ACCOUNT_IDS?: string; INTERNAL_AGENT_IDS?: string } | undefined,
  q: (name: string) => string | undefined,
  now: Date = new Date(),
): Promise<ReportResult> {
  const parseDate = (v: string | undefined, fallback: string): string | null => {
    if (!v) return fallback;
    if (Number.isNaN(Date.parse(v))) return null;
    // A bare date means the whole day (to-exclusive semantics stay intact).
    return DATE_ONLY_RE.test(v) ? `${v}T00:00:00.000Z` : new Date(v).toISOString();
  };
  const from = parseDate(q('from'), new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString());
  const to = parseDate(q('to'), now.toISOString());
  if (!from || !to) return { kind: 'error', status: 400, message: 'from/to must be ISO dates' };
  const view = q('view') ?? 'cohort';
  if (view !== 'cohort' && view !== 'activity') {
    return { kind: 'error', status: 400, message: 'view must be cohort or activity' };
  }
  const filters: ReportFilters = {
    from,
    to,
    source: q('source') || undefined,
    campaign: q('campaign') || undefined,
    iface: q('interface') || undefined,
    includeInternal: q('include_internal') === '1',
    internalIds: internalIdSet(env),
    now,
  };

  const report = view === 'cohort' ? await cohortReport(db, filters) : await activityReport(db, filters);

  if (q('format') === 'csv') {
    const table = q('table') ?? (view === 'cohort' ? 'agents' : 'activity');
    let rows: Array<Record<string, unknown>>;
    if (report.view === 'activity') {
      rows = report.rows as unknown as Array<Record<string, unknown>>;
    } else if (table === 'installations') {
      rows = report.installations as unknown as Array<Record<string, unknown>>;
    } else {
      rows = report.agents as unknown as Array<Record<string, unknown>>;
    }
    return { kind: 'csv', body: toCsv(rows), filename: `acquisition-${view}-${table}.csv` };
  }
  return { kind: 'json', body: report };
}

/** Flat rows → CSV with a stable header; values are quoted when needed. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n') + '\n';
}
