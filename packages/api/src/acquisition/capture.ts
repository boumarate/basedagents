/**
 * Acquisition attribution capture: turn optional, unsigned attribution headers
 * on normal API traffic into the private attribution records (migration 0049).
 *
 * Trust model (mirrors the version-header telemetry in index.ts):
 *   - Anonymous-OK: installation id, source/campaign/acquisition id, client
 *     metadata, interface. They only ever create/annotate analytics rows.
 *   - Signed-only: the installation⇄agent link is written ONLY when `agentId`
 *     was set by verified AgentSig auth — a forged header never links.
 *   - Never inferred: no source is ever reconstructed from IP, User-Agent,
 *     client name or package name. No header, absent or present, changes the
 *     response.
 *
 * Attribution rules enforced here:
 *   - INSERT OR IGNORE on the installation PK = the immutable first
 *     observation (unknown included).
 *   - first_known_* is set once, at its real observation time (WHERE ... IS
 *     NULL) — later evidence never backdates or rewrites the original.
 *   - An untagged request touches neither first_* nor latest_* — a known
 *     source persists across restarts.
 *   - A changed tag adds an acquisition touch and moves latest_* only.
 *
 * Write bounds (D1 write amplification): after the first request of a day the
 * steady-state cost is one rollup upsert; the installation INSERT, the touch
 * INSERT and the link INSERT are OR IGNORE no-ops, and the metadata refresh is
 * gated on last_seen_day changing.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types/index.js';
import type { DBAdapter } from '../db/adapter.js';
import { generatePublicId } from '../lib/ids.js';
import {
  ACQUISITION_ID_RE,
  ATTRIBUTION_HEADERS,
  ATTRIBUTION_INTERFACES,
  UUID_RE,
  cleanClientString,
  cleanLabel,
  cleanSource,
  type AttributionInterface,
  type SourceMethod,
} from './constants.js';

export interface AttributionContext {
  installationId: string | null;
  source: string | null;
  campaign: string | null;
  acquisitionId: string | null;
  iface: AttributionInterface | '';
  clientName: string;
  clientVersion: string;
  mcpVersion: string;
}

/**
 * Parse and bound the attribution headers of one request. Invalid values are
 * dropped silently — analytics never rejects a request.
 */
export function parseAttributionHeaders(header: (name: string) => string | undefined): AttributionContext {
  const rawInstall = (header(ATTRIBUTION_HEADERS.installationId) ?? '').trim();
  const rawAcq = (header(ATTRIBUTION_HEADERS.acquisitionId) ?? '').trim();
  const rawIface = (header(ATTRIBUTION_HEADERS.interface) ?? '').trim();
  return {
    installationId: UUID_RE.test(rawInstall) ? rawInstall.toLowerCase() : null,
    source: cleanSource(header(ATTRIBUTION_HEADERS.source)),
    campaign: cleanLabel(header(ATTRIBUTION_HEADERS.campaign)),
    acquisitionId: ACQUISITION_ID_RE.test(rawAcq) ? rawAcq : null,
    iface: (ATTRIBUTION_INTERFACES as readonly string[]).includes(rawIface)
      ? (rawIface as AttributionInterface)
      : '',
    clientName: cleanClientString(header(ATTRIBUTION_HEADERS.clientName)),
    clientVersion: cleanClientString(header(ATTRIBUTION_HEADERS.clientVersion)),
    mcpVersion: cleanClientString(header(ATTRIBUTION_HEADERS.mcpVersion)),
  };
}

/** Paths that are analytics plumbing, never "activity" of the caller. */
const ANALYTICS_PATHS = new Set(['/v1/telemetry/mcp', '/v1/acquisition', '/v1/acquisition/events']);

/**
 * Server-side activity classification for the daily rollup: reads and polling
 * (browse, status, tools/list-driven GETs) are 'discovery'; committed writes
 * (register, claim, deliver, accept, messages, board) are 'meaningful'. Never
 * classified from a client-supplied header.
 */
export function classifyActivity(method: string, path: string): 'discovery' | 'meaningful' {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'discovery';
  if (ANALYTICS_PATHS.has(path)) return 'discovery';
  return 'meaningful';
}

