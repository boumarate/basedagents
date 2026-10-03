/**
 * Acquisition attribution for the stdio MCP server: optional source tags,
 * a persistent anonymous installation identity, per-tool-call context, and
 * best-effort outcome telemetry.
 *
 * Contract (mirrors the API's acquisition/ module):
 *   - Everything here is OPTIONAL analytics. Invalid configuration is
 *     discarded with one stderr warning and never blocks startup; an
 *     unwritable or corrupt state file never blocks a tool — the server then
 *     runs with NO installation id (unattributed) rather than minting a fresh
 *     one per launch.
 *   - Telemetry off (BASEDAGENTS_TELEMETRY=off, or its alias
 *     BASEDAGENTS_NO_TELEMETRY=1) means: no state file is read or created, no
 *     attribution headers are sent, no outcome telemetry leaves the process.
 *     Business requests (signing, tools) are unaffected.
 *   - Headers ride unsigned next to AgentSig (which covers method, path,
 *     timestamp, body hash and nonce — never headers) and only ever go to the
 *     configured BasedAgents API, nowhere else.
 *   - All diagnostics go to stderr; stdout stays reserved for MCP protocol.
 *   - Never collected: prompts, tool arguments or results, deliverable bodies,
 *     keypair paths, private keys, auth headers, signatures, wallets, or
 *     environment dumps. Outcomes carry a bounded category code only.
 *
 * Reset: delete the state file (default locations below, or
 * BASEDAGENTS_ATTRIBUTION_STATE_PATH) and a new installation id is minted on
 * the next observed use.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ─── Vocabulary (kept in sync with packages/api/src/acquisition/constants.ts;
//     no cross-package import — same rule as the money helpers in index.ts) ───

const ACQUISITION_SOURCES = [
  'website', 'github', 'npm', 'mcp_registry', 'pulsemcp', 'glama', 'smithery', 'hackernews', 'partner', 'unknown',
] as const;

const LABEL_RE = /^[a-z0-9_-]{1,64}$/;
const ACQUISITION_ID_RE = /^acq_[A-Za-z0-9_-]{1,96}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type McpToolOutcome = 'ok' | 'tool_error' | 'api_error' | 'auth_required' | 'payment_required' | 'network_error';

const HEADERS = {
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

function warn(msg: string): void {
  process.stderr.write(`[basedagents-mcp] ${msg}\n`);
}

/** Bounded client-reported string: control chars stripped, 64 chars max. */
function cleanClientString(v: string | undefined | null): string {
  return (v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

// ─── Opt-out ────────────────────────────────────────────────────────────────

/**
 * BASEDAGENTS_TELEMETRY=off is this package's documented switch;
 * BASEDAGENTS_NO_TELEMETRY=1 is honored as an alias so one opt-out covers the
 * MCP server and the CLI. Off disables optional analytics only — registrations, tasks,
 * receipts and payments still produce their required operational records.
 */
export function telemetryEnabled(): boolean {
  if ((process.env.BASEDAGENTS_TELEMETRY ?? '').toLowerCase() === 'off') return false;
  if (process.env.BASEDAGENTS_NO_TELEMETRY === '1') return false;
  return true;
}

// ─── Configuration (CLI flags beat env vars; invalid values are discarded) ──

interface AttributionConfig {
  source: string | null;
  campaign: string | null;
  acquisitionId: string | null;
}

function argValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

function validated(kind: 'source' | 'campaign' | 'acquisition-id', raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  if (kind === 'acquisition-id') {
    if (ACQUISITION_ID_RE.test(v)) return v;
  } else if (LABEL_RE.test(v)) {
    if (kind === 'campaign') return v;
    if ((ACQUISITION_SOURCES as readonly string[]).includes(v) && v !== 'unknown') return v;
  }
  warn(`ignoring invalid --${kind} value (analytics tag only — the server keeps running)`);
  return null;
}

function parseConfig(argv: string[], env: NodeJS.ProcessEnv): AttributionConfig {
  return {
    source: validated('source', argValue(argv, '--source') ?? env.BASEDAGENTS_ACQUISITION_SOURCE),
    campaign: validated('campaign', argValue(argv, '--campaign') ?? env.BASEDAGENTS_ACQUISITION_CAMPAIGN),
    acquisitionId: validated('acquisition-id', argValue(argv, '--acquisition-id') ?? env.BASEDAGENTS_ACQUISITION_ID),
  };
}

// ─── Persistent installation identity ───────────────────────────────────────

/**
 * The state file lives in the platform's application-state directory —
 * deliberately NOT next to keypair files, and the id is a plain random UUID,
 * never derived from a key, hostname, email, wallet or network address. One
 * file = one installation profile; a distinct profile on the same machine
 * sets BASEDAGENTS_ATTRIBUTION_STATE_PATH.
 */
export function attributionStatePath(): string {
  const explicit = process.env.BASEDAGENTS_ATTRIBUTION_STATE_PATH;
  if (explicit) return explicit;
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'basedagents', 'mcp-installation.json');
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'basedagents', 'mcp-installation.json');
  }
  return join(process.env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'basedagents', 'mcp-installation.json');
}

