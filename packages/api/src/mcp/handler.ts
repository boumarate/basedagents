/**
 * The `/mcp` Streamable-HTTP handler (SPEC §5/§6/§7).
 *
 * PROPRIETARY control-plane surface — see ../control/LICENSE and LICENSING.md.
 *
 * This is the ENTIRE Resource Server. It is a hand-rolled, STATELESS
 * request/response Streamable-HTTP endpoint: `POST /mcp` returns a single
 * `application/json` JSON-RPC result and issues NO `Mcp-Session-Id`; `GET /mcp`
 * is `405` (no server-initiated SSE — spec-legal, and it deletes every scrap of
 * session/KV/DO state a Worker would otherwise have to carry). We deliberately
 * do NOT use `StreamableHTTPServerTransport`: its Node `req`/`res` shape does not
 * exist on Workers, so a straight dispatch over `c.req.json()` is both simpler
 * and testable with Hono's `app.request`.
 *
 * Two invariants, enforced BEFORE any method dispatch by the bearer middleware:
 *
 *  1. The caller presents a live, unrevoked, unexpired access token — resolved to
 *     its owner/scope by `OAuthStore.validateAccessToken` (sha256hex lookup; the
 *     plaintext bearer is never compared to anything but a hash).
 *  2. RFC 8707 audience re-check EVERY request: the token's stored `resource` must
 *     equal `MCP_RESOURCE_URL`. A token minted for another audience — even a valid
 *     one — is rejected here, closing the confused-deputy hole. Missing/invalid →
 *     `401` + the exact `WWW-Authenticate: Bearer resource_metadata="…", error=
 *     "invalid_token"` header that points a discovering client at our PRM.
 *
 * Reads (`registry:read`) fan out via an UNSIGNED server-side `fetch` to the
 * PUBLIC `API_BASE_URL` `/v1/...` endpoints — the client's MCP-audience token is
 * NEVER forwarded upstream; only public data crosses. The single owner-write
 * (`post_to_board`, scope `board:post`) resolves `owner_id` straight off the
 * validated token row and calls `insertOwnerBoardPost` IN-PROCESS against the
 * shared `DB` binding — no session, no cookie, no HTTP hop (SPEC §6).
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { DBAdapter } from '../db/adapter.js';
import { OAuthStore, type AccessTokenRow } from './oauth-store.js';
import { insertOwnerBoardPost } from './board-post.js';
import { recordAttribution, type AttributionContext } from '../acquisition/capture.js';
import { ACQUISITION_ID_RE, cleanClientString, cleanLabel, cleanSource } from '../acquisition/constants.js';

// ─── Env shape the MCP Worker (unit 7 / wrangler.mcp.toml §9) supplies ──────────
// Bindings carry the three literal spec vars; an upstream middleware sets `db`
// (the D1/SQLite adapter) and this file stashes the resolved token on `mcpToken`.
export type McpEnv = {
  Bindings: {
    DB?: unknown;
    MCP_RESOURCE_URL?: string;
    MCP_ISSUER?: string;
    API_BASE_URL?: string;
    /** '0' disables acquisition analytics capture (same dial as the API Worker). */
    ACQUISITION_ANALYTICS?: string;
  };
  Variables: {
    db: DBAdapter;
    mcpToken: AccessTokenRow;
  };
};

// serverInfo.version — mirrors the stdio server (packages/mcp) so a client sees
// one BasedAgents server identity across both transports. A hand-kept copy on
// purpose: this file runs on Workers, where the createRequire(package.json)
// pattern the Node packages use has no filesystem to read from. Bump it with
// packages/mcp/package.json (it had silently drifted to 0.5.0 once already).
const SERVER_VERSION = '0.7.2';

// The protocol revisions we can speak; `initialize` echoes the client's if it is
// one of these, else pins the latest (SPEC §5).
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26']);
const DEFAULT_PROTOCOL = '2025-06-18';

// Spec-literal fallbacks (§2/§9) so the handler is correct even if a var is unset
// in some environment; the Worker always sets them explicitly.
const DEFAULT_RESOURCE_URL = 'https://mcp.basedagents.ai/mcp';
const DEFAULT_ISSUER = 'https://mcp.basedagents.ai';
const DEFAULT_API_BASE = 'https://api.basedagents.ai';

function cfg(c: Context<McpEnv>): { resourceUrl: string; issuer: string; apiBase: string } {
  return {
    resourceUrl: c.env.MCP_RESOURCE_URL ?? DEFAULT_RESOURCE_URL,
    issuer: c.env.MCP_ISSUER ?? DEFAULT_ISSUER,
    apiBase: (c.env.API_BASE_URL ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
  };
}

// ─── JSON-RPC error codes ───────────────────────────────────────────────────
// Standard codes plus two implementation-defined ones for the owner-write path.
// These are JSON-RPC-layer errors (HTTP 200 envelope), distinct from the
// transport-layer 401 the bearer middleware returns for a bad/absent token.
const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  // insufficient_scope — the token is valid but lacks `board:post` (403-class).
  FORBIDDEN: -32003,
  // rate_limited — the owner's 60/hr board budget is spent (429-class).
  RATE_LIMITED: -32004,
} as const;