export interface AttributionRequestMeta {
  /** '' unless set by verified AgentSig auth. */
  agentId: string;
  method: string;
  path: string;
  now?: Date;
}

interface ResolvedTag {
  source: string | null;
  campaign: string;
  method: SourceMethod;
}

/**
 * Resolve the reported tag against a setup-flow acquisition id, when one rode
 * along. A valid, unexpired id overrides the self-reported labels with the
 * server-stored mapping (method 'setup_token'); an expired or unknown id
 * degrades gracefully to the explicit config tag, or to unknown.
 */
async function resolveTag(db: DBAdapter, ctx: AttributionContext, nowIso: string): Promise<ResolvedTag> {
  if (ctx.acquisitionId) {
    const row = await db.get<{ source: string; campaign: string; expires_at: string }>(
      'SELECT source, campaign, expires_at FROM acquisition_ids WHERE id = ?',
      ctx.acquisitionId,
    );
    if (row && row.expires_at > nowIso) {
      return { source: row.source, campaign: row.campaign || (ctx.campaign ?? ''), method: 'setup_token' };
    }
  }
  if (ctx.source) return { source: ctx.source, campaign: ctx.campaign ?? '', method: 'config_tag' };
  return { source: null, campaign: '', method: 'unknown' };
}

/**
 * Record one observed request. Best-effort by contract: callers run it inside
 * waitUntil with a catch-all, and a failure here never surfaces to the caller.
 */
export async function recordAttribution(
  db: DBAdapter,
  ctx: AttributionContext,
  meta: AttributionRequestMeta,
): Promise<void> {
  const now = meta.now ?? new Date();
  const nowIso = now.toISOString();
  const day = nowIso.slice(0, 10);
  const tag = await resolveTag(db, ctx, nowIso);

  if (ctx.installationId) {
    // The first observation, immutable from here on (source unknown included).
    await db.run(
      `INSERT OR IGNORE INTO mcp_installations (
         installation_id, first_observed_at,
         source_at_first_observation, campaign_at_first_observation, method_at_first_observation,
         first_known_source, first_known_campaign, first_known_source_at, first_known_method,
         latest_source, latest_campaign, latest_source_at,
         acquisition_id, interface, client_name, client_version, mcp_version, last_seen_day
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.installationId, nowIso,
      tag.source ?? 'unknown', tag.campaign, tag.method,
      tag.source, tag.source ? tag.campaign : null, tag.source ? nowIso : null, tag.source ? tag.method : null,
      tag.source ?? '', tag.source ? tag.campaign : '', tag.source ? nowIso : '',
      ctx.acquisitionId ?? '', ctx.iface, ctx.clientName, ctx.clientVersion, ctx.mcpVersion, day,
    );

    if (tag.source) {
      // Earliest known source: set once, at its actual observation time.
      await db.run(
        `UPDATE mcp_installations
         SET first_known_source = ?, first_known_campaign = ?, first_known_source_at = ?, first_known_method = ?
         WHERE installation_id = ? AND first_known_source IS NULL`,
        tag.source, tag.campaign, nowIso, tag.method, ctx.installationId,
      );
      // Latest touch: moves only when the tag actually changed.
      await db.run(
        `UPDATE mcp_installations SET latest_source = ?, latest_campaign = ?, latest_source_at = ?
         WHERE installation_id = ? AND (latest_source <> ? OR latest_campaign <> ?)`,
        tag.source, tag.campaign, nowIso, ctx.installationId, tag.source, tag.campaign,
      );
      // Touch history (unique-indexed: a stable config re-sending the same
      // tuple is a no-op).
      await db.run(
        `INSERT OR IGNORE INTO acquisition_touches (id, installation_id, source, campaign, acquisition_id, method, interface, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        generatePublicId('tch'), ctx.installationId, tag.source, tag.campaign, ctx.acquisitionId ?? '', tag.method, ctx.iface, nowIso,
      );
    }

    // Liveness + client metadata, refreshed at most once per day per install.
    await db.run(
      `UPDATE mcp_installations SET
         last_seen_day = ?,
         client_name = CASE WHEN ? <> '' THEN ? ELSE client_name END,
         client_version = CASE WHEN ? <> '' THEN ? ELSE client_version END,
         mcp_version = CASE WHEN ? <> '' THEN ? ELSE mcp_version END
       WHERE installation_id = ? AND last_seen_day <> ?`,
      day,
      ctx.clientName, ctx.clientName,
      ctx.clientVersion, ctx.clientVersion,
      ctx.mcpVersion, ctx.mcpVersion,
      ctx.installationId, day,
    );

    // Signed-only: agentId is '' unless AgentSig auth verified this request.
    if (meta.agentId) {
      await db.run(
        `INSERT OR IGNORE INTO installation_agent_links (installation_id, agent_id, first_linked_at) VALUES (?, ?, ?)`,
        ctx.installationId, meta.agentId, nowIso,
      );
    }
  }

  // Daily activity rollup (also for installation-less but interface-labeled
  // signed traffic, e.g. the CLI — that is what the 7-day-returning metric reads).
  await db.run(
    `INSERT INTO installation_usage_daily (day, installation_id, agent_id, interface, kind, count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(day, installation_id, agent_id, interface, kind) DO UPDATE SET count = count + 1`,
    day, ctx.installationId ?? '', meta.agentId, ctx.iface, classifyActivity(meta.method, meta.path),
  );
}