async function readInstallationId(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as { installation_id?: unknown };
    const id = typeof parsed.installation_id === 'string' ? parsed.installation_id : '';
    return UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Load — or mint once — the installation id. The first writer wins
 * atomically: the record is written to a temp file, then hard-linked to the
 * final path, which fails with EEXIST if another process got there first — in
 * which case that process's id is read and used. A linked file is always
 * complete, so an existing file that doesn't parse is genuinely corrupt and is
 * replaced. Any failure returns null: the server runs unattributed rather than
 * minting a new "installation" per launch.
 */
export async function loadInstallationId(path: string = attributionStatePath()): Promise<string | null> {
  const existing = await readInstallationId(path);
  if (existing) return existing;
  let tmp: string | null = null;
  try {
    await mkdir(dirname(path), { recursive: true });
    tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const record = { installation_id: randomUUID(), created_at: new Date().toISOString() };
    await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    try {
      await link(tmp, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        const winner = await readInstallationId(path);
        if (winner) return winner;
        await rename(tmp, path); // corrupt file: replace it
        tmp = null;
      } else {
        // No hard links on this filesystem: plain atomic rename, then reread.
        await rename(tmp, path);
        tmp = null;
      }
    }
    const settled = await readInstallationId(path);
    if (settled) return settled;
    warn(`attribution state at ${path} is unreadable after write — running unattributed`);
    return null;
  } catch (err) {
    warn(`cannot persist attribution state at ${path} (${err instanceof Error ? err.message : String(err)}) — running unattributed`);
    return null;
  } finally {
    if (tmp) await unlink(tmp).catch(() => undefined);
  }
}

// ─── Module state ───────────────────────────────────────────────────────────

interface ToolContext {
  toolName: string;
  toolCallId: string;
  outcome?: McpToolOutcome;
  errorCode: string;
}

const als = new AsyncLocalStorage<ToolContext>();

let config: AttributionConfig = { source: null, campaign: null, acquisitionId: null };
let installationId: string | null = null;
let apiUrl = '';
let packageVersion = '';
let enabled = false;
let clientInfoProvider: () => { name?: string; version?: string } | undefined = () => undefined;

export interface AttributionInit {
  apiUrl: string;
  version: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse config and load the installation identity. Never throws and never
 * blocks startup on anything but the one state-file read/write.
 */
export async function initAttribution(init: AttributionInit): Promise<void> {
  apiUrl = init.apiUrl;
  packageVersion = init.version;
  enabled = telemetryEnabled();
  if (!enabled) return; // no config parse side effects needed; nothing is sent
  config = parseConfig(init.argv ?? process.argv.slice(2), init.env ?? process.env);
  installationId = await loadInstallationId();
}

/** The MCP client's self-reported name/version arrives at `initialize`; read lazily. */
export function setClientInfoProvider(fn: () => { name?: string; version?: string } | undefined): void {
  clientInfoProvider = fn;
}

/**
 * The optional attribution headers for one outgoing API request. Empty when
 * telemetry is off. Spread BEFORE auth headers so nothing here can ever shadow
 * Authorization/X-Timestamp/X-Nonce.
 */
export function attributionHeaders(): Record<string, string> {
  if (!enabled) return {};
  const h: Record<string, string> = { [HEADERS.interface]: 'mcp_stdio' };
  if (installationId) h[HEADERS.installationId] = installationId;
  if (config.source) h[HEADERS.source] = config.source;
  if (config.campaign) h[HEADERS.campaign] = config.campaign;
  if (config.acquisitionId) h[HEADERS.acquisitionId] = config.acquisitionId;
  if (packageVersion) h[HEADERS.mcpVersion] = cleanClientString(packageVersion);
  let info: { name?: string; version?: string } | undefined;
  try { info = clientInfoProvider(); } catch { /* client info is optional */ }
  const clientName = cleanClientString(info?.name);
  const clientVersion = cleanClientString(info?.version);
  if (clientName) h[HEADERS.clientName] = clientName;
  if (clientVersion) h[HEADERS.clientVersion] = clientVersion;
  const ctx = als.getStore();
  if (ctx) {
    h[HEADERS.toolName] = ctx.toolName;
    h[HEADERS.toolCallId] = ctx.toolCallId;
  }
  return h;
}

// ─── Per-tool-call context + outcome classification ─────────────────────────

/**
 * Let the result helpers (noAuthResult, taskErrorResult, escrowChallengeResult)
 * name the real outcome of the current tool call — an HTTP 200 carrying an MCP
 * tool error must never be reported as success, and a 402 handshake is
 * payment_required, never funding. No-op outside a tool call or when off.
 */
export function markOutcome(outcome: McpToolOutcome, errorCode = ''): void {
  const ctx = als.getStore();
  if (!ctx) return;
  ctx.outcome = outcome;
  ctx.errorCode = /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : '';
}

/**
 * Run one tool invocation inside its own AsyncLocalStorage context: a fresh
 * tool_call_id (stable across every internal API request/retry of this
 * invocation, distinct across concurrent calls), headers carrying tool
 * name/id, and one reported final outcome.
 */
export async function runTool<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const ctx: ToolContext = { toolName, toolCallId: randomUUID(), errorCode: '' };
  return als.run(ctx, async () => {
    try {
      const result = await fn();
      const isError = typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true;
      enqueueOutcome(ctx, ctx.outcome ?? (isError ? 'tool_error' : 'ok'));
      return result;
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      const outcome: McpToolOutcome = ctx.outcome
        ?? (typeof status === 'number' ? (status === 402 ? 'payment_required' : 'api_error') : 'network_error');
      enqueueOutcome(ctx, outcome);
      throw err;
    }
  });
}

// ─── Outcome telemetry (bounded, batched, fire-and-forget) ──────────────────

interface OutcomeEvent {
  tool_call_id: string;
  tool_name: string;
  outcome: McpToolOutcome;
  error_code: string;
  client_time: string;
}

const MAX_QUEUE = 100; // hard cap — no unbounded offline queue
const FLUSH_AT = 20;
const FLUSH_INTERVAL_MS = 30_000;

let queue: OutcomeEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> = Promise.resolve();

function enqueueOutcome(ctx: ToolContext, outcome: McpToolOutcome): void {
  if (!enabled) return;
  if (queue.length >= MAX_QUEUE) return; // drop, never buffer without bound
  queue.push({
    tool_call_id: ctx.toolCallId,
    tool_name: ctx.toolName,
    outcome,
    error_code: ctx.errorCode,
    client_time: new Date().toISOString(),
  });
  if (!flushTimer) {
    flushTimer = setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS);
    flushTimer.unref(); // never keep the process alive for analytics
  }
  if (queue.length >= FLUSH_AT) void flushTelemetry();
}