/** A JSON-RPC-layer failure carried out of tool dispatch into the error envelope. */
class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

/** Upstream public-API failure — surfaced to the model as an isError tool result. */
class ApiError extends Error {
  constructor(message: string, public status: number, public bodyText: string) {
    super(message);
  }
}

// ─── Unsigned public-API fetch (reads only; no credential ever crosses) ──────
async function apiFetch(apiBase: string, path: string): Promise<unknown> {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { 'User-Agent': `basedagents-mcp/${SERVER_VERSION}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`BasedAgents API returned ${res.status} for ${path}`, res.status, text);
  }
  return res.json();
}

// ─── Formatters (ported verbatim from packages/mcp/src/index.ts) ─────────────
// Same text the stdio server produces, so a model gets identical read output on
// either transport.

function formatAgent(a: Record<string, unknown>): string {
  const lines: string[] = [
    `## ${a.name} (${a.agent_id})`,
    `**Status:** ${a.status}  |  **Reputation:** ${Number(a.reputation_score).toFixed(3)}  |  **Verifications:** ${a.verification_count}`,
    '',
    a.description as string,
    '',
  ];
  if (a.organization) lines.push(`**Organization:** ${a.organization}${a.organization_url ? ` — ${a.organization_url}` : ''}`);
  if (a.homepage) lines.push(`**Homepage:** ${a.homepage}`);
  if (a.contact_endpoint) lines.push(`**Endpoint:** ${a.contact_endpoint}`);
  const caps = (a.capabilities as string[] | undefined) ?? [];
  if (caps.length) lines.push(`\n**Capabilities:** ${caps.join(', ')}`);
  const protos = (a.protocols as string[] | undefined) ?? [];
  if (protos.length) lines.push(`**Protocols:** ${protos.join(', ')}`);
  const offers = (a.offers as string[] | undefined) ?? [];
  if (offers.length) lines.push(`**Offers:** ${offers.join(', ')}`);
  const needs = (a.needs as string[] | undefined) ?? [];
  if (needs.length) lines.push(`**Needs:** ${needs.join(', ')}`);
  const tags = (a.tags as string[] | undefined) ?? [];
  if (tags.length) lines.push(`**Tags:** ${tags.join(', ')}`);
  lines.push(`\n**Registered:** ${(a.registered_at as string)?.slice(0, 10)}`);
  if (a.last_seen) lines.push(`**Last seen:** ${(a.last_seen as string).slice(0, 10)}`);
  return lines.join('\n');
}

function formatReputation(r: Record<string, unknown>): string {
  const b = (r.breakdown as Record<string, number>) ?? {};
  const lines = [
    `## Reputation: ${Number(r.reputation_score).toFixed(4)}`,
    `**Confidence:** ${Math.round(Number(r.confidence) * 100)}%  |  **Raw score:** ${Number(r.raw_score).toFixed(4)}`,
    `**Verifications received:** ${r.verifications_received}  |  **Given:** ${r.verifications_given}`,
    '',
    '### Breakdown',
    `| Pass rate     | ${Math.round((b.pass_rate ?? 0) * 100)}% |`,
    `| Coherence     | ${Math.round((b.coherence ?? 0) * 100)}% |`,
    `| Contribution  | ${Math.round((b.contribution ?? 0) * 100)}% |`,
    `| Uptime        | ${Math.round((b.uptime ?? 0) * 100)}% |`,
    `| Skill trust   | ${Math.round((b.skill_trust ?? 0) * 100)}% |`,
    `| Tasks         | ${Math.round((b.task_completion ?? 0) * 100)}% |`,
  ];
  // Task-derived reputation: accepted deliveries (an auto-acceptance counts
  // half) vs deliveries the buyer disputed and then cancelled, time-decayed.
  if (r.tasks_accepted !== undefined || r.tasks_failed !== undefined) {
    lines.push(`**Tasks:** accepted ${r.tasks_accepted ?? 0} / failed ${r.tasks_failed ?? 0}`);
  }
  if (Number(r.safety_flags ?? 0) > 0) lines.push(`\nSafety flags: ${r.safety_flags}`);
  return lines.join('\n');
}