/**
 * The lenient registration-attribution payload: an optional top-level
 * `attribution` object on POST /v1/register/complete. Parsed field by field —
 * a malformed value is dropped, never a reason to fail a registration — and
 * deliberately OUTSIDE ProfileSchema, so it can never enter the profile hash,
 * the chain entry, or anything else that is signed or public.
 */
export function sanitizeRegistrationAttribution(raw: unknown): Partial<AttributionContext> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const out: Partial<AttributionContext> = {};
  const source = cleanSource(str(o.source));
  if (source) out.source = source;
  const campaign = cleanLabel(str(o.campaign));
  if (campaign) out.campaign = campaign;
  if (ACQUISITION_ID_RE.test(str(o.acquisition_id))) out.acquisitionId = str(o.acquisition_id);
  if (UUID_RE.test(str(o.installation_id))) out.installationId = str(o.installation_id).toLowerCase();
  const iface = str(o.interface);
  if ((ATTRIBUTION_INTERFACES as readonly string[]).includes(iface)) out.iface = iface as AttributionInterface;
  return out;
}

/**
 * Write the one immutable acquisition record of a NEW agent, at its actual
 * registration (routes/register.ts, after the agents INSERT committed).
 * Body attribution (SDK/CLI registrations) wins field-by-field over the
 * ambient request headers (MCP registrations). The installation link is safe
 * to write here without AgentSig: the registration challenge signature just
 * proved possession of this very key. Pre-existing agents never get a row —
 * they are existing users, not new acquisitions.
 */