/**
 * One POST, no retries, every error swallowed to a (single-shot per launch)
 * stderr note. The endpoint dedupes by tool_call_id, so an overlap between a
 * size-triggered and a timer-triggered flush can never double-count.
 */
let flushWarned = false;
function warnDeliveryOnce(reason: string): void {
  if (flushWarned) return;
  flushWarned = true;
  warn(`telemetry delivery failed (${reason}) — continuing without it; undelivered outcomes are dropped, never retried`);
}

/** Inside the ~2 s an MCP client waits after closing stdin before SIGTERM. */
const FLUSH_TIMEOUT_MS = 1_500;

export async function flushTelemetry(): Promise<void> {
  flushing = flushing.then(async () => {
    if (!enabled || queue.length === 0) return;
    const batch = queue.slice(0, 50);
    queue = queue.slice(batch.length);
    try {
      const res = await fetch(`${apiUrl}/v1/telemetry/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...attributionHeaders() },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      });
      // A rejected batch (rate limit, server error) is a collection gap, not
      // something to retry without bound — but it is never silent.
      if (!res.ok) warnDeliveryOnce(`HTTP ${res.status}`);
    } catch (err) {
      warnDeliveryOnce(err instanceof Error ? err.message : String(err));
    }
  });
  return flushing;
}

/**
 * Deliver what's queued when the session ends. MCP clients end a stdio
 * server by closing its stdin (then waiting ~2 s before SIGTERM), so a short
 * session with fewer than a batch of calls still reports them. Bounded by the
 * request timeout; the in-flight request is what keeps the process alive long
 * enough to send it.
 */
export function installShutdownFlush(): void {
  if (!enabled) return;
  const flushNow = () => {
    if (queue.length > 0) void flushTelemetry();
  };
  process.stdin.once('end', flushNow);
  process.stdin.once('close', flushNow);
  process.once('beforeExit', flushNow);
}