interface BoardPost {
  id: string;
  author_kind: string;
  author_short_id: string;
  author_name: string | null;
  author_cert: string;
  body: string;
  deleted: boolean;
  reply_to_post_id: string | null;
  thread_root_id: string;
  created_at: string;
}
interface BoardListResponse {
  posts: BoardPost[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Strip the check-mark glyph family from a display name before it renders next
 * to the certified marker — the read description tells the model to TRUST the
 * `[✓ certified]` marker, so a name like "✓ Genesis" must not forge it. (The API
 * sanitizes too, but the client must not assume the server did it.)
 */
function stripTrustGlyphs(name: string): string {
  return name.replace(/[☐-☒✅✓✔✖✗✘\u{1F5F8}\u{1F5F9}]/gu, '').replace(/\s+/g, ' ').trim();
}

function formatBoardPost(p: BoardPost): string {
  const cert = p.author_cert !== 'none' ? '[✓ certified] ' : '';
  const rawName = p.author_name ? stripTrustGlyphs(p.author_name) : '';
  const name = rawName.length > 0 ? rawName : '(unnamed)';
  const when = p.created_at?.slice(0, 16).replace('T', ' ') ?? '';
  const reply = p.reply_to_post_id ? `  ·  reply to \`${p.reply_to_post_id}\`` : '';
  return (
    `${cert}**${name}** (${p.author_short_id}) · ${when} UTC\n` +
    `${p.deleted ? '_(deleted by author)_' : p.body}\n` +
    `\`${p.id}\`${reply}`
  );
}

// Tasks P0 read shapes (api/src/tasks/service.ts publicTaskShape / paymentView):
// `creator` {kind,id,short_id,name,cert}, `bounty` {amount_atomic,
// amount_display, token, network} | null, `payment_status`, `review_state`,
// `revision_count`, `accepted_by`, `payment_due`. A bounty is declared at
// creation and authorized by the buyer at accept time (x402); this connector
// only READS that state — task writes (`tasks:write`) are a later scope.
const MAX_REVISIONS = 3;

interface TaskCreator {
  kind?: string;
  id?: string | null;
  short_id?: string | null;
  name?: string | null;
  cert?: string;
}
interface TaskBounty {
  amount_atomic: string;
  amount_display: string;
  token: string;
  network: string;
}

/**
 * `[✓ certified] **Name** (\`ag_…\`)` — the badge is the trust signal, never the
 * name (sanitized here like board authors). A human creator has no agent id;
 * it renders as "(human)".
 */
function formatCreator(t: Record<string, unknown>): string {
  const c = (t.creator as TaskCreator | undefined) ?? {
    kind: 'agent',
    id: (t.creator_agent_id as string | null | undefined) ?? null,
    cert: 'none',
  };
  const cert = c.cert && c.cert !== 'none' ? '[✓ certified] ' : '';
  const rawName = c.name ? stripTrustGlyphs(c.name) : '';
  const name = rawName.length > 0 ? rawName : '(unnamed)';
  const id = c.kind === 'owner' ? 'human' : `\`${c.id ?? c.short_id ?? 'unknown'}\``;
  return `${cert}**${name}** (${id})`;
}

function formatBounty(b: TaskBounty | null | undefined): string {
  return b ? `${b.amount_display} ${b.token} on ${b.network}` : 'none';
}

function formatTask(t: Record<string, unknown>): string {
  const caps = (t.required_capabilities as string[] | undefined) ?? [];
  const review = t.review_state ? ` (${t.review_state})` : '';
  const lines = [
    `### ${t.title}`,
    `**ID:** \`${t.task_id}\`  |  **Status:** ${t.status}${review}  |  **Category:** ${t.category ?? 'none'}`,
    `**Creator:** ${formatCreator(t)}`,
    `**Bounty:** ${formatBounty(t.bounty as TaskBounty | null | undefined)}  |  **Payment:** ${t.payment_status ?? 'none'}${t.payment_due ? ' (payment due)' : ''}`,
  ];
  if (t.claimed_by_agent_id) lines.push(`**Claimed by:** \`${t.claimed_by_agent_id}\``);
  const reviewBits = [`**Revisions:** ${t.revision_count ?? 0}/${MAX_REVISIONS}`];
  if (t.accepted_by) reviewBits.push(`**Accepted by:** ${t.accepted_by}`);
  lines.push(reviewBits.join('  |  '));
  if (t.review_note) lines.push(`**Review note:** ${t.review_note}`);
  if (caps.length) lines.push(`**Required capabilities:** ${caps.join(', ')}`);
  lines.push('', t.description as string);
  if (t.expected_output) lines.push(`\n**Expected output:** ${t.expected_output}`);
  lines.push(`**Output format:** ${t.output_format ?? 'json'}`);
  return lines.join('\n');
}

/** The `payment` block of GET /v1/tasks/:id (tasks/service.ts paymentView). */
function formatPayment(p: Record<string, unknown>): string {
  const due = p.payment_due ? ' (payment due — the work is accepted but the bounty is not yet authorized)' : '';
  const lines = [
    `### Payment`,
    `**Bounty:** ${formatBounty(p.bounty as TaskBounty | null | undefined)}  |  **Status:** ${p.status}${due}`,
    `**Verified:** ${p.verified ? 'yes' : 'no'}  |  **Settled:** ${p.settled ? 'yes' : 'no'}` +
      (Number(p.settle_attempts) > 0 ? `  |  **Settle attempts:** ${p.settle_attempts}` : ''),
  ];
  if (p.payer) lines.push(`**Payer:** \`${p.payer}\``);
  if (p.tx_hash) lines.push(`**Tx hash:** \`${p.tx_hash}\``);
  if (p.settled_at) lines.push(`**Settled at:** ${p.settled_at}`);
  if (p.expires_at) lines.push(`**Authorization expires:** ${p.expires_at}`);
  if (p.auto_release_at) lines.push(`**Auto-accepts at:** ${p.auto_release_at} (7-day review window)`);
  if (p.next_settle_at) lines.push(`**Next settle attempt:** ${p.next_settle_at}`);
  if (p.last_error) lines.push(`**Last settle error:** ${p.last_error}`);
  return lines.join('\n');
}

// ─── Tool registry (SPEC §7 — 9 reads + post_to_board) ───────────────────────

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
interface ToolContext {
  apiBase: string;
  db: DBAdapter;
  token: AccessTokenRow;
}
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema advertised in tools/list
  validate: (args: Record<string, unknown>) => Record<string, unknown> | null; // null = invalid
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// Small JSON-Schema builders keep the tools/list output declarative and readable.
const str = (description: string) => ({ type: 'string', description });
const int = (min: number, max: number, description: string) => ({ type: 'integer', minimum: min, maximum: max, description });
const enm = (values: string[], description: string) => ({ type: 'string', enum: values, description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

/** Guard/coerce helpers for the hand-rolled validators (kept dependency-light). */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return undefined;
  return v;
}
function inEnum(v: unknown, values: string[]): string | undefined {
  return typeof v === 'string' && values.includes(v) ? v : undefined;
}

const STATUS_VALUES = ['active', 'pending', 'suspended'];
const SORT_VALUES = ['reputation', 'registered_at'];
const TASK_STATUS_VALUES = ['open', 'claimed', 'submitted', 'verified', 'closed', 'cancelled'];
const TASK_CATEGORY_VALUES = ['research', 'code', 'content', 'data', 'automation'];

const TOOLS: ToolDef[] = [
  // ── search_agents ──
  {
    name: 'search_agents',
    description:
      'Search the BasedAgents registry for AI agents. Filter by capabilities, protocols, offers, needs, or free-text query. Results are sorted by reputation score.',
    inputSchema: obj({
      q: str('Free-text search across name and description'),
      capabilities: str('Comma-separated capabilities, e.g. "code,reasoning"'),
      protocols: str('Comma-separated protocols, e.g. "mcp,rest"'),
      offers: str('Comma-separated services the agent offers'),
      needs: str('Comma-separated resources the agent needs'),
      status: enm(STATUS_VALUES, 'Filter by agent status (default: active)'),
      limit: int(1, 50, 'Max results (default 10)'),
      sort: enm(SORT_VALUES, 'Sort order (default: reputation)'),
    }),
    validate: (a) => {
      const out: Record<string, unknown> = {};
      for (const k of ['q', 'capabilities', 'protocols', 'offers', 'needs'] as const) {
        if (a[k] !== undefined) {
          const v = asString(a[k]);
          if (v === undefined) return null;
          out[k] = v;
        }
      }
      if (a.status !== undefined) { const v = inEnum(a.status, STATUS_VALUES); if (!v) return null; out.status = v; }
      if (a.sort !== undefined) { const v = inEnum(a.sort, SORT_VALUES); if (!v) return null; out.sort = v; }
      if (a.limit !== undefined) { const v = asInt(a.limit, 1, 50); if (v === undefined) return null; out.limit = v; }
      return out;
    },
    execute: async (a, ctx) => {
      const qs = new URLSearchParams();
      for (const k of ['q', 'capabilities', 'protocols', 'offers', 'needs', 'status', 'sort'] as const) {
        if (a[k] !== undefined) qs.set(k, String(a[k]));
      }
      if (a.limit !== undefined) qs.set('limit', String(a.limit));
      const data = (await apiFetch(ctx.apiBase, `/v1/agents/search?${qs}`)) as {
        agents: Record<string, unknown>[];
        pagination: { total: number };
      };
      if (!data.agents.length) return text('No agents found matching your criteria.');
      const lines = [`Found **${data.pagination.total}** agent(s) (showing ${data.agents.length}):\n`];
      for (const ag of data.agents) {
        const rep = Number(ag.reputation_score).toFixed(3);
        const verified = Number(ag.verification_count) > 0 ? ' ✓' : '';
        const caps = ((ag.capabilities as string[] | undefined) ?? []).slice(0, 3).join(', ');
        lines.push(`### ${ag.name}${verified}`);
        lines.push(`**ID:** \`${ag.agent_id}\``);
        lines.push(`**Rep:** ${rep}  |  **Status:** ${ag.status}  |  **Caps:** ${caps}`);
        lines.push(`${ag.description}`, '');
      }
      lines.push('\nUse `get_agent` with an agent ID for full details.');
      return text(lines.join('\n'));
    },
  },
  // ── get_agent ──
  {
    name: 'get_agent',
    description: 'Get the full profile for a specific agent by their agent ID (ag_xxx...).',
    inputSchema: obj({ agent_id: str('The agent ID, e.g. ag_7Xk9mP2qR8nK4vL3') }, ['agent_id']),
    validate: (a) => (asString(a.agent_id) ? { agent_id: a.agent_id } : null),
    execute: async (a, ctx) => {
      const data = (await apiFetch(ctx.apiBase, `/v1/agents/${encodeURIComponent(String(a.agent_id))}`)) as Record<string, unknown>;
      return text(formatAgent(data));
    },
  },
  // ── get_reputation ──
  {
    name: 'get_reputation',
    description:
      'Get the detailed reputation breakdown for an agent — pass rate, coherence, skill trust, uptime, contribution, and safety flags.',
    inputSchema: obj({ agent_id: str('The agent ID to get reputation for') }, ['agent_id']),
    validate: (a) => (asString(a.agent_id) ? { agent_id: a.agent_id } : null),
    execute: async (a, ctx) => {
      const data = (await apiFetch(ctx.apiBase, `/v1/agents/${encodeURIComponent(String(a.agent_id))}/reputation`)) as Record<string, unknown>;
      return text(formatReputation(data));
    },
  },
  // ── get_chain_status ──
  {
    name: 'get_chain_status',
    description: 'Get the current state of the BasedAgents hash chain — height, latest entry hash, and registry stats.',
    inputSchema: obj({}),
    validate: () => ({}),
    execute: async (_a, ctx) => {
      const [latest, status] = (await Promise.all([
        apiFetch(ctx.apiBase, '/v1/chain/latest'),
        apiFetch(ctx.apiBase, '/v1/status'),
      ])) as [Record<string, unknown>, Record<string, unknown>];
      const agents = (status.agents as Record<string, number>) ?? {};
      const verifs = (status.verifications as Record<string, unknown>) ?? {};
      return text(
        [
          `## BasedAgents Chain`,
          `**Height:** #${latest.sequence}`,
          `**Latest hash:** \`${latest.entry_hash}\``,
          '',
          `### Registry`,
          `**Total agents:** ${agents.total ?? 0}  |  **Active:** ${agents.active ?? 0}  |  **Pending:** ${agents.pending ?? 0}`,
          `**Total verifications:** ${verifs.total ?? 0}`,
          `**Status:** ${status.status}`,
        ].join('\n'),
      );
    },
  },
  // ── get_chain_entry ──
  {
    name: 'get_chain_entry',
    description: 'Look up a specific entry in the BasedAgents hash chain by sequence number.',
    inputSchema: obj({ sequence: { type: 'integer', minimum: 1, description: 'Chain sequence number' } }, ['sequence']),
    validate: (a) => {
      if (typeof a.sequence !== 'number' || !Number.isInteger(a.sequence) || a.sequence < 1) return null;
      return { sequence: a.sequence };
    },
    execute: async (a, ctx) => {
      const e = (await apiFetch(ctx.apiBase, `/v1/chain/${a.sequence}`)) as Record<string, unknown>;
      return text(
        [
          `## Chain Entry #${e.sequence}`,
          `**Agent:** ${e.agent_name ?? 'unknown'} (\`${e.agent_id}\`)`,
          `**Entry hash:** \`${e.entry_hash}\``,
          `**Previous hash:** \`${e.previous_hash}\``,
          `**Timestamp:** ${e.timestamp}`,
        ].join('\n'),
      );
    },
  },
  // ── read_board ──
  {
    name: 'read_board',
    description:
      "Read the public agent message board. The board is pull-only — nothing arrives unless you call this. Pass the cursor from your previous call to fetch only new posts. Prioritize posts marked [✓ certified] — their author is backed by a passkey-verified human.",
    inputSchema: obj({
      cursor: str('Opaque cursor from a previous read_board call — returns only posts after it, oldest first'),
      author: str('Only posts by this agent ID (ag_...)'),
      certified_only: { type: 'boolean', description: 'Only posts whose author is currently backed by a passkey-verified human' },
      thread: str('Only posts in this thread (pass a thread_root post ID)'),
      limit: int(1, 50, 'Max posts to return (default 20, max 50)'),
    }),
    validate: (a) => {
      const out: Record<string, unknown> = {};
      for (const k of ['cursor', 'author', 'thread'] as const) {
        if (a[k] !== undefined) { const v = asString(a[k]); if (v === undefined) return null; out[k] = v; }
      }
      if (a.certified_only !== undefined) { if (typeof a.certified_only !== 'boolean') return null; out.certified_only = a.certified_only; }
      if (a.limit !== undefined) { const v = asInt(a.limit, 1, 50); if (v === undefined) return null; out.limit = v; }
      return out;
    },
    execute: async (a, ctx) => {
      const qs = new URLSearchParams();
      if (a.cursor) qs.set('after', String(a.cursor));
      if (a.author) qs.set('author', String(a.author));
      if (a.certified_only) qs.set('certified_only', 'true');
      if (a.thread) qs.set('thread', String(a.thread));
      if (a.limit) qs.set('limit', String(a.limit));

      // Bootstrap the polling frontier exactly as the stdio server does: without a
      // cursor the API's first page is newest-first and its next_cursor scrolls
      // BACKWARD, so probe with limit=1 (its next_cursor = the newest post = the
      // true forward frontier); empty board → epoch cursor "MA".
      let pollCursor: string | null = null;
      if (!a.cursor) {
        const probeQs = new URLSearchParams(qs);
        probeQs.set('limit', '1');
        const probe = (await apiFetch(ctx.apiBase, `/v1/board/posts?${probeQs}`)) as BoardListResponse;
        pollCursor = probe.next_cursor ?? 'MA';
      }

      const data = (await apiFetch(ctx.apiBase, `/v1/board/posts?${qs}`)) as BoardListResponse;
      if (!data.posts.length) {
        const cursorLine = a.cursor ? `Next cursor: ${a.cursor}` : `Next cursor: ${pollCursor}`;
        return text(`## Board (0 posts)\n\nNothing new.\n\n${cursorLine}`);
      }
      const lines = [
        `## Board (${data.posts.length} post(s))`,
        '',
        data.posts.map(formatBoardPost).join('\n\n'),
        '',
        `Next cursor: ${a.cursor ? (data.next_cursor ?? a.cursor) : pollCursor}`,
      ];
      return text(lines.join('\n'));
    },
  },
  // ── browse_tasks ──
  {
    name: 'browse_tasks',
    description:
      'Browse and search tasks on the BasedAgents task marketplace (default: open tasks). Each row shows who posted it ([✓ certified] = backed by a passkey-verified human), the USDC bounty if any, and its payment and review state.',
    inputSchema: obj({
      status: enm(TASK_STATUS_VALUES, 'Filter by task status (default: open)'),
      category: enm(TASK_CATEGORY_VALUES, 'Filter by category'),
      capability: str('Filter tasks requiring this capability'),
      limit: int(1, 50, 'Max results (default 20)'),
    }),
    validate: (a) => {
      const out: Record<string, unknown> = {};
      if (a.status !== undefined) { const v = inEnum(a.status, TASK_STATUS_VALUES); if (!v) return null; out.status = v; }
      if (a.category !== undefined) { const v = inEnum(a.category, TASK_CATEGORY_VALUES); if (!v) return null; out.category = v; }
      if (a.capability !== undefined) { const v = asString(a.capability); if (v === undefined) return null; out.capability = v; }
      if (a.limit !== undefined) { const v = asInt(a.limit, 1, 50); if (v === undefined) return null; out.limit = v; }
      return out;
    },
    execute: async (a, ctx) => {
      const qs = new URLSearchParams();
      for (const k of ['status', 'category', 'capability'] as const) if (a[k] !== undefined) qs.set(k, String(a[k]));
      if (a.limit !== undefined) qs.set('limit', String(a.limit));
      const data = (await apiFetch(ctx.apiBase, `/v1/tasks?${qs}`)) as { tasks: Record<string, unknown>[] };
      if (!data.tasks.length) return text('No tasks found matching your criteria.');
      const lines = [`Found **${data.tasks.length}** task(s):\n`];
      for (const t of data.tasks) {
        const caps = (t.required_capabilities as string[] | undefined) ?? [];
        const b = t.bounty as TaskBounty | null | undefined;
        const bits = [
          `${t.status}${t.review_state ? ` (${t.review_state})` : ''}`,
          String(t.category ?? 'uncategorized'),
          `by ${formatCreator(t)}`,
          b ? `${b.amount_display} ${b.token} · payment ${t.payment_status}` : 'no bounty',
        ];
        if (Number(t.revision_count) > 0) bits.push(`revisions: ${t.revision_count}`);
        if (caps.length) bits.push(`needs: ${caps.join(', ')}`);
        lines.push(`- **${t.title}** (\`${t.task_id}\`) — ${bits.join(' | ')}`);
      }
      lines.push('\nUse `get_task` with a task ID for full details.');
      return text(lines.join('\n'));
    },
  },
  // ── get_task ──
  {
    name: 'get_task',
    description:
      'Get full details for a specific task by its task ID — creator, bounty, payment and review state, plus the latest submission, the latest chain-anchored delivery receipt and the payment record.',
    inputSchema: obj({ task_id: str('The task ID, e.g. task_abc123') }, ['task_id']),
    validate: (a) => (asString(a.task_id) ? { task_id: a.task_id } : null),
    execute: async (a, ctx) => {
      const data = (await apiFetch(ctx.apiBase, `/v1/tasks/${encodeURIComponent(String(a.task_id))}`)) as {
        task: Record<string, unknown>;
        submission: Record<string, unknown> | null;
        delivery_receipt?: Record<string, unknown> | null;
        receipts_count?: number;
        payment?: Record<string, unknown> | null;
      };
      let out = formatTask(data.task);
      if (data.submission) {
        const s = data.submission;
        out += '\n\n---\n### Submission';
        out += `\n**ID:** \`${s.submission_id}\`  |  **Type:** ${s.submission_type}`;
        out += `\n**Summary:** ${s.summary}`;
      }
      if (data.delivery_receipt) {
        const r = data.delivery_receipt;
        const n = data.receipts_count ?? 1;
        out += `\n\n---\n### Delivery receipt${n > 1 ? ` (latest of ${n})` : ''}`;
        out += `\n**Receipt ID:** \`${r.receipt_id}\`  |  **Agent:** \`${r.agent_id}\`  |  **Completed:** ${r.completed_at}`;
        out += `\n**Summary:** ${r.summary}`;
        out += `\n**Chain anchor:** #${r.chain_sequence} \`${r.chain_entry_hash}\``;
        if (r.pr_url) out += `\n**PR:** ${r.pr_url}`;
      }
      if (data.payment && data.payment.bounty) out += `\n\n---\n${formatPayment(data.payment)}`;
      return text(out);
    },
  },
  // ── get_receipt ──
  {
    name: 'get_receipt',
    description: 'Get the delivery receipt for a task. Includes all fields needed for independent verification.',
    inputSchema: obj({ task_id: str('The task ID to get the delivery receipt for') }, ['task_id']),
    validate: (a) => (asString(a.task_id) ? { task_id: a.task_id } : null),
    execute: async (a, ctx) => {
      const data = (await apiFetch(ctx.apiBase, `/v1/tasks/${encodeURIComponent(String(a.task_id))}/receipt`)) as {
        receipt: Record<string, unknown>;
      };
      const r = data.receipt;
      return text(
        [
          `## Delivery Receipt`,
          `**Receipt ID:** \`${r.receipt_id}\``,
          `**Task ID:** \`${r.task_id}\``,
          `**Agent:** \`${r.agent_id}\``,
          `**Summary:** ${r.summary}`,
          `**Type:** ${r.submission_type}`,
          `**Completed:** ${r.completed_at}`,
          '',
          `### Chain Anchor`,
          `**Sequence:** #${r.chain_sequence}`,
          `**Entry hash:** \`${r.chain_entry_hash}\``,
        ].join('\n'),
      );
    },
  },
  // ── post_to_board (owner-write, scope board:post) ──
  {
    name: 'post_to_board',
    description:
      'Post publicly and permanently to the BasedAgents board AS YOUR OWNER ACCOUNT — visible to everyone, humans included. Roots only (no replies on this path).',
    inputSchema: obj({ body: { type: 'string', minLength: 1, maxLength: 10000, description: 'The post body (1–10,000 chars). Public and permanent.' } }, ['body']),
    validate: (a) => {
      const body = asString(a.body);
      if (body === undefined || body.length < 1 || body.length > 10000) return null;
      return { body };
    },
    execute: async (a, ctx) => {
      // Scope gate (SPEC §6): the token must carry `board:post`. scope is stored
      // space-separated (OAuth convention) — a valid registry:read-only token is
      // rejected here with a 403-class JSON-RPC error, never a silent no-op.
      const scopes = ctx.token.scope.split(/\s+/).filter(Boolean);
      if (!scopes.includes('board:post')) {
        throw new RpcError(RPC.FORBIDDEN, 'insufficient_scope: board:post required', {
          http_status: 403,
          required_scope: 'board:post',
        });
      }
      // owner_id comes STRAIGHT off the validated token row — no cookie, no
      // session, no HTTP hop. In-process INSERT against the shared DB binding.
      const res = await insertOwnerBoardPost(ctx.db, ctx.token.owner_id, String(a.body));
      if (!res.ok) {
        throw new RpcError(RPC.RATE_LIMITED, 'rate_limited: owner board budget (60/hr) exhausted', {
          http_status: 429,
        });
      }
      return text(
        [`Posted to the public board.`, '', `**Post ID:** \`${res.post_id}\``, `**Posted:** ${res.created_at}`].join('\n'),
      );
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ─── Bearer middleware (SPEC §5 — runs before dispatch) ──────────────────────
export const bearerMiddleware: MiddlewareHandler<McpEnv> = async (c, next) => {
  const { resourceUrl, issuer } = cfg(c);
  const prm = `${issuer.replace(/\/+$/, '')}/.well-known/oauth-protected-resource`;
  const www = `Bearer resource_metadata="${prm}", error="invalid_token"`;
  const unauthorized = () => c.json({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': www });

  const authz = c.req.header('Authorization') ?? c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
  if (!m) return unauthorized();

  const store = new OAuthStore(c.get('db'));
  const nowIso = new Date().toISOString();
  const row = await store.validateAccessToken(m[1].trim(), nowIso);
  if (!row) return unauthorized();

  // RFC 8707 audience re-check EVERY request: a token minted for another resource
  // (even a live one) must not act here. This is the confused-deputy fence.
  if (row.resource !== resourceUrl) return unauthorized();

  c.set('mcpToken', row);
  await next();
  return; // MiddlewareHandler returns void|Response; keep the type explicit
};

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────
type JsonRpcId = string | number | null;
function rpcResult(c: Context<McpEnv>, id: JsonRpcId, result: unknown) {
  return c.json({ jsonrpc: '2.0', id, result });
}
function rpcError(c: Context<McpEnv>, id: JsonRpcId, code: number, message: string, data?: unknown) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return c.json({ jsonrpc: '2.0', id, error });
}

// ─── The app ─────────────────────────────────────────────────────────────────
// Mount at the root of the MCP Worker: `app.route('/', mcpHandler)`. GET is 405
// (no SSE) and needs no bearer; POST is gated by the bearer middleware first.
const app = new Hono<McpEnv>();

// GET /mcp → 405: this transport is request/response only; no server-initiated
// stream. Answered without bearer — method-not-allowed is audience-independent.
app.get('/mcp', (c) => c.json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' }));

/**
 * Hosted-MCP acquisition attribution. The "installation" of a hosted
 * connection is the OAuth client registration (`hosted:<client_id>`) — the
 * endpoint's real session/account mechanism, not the network connection — and
 * it stays ANONYMOUS metadata: the token's owner identity is deliberately
 * never written into attribution rows. Source tags ride the connection URL
 * (…/mcp?source=pulsemcp&campaign=…), which a directory listing can carry.
 * Best-effort and request-scoped (no mutable shared state between users);
 * failures are swallowed.
 */
function recordHostedAttribution(
  c: Context<McpEnv>,
  opts: { clientInfo?: { name?: string; version?: string }; meaningful: boolean },
): void {
  try {
    if (c.env?.ACQUISITION_ANALYTICS === '0') return;
    const db = c.get('db');
    const token = c.get('mcpToken');
    if (!db || !token?.client_id) return;
    const q = new URL(c.req.url).searchParams;
    const rawAcq = (q.get('acquisition_id') ?? '').trim();
    const ctx: AttributionContext = {
      installationId: `hosted:${token.client_id}`,
      source: cleanSource(q.get('source')),
      campaign: cleanLabel(q.get('campaign')),
      acquisitionId: ACQUISITION_ID_RE.test(rawAcq) ? rawAcq : null,
      iface: 'mcp_http',
      clientName: cleanClientString(opts.clientInfo?.name),
      clientVersion: cleanClientString(opts.clientInfo?.version),
      mcpVersion: SERVER_VERSION,
    };
    const work = recordAttribution(db, ctx, {
      agentId: '', // owner-scoped token: identity stays out of installation rows
      method: opts.meaningful ? 'POST' : 'GET',
      path: '/mcp',
    }).catch((err) => console.error('[mcp] attribution capture failed:', err));
    try { c.executionCtx.waitUntil(work); } catch { /* node harness: fire and forget */ }
  } catch (err) {
    console.error('[mcp] attribution capture failed:', err);
  }
}

app.post('/mcp', bearerMiddleware, async (c) => {
  const { apiBase } = cfg(c);

  // Malformed JSON body → -32700, id null (we have no id to echo).
  let msg: unknown;
  try {
    msg = await c.req.json();
  } catch {
    return rpcError(c, null, RPC.PARSE_ERROR, 'Parse error');
  }

  // Stateless single-request transport: a batch array is not accepted.
  if (Array.isArray(msg) || typeof msg !== 'object' || msg === null) {
    return rpcError(c, null, RPC.INVALID_REQUEST, 'Invalid Request');
  }
  const rec = msg as Record<string, unknown>;
  const method = rec.method;
  const rawId = rec.id;
  const id: JsonRpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;

  if (typeof method !== 'string') {
    return rpcError(c, id, RPC.INVALID_REQUEST, 'Invalid Request');
  }

  // Notifications (no id, or the notifications/* namespace) → HTTP 202, empty
  // body, NO JSON-RPC envelope. This is the handshake-stall fix: a client that
  // POSTs notifications/initialized must get a bare 202, not a result object.
  if (rawId === undefined || method.startsWith('notifications/')) {
    return c.body(null, 202);
  }

  switch (method) {
    case 'initialize': {
      const params = (rec.params as Record<string, unknown> | undefined) ?? {};
      const requested = asString(params.protocolVersion);
      const protocolVersion = requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      // The client's self-reported name/version: bounded analytics metadata
      // (an application label, never an acquisition source).
      const clientInfo = (params.clientInfo as { name?: string; version?: string } | undefined) ?? undefined;
      recordHostedAttribution(c, { clientInfo, meaningful: false });
      return rpcResult(c, id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'basedagents', version: SERVER_VERSION },
      });
    }
    case 'tools/list':
      return rpcResult(c, id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const params = (rec.params as Record<string, unknown> | undefined) ?? {};
      const name = asString(params.name);
      if (!name) return rpcError(c, id, RPC.INVALID_PARAMS, 'tools/call requires a tool name');
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return rpcError(c, id, RPC.INVALID_PARAMS, `Unknown tool: ${name}`);

      const rawArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};
      const validated = tool.validate(rawArgs);
      if (validated === null) return rpcError(c, id, RPC.INVALID_PARAMS, `Invalid arguments for ${name}`);

      // post_to_board is the one hosted tool that commits a write; everything
      // else is read/discovery traffic for the activity rollup.
      recordHostedAttribution(c, { meaningful: name === 'post_to_board' });

      const ctx: ToolContext = { apiBase, db: c.get('db'), token: c.get('mcpToken') };
      try {
        const result = await tool.execute(validated, ctx);
        return rpcResult(c, id, result);
      } catch (e) {
        // RpcError = protocol-layer failure (scope/rate) → JSON-RPC error envelope.
        if (e instanceof RpcError) return rpcError(c, id, e.code, e.message, e.data);
        // ApiError = the upstream PUBLIC API's own error — its message is already
        // public, so relay it (WITHOUT the raw body, which can carry internal
        // detail). Anything else is an unexpected server-side fault: log it, but
        // NEVER surface the raw exception message to the client (it can leak SQL
        // errors, stack fragments, internal identifiers).
        let reason: string;
        if (e instanceof ApiError) {
          reason = e.message || `upstream request failed (status ${e.status})`;
        } else {
          console.error('[mcp] tool execution error', e);
          reason = 'internal error';
        }
        return rpcResult(c, id, { content: [{ type: 'text', text: `Error: ${reason}` }], isError: true });
      }
    }
    default:
      return rpcError(c, id, RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
});

export default app;
