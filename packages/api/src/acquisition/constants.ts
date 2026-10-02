/**
 * Acquisition attribution: the shared vocabulary and validation bounds.
 *
 * Everything here is ANALYTICS vocabulary. These values are reported evidence,
 * not trusted identity: they never grant access and never affect payments,
 * permissions or reputation. Invalid values are silently discarded at capture
 * (analytics must never 4xx a business request) and discarded with a stderr
 * warning in the clients (analytics must never block MCP startup).
 */

/**
 * The normalized source registry. Extend DELIBERATELY: a new directory gets a
 * value only once the instructions it distributes actually carry that tag
 * (never tag a channel preemptively), and one-off promotions belong in the
 * bounded campaign field, not in new source categories. `unknown` is a real
 * row everywhere it is reported — it is never renamed organic/direct/registry.
 */
export const ACQUISITION_SOURCES = [
  'website',
  'github',
  'npm',
  'mcp_registry',
  'pulsemcp',
  'glama',
  'smithery',
  'hackernews',
  'partner',
  'unknown',
] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

/** The evidence behind a source value — a tag is only as strong as how it arrived. */
export const SOURCE_METHODS = ['config_tag', 'setup_token', 'referrer', 'self_reported', 'unknown'] as const;
export type SourceMethod = (typeof SOURCE_METHODS)[number];

/** Access mechanism — never conflated with the acquisition source. */
export const ATTRIBUTION_INTERFACES = ['mcp_stdio', 'mcp_http', 'cli', 'sdk', 'web'] as const;
export type AttributionInterface = (typeof ATTRIBUTION_INTERFACES)[number];

export const MCP_TOOL_OUTCOMES = ['ok', 'tool_error', 'api_error', 'auth_required', 'payment_required', 'network_error'] as const;
export type McpToolOutcome = (typeof MCP_TOOL_OUTCOMES)[number];

// ─── Validation bounds ───

/** Conservative label syntax shared by source and campaign values. */
export const LABEL_RE = /^[a-z0-9_-]{1,64}$/;
/** installation_id is a client-minted UUID — format is the only trust it gets. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Setup-flow ids from generatePublicId('acq'), bounded loosely for forward compat. */
export const ACQUISITION_ID_RE = /^acq_[A-Za-z0-9_-]{1,96}$/;
/** Bounded snake-case error categories (never raw error text). */
export const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Attribution request headers, following the X-BasedAgents-Cli-Version
 * convention. All optional, all unsigned, all analytics-only. They are NOT in
 * the browser CORS allowHeaders on purpose — no browser surface sends them.
 */
export const ATTRIBUTION_HEADERS = {
  interface: 'X-BasedAgents-Interface',
  installationId: 'X-BasedAgents-Installation-Id',
  source: 'X-BasedAgents-Acquisition-Source',
  campaign: 'X-BasedAgents-Acquisition-Campaign',
  acquisitionId: 'X-BasedAgents-Acquisition-Id',
  clientName: 'X-BasedAgents-Client-Name',
  clientVersion: 'X-BasedAgents-Client-Version',
  mcpVersion: 'X-BasedAgents-Mcp-Version',
  toolName: 'X-BasedAgents-Tool-Name',
  toolCallId: 'X-BasedAgents-Tool-Call-Id',
} as const;

/** A label (source/campaign), or null when absent/invalid. */
export function cleanLabel(v: string | undefined | null): string | null {
  const s = (v ?? '').trim();
  return LABEL_RE.test(s) ? s : null;
}

/** A source that is in the normalized registry (and not 'unknown'), or null. */
export function cleanSource(v: string | undefined | null): AcquisitionSource | null {
  const s = cleanLabel(v);
  return s && s !== 'unknown' && (ACQUISITION_SOURCES as readonly string[]).includes(s)
    ? (s as AcquisitionSource)
    : null;
}

/**
 * A client-reported free-string (client name/version, mcp version): trimmed,
 * control characters stripped, capped at 64 chars. Empty when absent.
 */
export function cleanClientString(v: string | undefined | null): string {
  return (v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}