export async function recordAgentAcquisition(
  db: DBAdapter,
  agentId: string,
  registeredAt: string,
  headerCtx: AttributionContext,
  bodyAttribution: unknown,
): Promise<void> {
  const body = sanitizeRegistrationAttribution(bodyAttribution);
  const merged: AttributionContext = {
    installationId: body.installationId ?? headerCtx.installationId,
    source: body.source ?? headerCtx.source,
    campaign: body.campaign ?? headerCtx.campaign,
    acquisitionId: body.acquisitionId ?? headerCtx.acquisitionId,
    iface: body.iface ?? headerCtx.iface,
    clientName: headerCtx.clientName,
    clientVersion: headerCtx.clientVersion,
    mcpVersion: headerCtx.mcpVersion,
  };
  const nowIso = new Date().toISOString();
  const tag = await resolveTag(db, merged, nowIso);
  await db.run(
    `INSERT OR IGNORE INTO agent_acquisition (agent_id, registered_at, source, campaign, acquisition_id, installation_id, interface, method)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    agentId, registeredAt,
    tag.source ?? 'unknown', tag.campaign, merged.acquisitionId ?? '', merged.installationId ?? '', merged.iface, tag.method,
  );
  if (merged.installationId) {
    await db.run(
      `INSERT OR IGNORE INTO installation_agent_links (installation_id, agent_id, first_linked_at) VALUES (?, ?, ?)`,
      merged.installationId, agentId, nowIso,
    );
  }
}

// ─── Retention ───────────────────────────────────────────────────────────────

/** Raw analytics retention (documented default). */
export const RAW_ANALYTICS_RETENTION_DAYS = 90;
/** Grace past an acquisition id's own expiry before its row is deleted. */
export const ACQUISITION_ID_GRACE_DAYS = 30;
/** Nonidentifying daily rollups are kept longer for year-over-year reads. */
export const USAGE_ROLLUP_RETENTION_DAYS = 400;

/**
 * Daily retention sweep (cron, claimed once per day via job_runs). Deletes
 * raw analytics past retention: client-reported tool outcomes, expired setup
 * ids, and old daily rollups. The attribution registry itself
 * (mcp_installations, acquisition_touches, agent_acquisition, links) is the
 * evidence the cohort reports stand on and is kept. Marketplace and payment
 * records are never touched here.
 */
export async function acquisitionRetentionSweep(
  db: DBAdapter,
  nowIso: string,
): Promise<{ outcomes: number; acquisitionIds: number; usageDays: number }> {
  const now = Date.parse(nowIso);
  const cutoff = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const outcomes = await db.run(
    'DELETE FROM mcp_tool_outcomes WHERE received_at < ?', cutoff(RAW_ANALYTICS_RETENTION_DAYS),
  );
  const acquisitionIds = await db.run(
    'DELETE FROM acquisition_ids WHERE expires_at < ?', cutoff(ACQUISITION_ID_GRACE_DAYS),
  );
  const usageDays = await db.run(
    'DELETE FROM installation_usage_daily WHERE day < ?', cutoff(USAGE_ROLLUP_RETENTION_DAYS).slice(0, 10),
  );
  return { outcomes: outcomes.changes, acquisitionIds: acquisitionIds.changes, usageDays: usageDays.changes };
}

/**
 * Cron entry: claim today once via job_runs (the daily-digest pattern), then
 * sweep. Analytics-only — a failure is logged and retried by a later tick.
 */
export async function runAcquisitionRetention(db: DBAdapter, now: Date): Promise<string> {
  const nowIso = now.toISOString();
  const day = nowIso.slice(0, 10);
  const claimed = await db.run(
    `INSERT OR IGNORE INTO job_runs (job, run_key, status, attempts, ran_at) VALUES ('acquisition_retention', ?, 'running', 1, ?)`,
    day, nowIso,
  );
  if (claimed.changes === 0) return 'already_ran';
  try {
    const swept = await acquisitionRetentionSweep(db, nowIso);
    await db.run(
      `UPDATE job_runs SET status = 'done', ran_at = ? WHERE job = 'acquisition_retention' AND run_key = ?`,
      nowIso, day,
    );
    return `swept outcomes=${swept.outcomes} acquisition_ids=${swept.acquisitionIds} usage_days=${swept.usageDays}`;
  } catch (err) {
    await db.run(
      `UPDATE job_runs SET status = 'failed', ran_at = ? WHERE job = 'acquisition_retention' AND run_key = ?`,
      nowIso, day,
    ).catch(() => undefined);
    throw err;
  }
}

/**
 * The capture middleware. Registered after the version-telemetry middleware
 * (same shape: read after `await next()`, write via waitUntil, swallow every
 * analytics error). Gated by ACQUISITION_ANALYTICS ('0' disables; default on).
 * Only successful responses are observed — an installation is counted only
 * after the backend observes real activity carrying its id.
 */
export const acquisitionCapture: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  try {
    if (c.env?.ACQUISITION_ANALYTICS === '0') return;
    if (c.res.status >= 400) return;
    const db = c.get('db');
    if (!db) return;
    const ctx = parseAttributionHeaders((n) => c.req.header(n));
    const agentId = (c.get as (k: string) => string | undefined)('agentId') ?? '';
    // Nothing attributable: no installation identity and no interface-labeled
    // signed traffic. (An unsigned interface header alone is anyone's to spoof
    // and would only mint garbage rollup rows.)
    if (!ctx.installationId && !(agentId && ctx.iface)) return;
    const work = recordAttribution(db, ctx, {
      agentId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    }).catch((err) => console.error('[acquisition] capture failed:', err));
    try { c.executionCtx.waitUntil(work); } catch { await work; }
  } catch (err) {
    console.error('[acquisition] capture failed:', err);
  }
};
