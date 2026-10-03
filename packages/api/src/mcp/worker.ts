/**
 * The `agent-registry-mcp` Worker entrypoint (SPEC §1/§5/§9, build-order 7).
 * SPEC = MCP_CONNECTOR_SPEC.md at the repo root.
 *
 * PROPRIETARY control-plane surface — see ../control/LICENSE and LICENSING.md.
 *
 * This is a SECOND Worker inside packages/api, bound to the SAME `agent-registry`
 * D1, but structurally isolated from the api Worker: it mounts ONLY the OAuth AS
 * sub-app (§2/§3) and the `/mcp` Streamable-HTTP handler (§5). It NEVER mounts
 * `/v1/owner` and NEVER mints a `ba_owner_session` — that structural absence, not
 * host-gating middleware, is what keeps the console credential off the MCP host
 * (SPEC §0/§8). The api Worker (src/index.ts) and its CREDENTIALED CORS
 * allow-list are untouched.
 *
 * CORS here is deliberately the mirror image of the api Worker's: COOKIELESS and
 * PERMISSIVE. claude.ai's connector calls the token/JSON-RPC endpoints from a
 * browser with a *bearer*, not a cookie, so we reflect any origin, allow the MCP
 * headers, and — critically — never emit `Access-Control-Allow-Credentials`.
 * Widening origin is safe precisely because no cookie/credential is in play; a
 * stolen bearer is the token's own problem, not something a CORS credential flag
 * would gate.
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { DBAdapter } from '../db/adapter.js';
import { D1Adapter } from '../db/d1-adapter.js';
import type { EmailSender } from '../control/email.js';
import oauthApp from './oauth.js';
import mcpHandler from './handler.js';

// ─── env shape (SPEC §9 [vars] + the two secrets the founder sets once) ──────
// A superset of the oauth/handler sub-app envs so `app.route` type-checks against
// both. DB is the shared `agent-registry` binding; the MCP_* vars pin the RFC
// 8707 audience + issuer; RESEND_API_KEY/EMAIL_FROM feed emailSenderFromEnv for
// the magic-link mail (resolved inside oauth.ts; production sets them as secrets).
export type WorkerBindings = {
  DB?: D1Database;
  MCP_RESOURCE_URL?: string;
  MCP_ISSUER?: string;
  API_BASE_URL?: string;
  CONSOLE_BASE_URL?: string;
  MCP_SIGNING_SECRET?: string;
  MCP_DEV?: string;
  E2E?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Per-IP limit overrides (decimal strings) — see oauth.ts / handler.ts. */
  MCP_DCR_HOURLY?: string;
  MCP_DCR_DAILY_CLIENTS?: string;
  MCP_ANON_HOURLY?: string;
  /**
   * OpenAI plugin-directory domain verification: the portal hands out a
   * challenge token at submission time; set it as a var (it is public plain
   * text, not a secret), redeploy, and /.well-known/openai-apps-challenge
   * serves it. Unset → 404.
   */
  OPENAI_APPS_CHALLENGE?: string;
};

export type WorkerVariables = {
  db: DBAdapter;
  // Set by the handler's bearer middleware / oauth's email resolution; declared
  // here only so the shared Hono generic satisfies both mounted sub-apps.
  emailSender?: EmailSender;
  mcpToken?: unknown;
};

export type WorkerEnv = { Bindings: WorkerBindings; Variables: WorkerVariables };

const app = new Hono<WorkerEnv>();

// ─── COOKIELESS PERMISSIVE CORS (SPEC §1/§8) ─────────────────────────────────
// Reflect any origin; expose the exact header set an MCP client sends. `cors`
// with `credentials` unset (default false) emits NO Access-Control-Allow-
// Credentials — the assertion the smoke test makes. This is entirely separate
// from the api Worker's credentialed whitelist; touching one never touches the
// other since they are different Workers with different app instances.
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    // The four headers a Streamable-HTTP MCP client may send: the bearer, the
    // JSON body type, the protocol-version negotiation header, and the session
    // id (we never ISSUE one, but a client may still echo it — allow it so the
    // preflight passes rather than blocking the real POST).
    allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id'],
    maxAge: 86400,
  }),
);

// ─── DB adapter middleware ───────────────────────────────────────────────────
// Wrap the shared D1 binding. Guarded like the api Worker's: only set when a DB
// binding is present, so the credential-free surfaces (PRM, AS metadata, the
// no-bearer /mcp 401, CORS preflight) still answer correctly in a Node/test
// harness that provides no DB. The atomic-write code paths always run on the
// edge where env.DB exists.
app.use('*', async (c, next) => {
  const db = (c.env as WorkerBindings | undefined)?.DB;
  if (db) c.set('db', new D1Adapter(db));
  await next();
});

// ─── OpenAI plugin-directory domain verification ─────────────────────────────
// Served here (not by the oauth sub-app) because it is a deploy-time setting of
// THIS host, not an OAuth surface. Plain text, exactly the token, nothing else.
app.get('/.well-known/openai-apps-challenge', (c: Context<WorkerEnv>) => {
  const token = (c.env as WorkerBindings | undefined)?.OPENAI_APPS_CHALLENGE;
  if (!token) return c.json({ error: 'not_found' }, 404);
  return c.text(token);
});

// ─── mounts: OAuth AS (incl. /.well-known/*) + the /mcp RS. Nothing else. ─────
// oauthApp owns /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-
// authorization-server, and /oauth/*; mcpHandler owns GET/POST /mcp. `/v1/owner`
// is absent by construction.
app.route('/', oauthApp);
app.route('/', mcpHandler);

// A bare GET / is neither an OAuth nor an MCP surface — 404 rather than leak a
// framework default. (claude.ai only ever hits the well-known + /oauth + /mcp
// paths.)
app.notFound((c: Context<WorkerEnv>) => c.json({ error: 'not_found' }, 404));

// Exported for the in-package smoke test (worker.test.ts drives app.request).
export { app };

// Cloudflare Workers module entrypoint. `app.fetch` already carries the
// (request, env, ctx) Workers signature typed to WorkerBindings via the generic,
// so hand it through directly — same shape as the api Worker's src/index.ts.
export default {
  fetch: app.fetch,
};
