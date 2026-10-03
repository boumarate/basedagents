/**
 * The BasedAgents MCP connector OAuth 2.1 Authorization Server surface
 * (SPEC §2/§3/§8). A cookieless Hono sub-app that NEVER mounts /v1/owner and
 * NEVER mints a `ba_owner_session` — it runs its OWN magic-link login against
 * its own `oauth_login_challenges` table and hands claude.ai a bearer bound to
 * `MCP_RESOURCE_URL`.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource[/mcp]  — PRM (RFC 9728, dual path)
 *   GET  /.well-known/oauth-authorization-server      — AS metadata (RFC 8414)
 *   POST /oauth/register                              — DCR (RFC 7591, public)
 *   GET  /oauth/authorize                             — validate + consent/email
 *   POST /oauth/email                                 — silent magic-link send
 *   GET  /oauth/continue                              — consume link → approve page
 *   POST /oauth/decision                              — Allow→code / Deny→error
 *   POST /oauth/token                                 — code→tokens / refresh rotate
 *
 * Every security control (PKCE S256-only, exact redirect_uri byte-match, RFC
 * 8707 resource pinning, single-use atomic consume, refresh reuse-detection,
 * CSRF + login-fixation binding, DCR per-IP throttle) lives here or in the
 * OAuthStore it drives. All secrets are generated + hashed in the store; this
 * layer only sequences the store's atomic statements and renders the browser
 * handoff.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { DBAdapter } from '../db/adapter.js';
import { sha256 } from '../crypto/index.js';
import { ControlStore } from '../control/store.js';
import { checkRateLimit } from '../lib/rate-limiter.js';
import { emailSenderFromEnv } from '../control/email.js';
import type { EmailSender } from '../control/email.js';
import { OAuthStore, AUTH_CODE_TTL_S, ACCESS_TOKEN_TTL_S } from './oauth-store.js';
import { sendMcpMagicLink } from './email.js';
import {
  base64urlEncode,
  newCsrfToken,
  signCookie,
  verifyCookie,
  timingSafeEqual,
  clientIpFrom,
  ipHash,
} from './websec.js';

// ─── env / context types (shared by handler.ts + worker.ts wiring) ───

export type McpBindings = {
  DB?: D1Database;
  MCP_RESOURCE_URL?: string;
  MCP_ISSUER?: string;
  API_BASE_URL?: string;
  MCP_SIGNING_SECRET?: string;
  /** '1' allows http/localhost redirect_uris in DCR (dev only, §2). */
  MCP_DEV?: string;
  /**
   * Optional overrides for the DCR per-IP limits (decimal strings, wrangler
   * [vars]). ChatGPT's connector traffic arrives from OpenAI's SHARED egress
   * IPs, so one "IP" there is many users — production raises these above the
   * single-tenant defaults without a redeploy of code.
   */
  MCP_DCR_HOURLY?: string;
  MCP_DCR_DAILY_CLIENTS?: string;
  /** E2E outbox switch (parity with the control plane's ladder flow). */
  E2E?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

export type McpVariables = {
  db: DBAdapter;
  /** Recording sender injected by tests; wins over the env-derived one. */
  emailSender?: EmailSender;
};

export type McpEnv = { Bindings: McpBindings; Variables: McpVariables };

// ─── config + small helpers ───

/** The two scopes the connector may ever hold (SPEC §2/§7). */
export const ALLOWED_SCOPES = ['registry:read', 'board:post'] as const;
const AUTHREQ_COOKIE = 'mcp_authreq';
const COOKIE_TTL_S = 10 * 60; // matches the authorization-request TTL
const DCR_PER_IP_HOURLY = 20; // §2 DCR abuse control (burst rate) — env-overridable, see MCP_DCR_HOURLY
const DCR_CLIENTS_PER_IP_DAILY = 100; // §8 standing-client cap (unbounded-growth guard) — env-overridable
/** Where a ChatGPT/connector user with no owner account yet goes to create one. */
const CONSOLE_START_URL = 'https://app.basedagents.ai/start';
const enc = new TextEncoder();

/** Positive-integer env override, else the compiled default. */
function intEnv(raw: string | undefined, fallback: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

interface McpConfig {
  resourceUrl: string;
  issuer: string;
  apiBaseUrl: string;
  signingSecret: string;
  isDev: boolean;
}

/** Resolve config from the Worker env, with the SPEC §9 literals as defaults. */
function cfg(c: Context<McpEnv>): McpConfig {
  const e = (c.env ?? {}) as McpBindings;
  return {
    resourceUrl: e.MCP_RESOURCE_URL || 'https://mcp.basedagents.ai/mcp',
    issuer: e.MCP_ISSUER || 'https://mcp.basedagents.ai',
    apiBaseUrl: e.API_BASE_URL || 'https://api.basedagents.ai',
    // FAIL CLOSED in prod: a missing MCP_SIGNING_SECRET must NOT fall back to a
    // publicly-known key — that would let anyone forge the mcp_authreq cookie and
    // defeat the CSRF + login-fixation binding. The dev fallback is available
    // ONLY when MCP_DEV=1 (local/test); in prod an empty secret makes the
    // cookie-dependent routes 503 (see requireSigning) rather than sign with a
    // guessable key.
    signingSecret: e.MCP_SIGNING_SECRET || (e.MCP_DEV === '1' ? 'mcp-dev-signing-secret' : ''),
    isDev: e.MCP_DEV === '1',
  };
}

/**
 * Guard the interactive (cookie-signing) routes against a misconfigured deploy:
 * with no real signing secret and not in dev, refuse rather than sign the
 * mcp_authreq cookie with a known key. Returns a 503 response to short-circuit,
 * or null to proceed. Discovery endpoints (PRM/metadata) and /token don't use
 * the cookie, so they are intentionally not guarded.
 */
function requireSigning(c: Context<McpEnv>, config: McpConfig): Response | null {
  if (config.signingSecret) return null;
  return oauthError(c, 503, 'temporarily_unavailable', 'authorization server misconfigured');
}

function getDb(c: Context<McpEnv>): DBAdapter {
  return c.get('db');
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Same resolution order as ladder.ts: injected → E2E outbox → env-derived. */
function getEmailSender(c: Context<McpEnv>): EmailSender {
  const injected = c.get('emailSender');
  if (injected) return injected;
  const e = (c.env ?? {}) as McpBindings;
  if (e.E2E === '1') {
    const store = new ControlStore(getDb(c));
    return { send: async (m) => store.appendTestOutbox(m.to, m.subject, m.text) };
  }
  return emailSenderFromEnv(c.env);
}

/** PKCE S256: base64url(sha256(ascii(code_verifier))) — the value stored as code_challenge. */
function pkceS256(verifier: string): string {
  return base64urlEncode(sha256(enc.encode(verifier)));
}

/** Minimal HTML escape for any value interpolated into a rendered page. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** OAuth error as a JSON body (RFC 6749 §5.2 / RFC 7591). */
function oauthError(
  c: Context<McpEnv>,
  status: 400 | 401 | 403 | 429 | 503,
  error: string,
  description?: string,
) {
  return c.json(description ? { error, error_description: description } : { error }, status);
}

/** Parse a space-delimited scope string to a deduped list; unknown tokens flagged. */
function parseScope(raw: string | undefined): { scopes: string[]; ok: boolean } {
  // Missing scope → request BOTH allowed scopes (the connector's full surface).
  const requested = (raw && raw.trim() ? raw.trim().split(/\s+/) : [...ALLOWED_SCOPES]).filter(Boolean);
  const deduped = [...new Set(requested)];
  const ok = deduped.every((s) => (ALLOWED_SCOPES as readonly string[]).includes(s));
  return { scopes: deduped, ok };
}

// ── DCR redirect_uri validation (SPEC §2) ──
// https-only, no wildcard, no fragment; localhost/http allowed ONLY in dev.

function validateRedirectUris(uris: unknown, isDev: boolean): string[] | null {
  if (!Array.isArray(uris) || uris.length === 0) return null;
  const out: string[] = [];
  for (const u of uris) {
    if (typeof u !== 'string' || u.length === 0) return null;
    if (u.includes('*')) return null; // no wildcard — an open-redirect vector
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return null;
    }
    if (parsed.hash !== '') return null; // no fragment (RFC 6749 §3.1.2)
    const isLocal =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1';
    if (isDev && isLocal) {
      out.push(u); // dev convenience: loopback of either scheme
    } else if (parsed.protocol === 'https:' && !isLocal) {
      out.push(u); // prod: https, non-loopback only
    } else {
      return null; // http-in-prod, localhost-in-prod → rejected
    }
  }
  return out;
}

function clientIp(c: Context<McpEnv>): string {
  return clientIpFrom((name) => c.req.header(name));
}

/**
 * Run a side-effect (the magic-link email) AFTER the response is sent, so its
 * network round-trip never contributes to response timing (account-enumeration
 * defense) and still completes on the edge. Uses the Worker's waitUntil when
 * present; in tests (no executionCtx) it awaits so the injected outbox is
 * captured deterministically.
 */
async function deferSend(c: Context<McpEnv>, p: Promise<unknown>): Promise<void> {
  // ExecutionContext is a Workers global not in this package's tsconfig types;
  // structurally type the one method we use.
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try { ctx = c.executionCtx; } catch { ctx = undefined; }
  if (ctx) { ctx.waitUntil(p.catch(() => {})); return; } // prod: deferred, no timing leak
  await p.catch(() => {}); // tests (no executionCtx): await so the outbox is captured
}

// ─── rendered pages ───

function pageShell(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(
    title,
  )}</title><style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}button,input{font:inherit}input{width:100%;padding:.6rem;margin:.4rem 0 1rem;box-sizing:border-box}button{padding:.6rem 1.2rem;margin-right:.5rem;cursor:pointer}.deny{background:#eee}</style></head><body>${inner}</body></html>`;
}

// ─── the sub-app ───

const app = new Hono<McpEnv>();

// PRM (RFC 9728) — dual-served: the bare well-known AND the path-suffixed form
// (the RFC-correct URL for a resource that itself has a path). `resource` is
// byte-identical to MCP_RESOURCE_URL so the RFC 8707 audience matches exactly.
function prmBody(config: McpConfig) {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...ALLOWED_SCOPES],
  };
}
app.get('/.well-known/oauth-protected-resource', (c) => c.json(prmBody(cfg(c))));
app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(prmBody(cfg(c))));

// AS metadata (RFC 8414). Endpoints are derived from the issuer so a staging
// issuer rewrites them consistently.
app.get('/.well-known/oauth-authorization-server', (c) => {
  const { issuer } = cfg(c);
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...ALLOWED_SCOPES],
  });
});

// ── DCR (RFC 7591, public client) ──
const RegisterSchema = z
  .object({
    redirect_uris: z.array(z.string()).min(1),
    client_name: z.string().max(256).optional(),
  })
  .passthrough();

app.post('/oauth/register', async (c) => {
  const config = cfg(c);
  const db = getDb(c);

  // Per-IP throttle FIRST (before any write) — the board:* limiter bucket keyed
  // dcr:<ipHash>, so a script can't farm client_ids to exhaust storage. Both
  // limits are env-overridable because ChatGPT and claude.ai register from
  // shared egress IPs where one "IP" is many legitimate users.
  const e = (c.env ?? {}) as McpBindings;
  const iph = ipHash(clientIp(c));
  const limit = await checkRateLimit(db, `dcr:${iph}`, intEnv(e.MCP_DCR_HOURLY, DCR_PER_IP_HOURLY), 3_600_000);
  if (!limit.allowed) {
    return oauthError(c, 429, 'too_many_requests', 'registration rate limit exceeded');
  }
  // Stored-client CAP (§8): the hourly limiter bounds burst rate, but a patient
  // script (or one rotating the x-forwarded-for fallback) could still slowly
  // accrete permanent oauth_clients rows. Cap the standing count per IP over a
  // rolling day so registration can't grow the shared table without bound.
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
  if (await new OAuthStore(db).countClientsByIpSince(iph, dayAgo) >= intEnv(e.MCP_DCR_DAILY_CLIENTS, DCR_CLIENTS_PER_IP_DAILY)) {
    return oauthError(c, 429, 'too_many_requests', 'registration limit reached');
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return oauthError(c, 400, 'invalid_client_metadata', 'invalid JSON body');
  }
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uris required');
  }
  const uris = validateRedirectUris(parsed.data.redirect_uris, config.isDev);
  if (!uris) {
    return oauthError(
      c,
      400,
      'invalid_redirect_uri',
      'every redirect_uri must be https, without wildcard or fragment',
    );
  }

  const client = await new OAuthStore(db).createClient({
    clientName: parsed.data.client_name ?? null,
    redirectUris: uris,
    regIpHash: iph,
  });
  return c.json(
    {
      client_id: client.client_id,
      client_name: client.client_name ?? undefined,
      token_endpoint_auth_method: 'none',
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: ['code'],
    },
    201,
  );
});

// ── GET /oauth/authorize ──
app.get('/oauth/authorize', async (c) => {
  const config = cfg(c);
  const misconfigured = requireSigning(c, config);
  if (misconfigured) return misconfigured;
  const db = getDb(c);
  const store = new OAuthStore(db);
  const q = c.req.query();

  // response_type MUST be code (the only type advertised).
  if (q.response_type !== 'code') {
    return oauthError(c, 400, 'unsupported_response_type', 'only response_type=code is supported');
  }
  // client MUST exist. Unknown client → do NOT redirect (RFC 6749 §4.1.2.1).
  const client = q.client_id ? await store.getClient(q.client_id) : null;
  if (!client) {
    return oauthError(c, 400, 'invalid_client', 'unknown client_id');
  }
  // redirect_uri MUST be an EXACT byte-match of a registered value — never a
  // prefix/normalized match — else an attacker registers a benign uri and
  // exfiltrates codes to a lookalike. Do NOT redirect on mismatch.
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return oauthError(c, 400, 'invalid_request', 'redirect_uri does not match a registered value');
  }
  // PKCE S256 mandatory — `plain` is rejected outright (SPEC §8).
  if (!q.code_challenge || q.code_challenge_method !== 'S256') {
    return oauthError(c, 400, 'invalid_request', 'code_challenge_method=S256 and code_challenge required');
  }
  // RFC 8707: resource MUST equal our canonical audience, else invalid_target.
  if (q.resource !== config.resourceUrl) {
    return oauthError(c, 400, 'invalid_target', 'resource must equal the MCP resource URL');
  }
  // scope MUST be a subset of the two allowed scopes.
  const { scopes, ok } = parseScope(q.scope);
  if (!ok) {
    return oauthError(c, 400, 'invalid_scope', 'scope must be a subset of registry:read board:post');
  }

  // Persist the full request (survives the email round-trip) and arm the signed
  // cookie carrying {authreq_id, csrf} — CSRF for the forms + login-fixation
  // binding for the magic-link click.
  const authreqId = await store.createAuthRequest({
    clientId: client.client_id,
    redirectUri: q.redirect_uri,
    codeChallenge: q.code_challenge,
    resource: config.resourceUrl,
    scope: scopes.join(' '),
    state: q.state ?? null,
  });
  const csrf = newCsrfToken();
  setCookie(c, AUTHREQ_COOKIE, await signCookie(config.signingSecret, { authreq_id: authreqId, csrf }), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax', // Lax: the magic-link GET is a top-level nav back to us
    path: '/',
    maxAge: COOKIE_TTL_S,
  });

  const clientLabel = client.client_name || client.client_id;
  return c.html(
    pageShell(
      'Authorize BasedAgents connector',
      `<h1>Authorize connection</h1>
       <p>Authorize <strong>${esc(clientLabel)}</strong> to read the BasedAgents registry and post to the board as your owner account.</p>
       <p>Enter your owner account email to receive a one-time sign-in link.</p>
       <form method="post" action="/oauth/email">
         <input type="email" name="email" placeholder="you@example.com" autocomplete="email" required>
         <input type="hidden" name="csrf" value="${esc(csrf)}">
         <button type="submit">Send sign-in link</button>
       </form>
       <p>No BasedAgents account yet? <a href="${esc(CONSOLE_START_URL)}" target="_blank" rel="noopener">Create one</a> (one email field), then come back here and enter that email.</p>`,
    ),
  );
});

// ── POST /oauth/email (silent magic-link) ──
app.post('/oauth/email', async (c) => {
  const config = cfg(c);
  const misconfigured = requireSigning(c, config);
  if (misconfigured) return misconfigured;
  const db = getDb(c);
  const cookie = await verifyCookie(config.signingSecret, getCookie(c, AUTHREQ_COOKIE));
  const form = await c.req.parseBody();
  const csrf = typeof form.csrf === 'string' ? form.csrf : '';
  const email = typeof form.email === 'string' ? form.email.trim().toLowerCase() : '';

  // CSRF: the form token must match the signed cookie's token exactly.
  if (!cookie || !csrf || !timingSafeEqual(csrf, cookie.csrf)) {
    return oauthError(c, 400, 'invalid_request', 'csrf validation failed');
  }
  if (!email) {
    return oauthError(c, 400, 'invalid_request', 'email required');
  }

  // Per-IP throttle on the SEND path (before any owner lookup) — bounds both
  // enumeration probing and email spray from one source. Cheap and applies to
  // known and unknown addresses alike, so it leaks nothing.
  const ipLimit = await checkRateLimit(db, `mcp:email:ip:${ipHash(clientIp(c))}`, 10, 3_600_000);
  if (!ipLimit.allowed) {
    return oauthError(c, 429, 'too_many_requests', 'too many requests, try again later');
  }

  // Low-enumeration: look the owner up but ALWAYS render the same page with the
  // same status. A challenge is minted + mailed only when the owner exists AND
  // is under its own per-owner send cap (bounds targeted email-bombing of a
  // known address to 5/hr regardless of source IP). The email is sent AFTER the
  // response (waitUntil), so the large signal — its network round-trip — is NOT
  // a timing oracle. A residual, minor timing delta remains: a known address
  // does extra synchronous D1 work (the per-owner limit check + the challenge
  // INSERT) that an unknown one skips, a few ms over samples. We accept it —
  // the per-IP cap above throttles probing to 10/hr, and closing it fully would
  // mean a dummy write per unknown-email probe (its own amplification risk).
  const owner = await new ControlStore(db).getOwnerByEmail(email);
  if (owner) {
    const ownerLimit = await checkRateLimit(db, `mcp:email:owner:${owner.id}`, 5, 3_600_000);
    if (ownerLimit.allowed) {
      const { token } = await new OAuthStore(db).createLoginChallenge({
        ownerId: owner.id,
        authreqId: cookie.authreq_id,
      });
      await deferSend(c, sendMcpMagicLink(getEmailSender(c), {
        email,
        token,
        authreqId: cookie.authreq_id,
        resourceHost: config.issuer,
      }));
    }
  }

  return c.html(
    pageShell(
      'Check your email',
      `<h1>Check your email</h1>
       <p>If an account exists for that address, we've sent a one-time sign-in link. It expires in 15 minutes.
       Open it in this same browser.</p>
       <p>No link? If you don't have a BasedAgents account yet, <a href="${esc(CONSOLE_START_URL)}" target="_blank" rel="noopener">create one</a> with that email, then restart the connection from your app.</p>`,
    ),
  );
});

// ── GET /oauth/continue (magic-link landing) ──
app.get('/oauth/continue', async (c) => {
  const config = cfg(c);
  const misconfigured = requireSigning(c, config);
  if (misconfigured) return misconfigured;
  const db = getDb(c);
  const store = new OAuthStore(db);
  const lt = c.req.query('lt') ?? '';
  const req = c.req.query('req') ?? '';
  const now = nowIso();

  // Atomically consume the challenge → owner_id. Single-use; a replayed link is
  // dead here.
  const consumed = lt ? await store.consumeLoginChallenge(lt, now) : null;
  if (!consumed) {
    return c.html(
      pageShell('Link expired', `<h1>Link expired</h1><p>This sign-in link is invalid or already used. Start again from the connector.</p>`),
      400,
    );
  }
  // The challenge is bound to its authreq; the ?req must match it.
  if (consumed.authreq_id !== req) {
    return c.html(pageShell('Mismatch', `<h1>Request mismatch</h1><p>This link does not match the authorization request.</p>`), 400);
  }
  // MANDATORY login-fixation binding (was optional — the flaw): the magic-link
  // click MUST carry the mcp_authreq cookie from the SAME browser that started
  // this authorization request. Without it we refuse. This closes cross-account
  // authorization: an attacker who initiates a request in their browser and
  // seeds a login challenge for a VICTIM's email cannot complete it, because the
  // victim clicks the link in the victim's own (cookieless) browser and is
  // rejected here, while the attacker's cookie-bearing browser never receives
  // the victim's email. SameSite=Lax lets the cookie ride a top-level GET
  // navigation from the email client, so a legitimate same-browser click still
  // carries it; a cross-browser / cross-device click is rejected by design.
  const cookie = await verifyCookie(config.signingSecret, getCookie(c, AUTHREQ_COOKIE));
  if (!cookie || cookie.authreq_id !== req) {
    return c.html(
      pageShell(
        'Open in the same browser',
        `<h1>Finish in the same browser</h1>
         <p>For your security, open this link in the same browser where you started connecting.
         Go back to that browser (or device) and click the link there — or restart the connection
         from your app.</p>`,
      ),
      400,
    );
  }

  // Bind the owner to the request EXACTLY ONCE (atomic, WHERE owner_id IS NULL).
  const bound = await store.setAuthRequestOwner(req, consumed.owner_id, now);
  if (!bound) {
    return c.html(pageShell('Expired', `<h1>Authorization expired</h1><p>This authorization request has expired or is already resolved.</p>`), 400);
  }

  // Show WHAT is being authorized (defense in depth + informed consent): the
  // registered client name and the redirect host the code will be sent to, so
  // the human can recognize the app instead of blindly approving.
  const areq = await store.getAuthRequest(req);
  const client = areq ? await store.getClient(areq.client_id) : null;
  const clientLabel = client?.client_name || 'An application';
  let redirectHost = '';
  try { redirectHost = areq ? new URL(areq.redirect_uri).host : ''; } catch { redirectHost = ''; }

  // Fresh cookie + fresh CSRF for the Approve form (re-arms the binding for the
  // decision POST, whichever browser we're now in).
  const csrf = newCsrfToken();
  setCookie(c, AUTHREQ_COOKIE, await signCookie(config.signingSecret, { authreq_id: req, csrf }), {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: COOKIE_TTL_S,
  });
  return c.html(
    pageShell(
      'Approve connection',
      `<h1>Approve connection</h1>
       <p>You're signed in. <strong>${esc(clientLabel)}</strong>${redirectHost ? ` (<code>${esc(redirectHost)}</code>)` : ''}
       is asking to read the BasedAgents registry and post to the public board as your owner account.</p>
       <p>Only approve this if you started it. If you don't recognize it, Deny.</p>
       <form method="post" action="/oauth/decision">
         <input type="hidden" name="req" value="${esc(req)}">
         <input type="hidden" name="csrf" value="${esc(csrf)}">
         <button type="submit" name="decision" value="allow">Allow</button>
         <button class="deny" type="submit" name="decision" value="deny">Deny</button>
       </form>`,
    ),
  );
});

// ── POST /oauth/decision ──
app.post('/oauth/decision', async (c) => {
  const config = cfg(c);
  const misconfigured = requireSigning(c, config);
  if (misconfigured) return misconfigured;
  const db = getDb(c);
  const store = new OAuthStore(db);
  const cookie = await verifyCookie(config.signingSecret, getCookie(c, AUTHREQ_COOKIE));
  const form = await c.req.parseBody();
  const req = typeof form.req === 'string' ? form.req : '';
  const csrf = typeof form.csrf === 'string' ? form.csrf : '';
  const decision = typeof form.decision === 'string' ? form.decision : '';
  const now = nowIso();

  // CSRF: form token vs signed cookie, and the cookie must name this exact req.
  if (!cookie || !csrf || !timingSafeEqual(csrf, cookie.csrf) || cookie.authreq_id !== req) {
    return oauthError(c, 400, 'invalid_request', 'csrf validation failed');
  }

  const row = await store.getAuthRequest(req);
  if (!row) {
    return oauthError(c, 400, 'invalid_request', 'unknown authorization request');
  }
  // Must have an owner bound (login completed) and not already resolved.
  if (row.owner_id == null || row.consumed_at != null) {
    return oauthError(c, 400, 'invalid_request', 'authorization request not ready or already used');
  }

  // Deny → redirect with access_denied (RFC 6749 §4.1.2.1), no code minted.
  if (decision !== 'allow') {
    const url = new URL(row.redirect_uri);
    url.searchParams.set('error', 'access_denied');
    if (row.state) url.searchParams.set('state', row.state);
    return c.redirect(url.toString(), 302);
  }

  // Allow → atomically consume the request (single-use), then mint a 60s code
  // bound to the full tuple. If the consume loses a race the code is never minted.
  const consumed = await store.consumeAuthRequest(req, now);
  if (!consumed) {
    return oauthError(c, 400, 'invalid_request', 'authorization request already used or expired');
  }
  const { code } = await store.mintAuthCode({
    clientId: consumed.client_id,
    ownerId: consumed.owner_id!,
    redirectUri: consumed.redirect_uri,
    codeChallenge: consumed.code_challenge,
    resource: consumed.resource,
    scope: consumed.scope,
    ttlSeconds: AUTH_CODE_TTL_S,
  });
  const url = new URL(consumed.redirect_uri);
  url.searchParams.set('code', code);
  if (consumed.state) url.searchParams.set('state', consumed.state);
  return c.redirect(url.toString(), 302);
});

// ── POST /oauth/token ──
app.post('/oauth/token', async (c) => {
  const config = cfg(c);
  const db = getDb(c);
  const store = new OAuthStore(db);
  const form = await c.req.parseBody();
  const grantType = typeof form.grant_type === 'string' ? form.grant_type : '';
  const now = nowIso();

  if (grantType === 'authorization_code') {
    const code = typeof form.code === 'string' ? form.code : '';
    const clientId = typeof form.client_id === 'string' ? form.client_id : '';
    const redirectUri = typeof form.redirect_uri === 'string' ? form.redirect_uri : '';
    const verifier = typeof form.code_verifier === 'string' ? form.code_verifier : '';
    const resource = typeof form.resource === 'string' ? form.resource : undefined;

    // Atomic single-use consume — a replayed code is dead (returns null).
    const binding = code ? await store.consumeAuthCode(code, now) : null;
    if (!binding) {
      return oauthError(c, 400, 'invalid_grant', 'authorization code invalid, expired, or already used');
    }
    // Re-verify EVERY binding the code carried (SPEC §2/§8).
    if (binding.client_id !== clientId) {
      return oauthError(c, 400, 'invalid_client', 'client_id does not match the code');
    }
    if (binding.redirect_uri !== redirectUri) {
      return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match the code');
    }
    if (verifier === '' || pkceS256(verifier) !== binding.code_challenge) {
      return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed');
    }
    // RFC 8707: if the client re-sends resource it MUST match; the code's own
    // resource was already pinned to MCP_RESOURCE_URL at /authorize.
    if (resource !== undefined && resource !== binding.resource) {
      return oauthError(c, 400, 'invalid_target', 'resource does not match the code');
    }
    if (binding.resource !== config.resourceUrl) {
      return oauthError(c, 400, 'invalid_target', 'code bound to a different resource');
    }

    const access = await store.mintAccessToken({
      clientId: binding.client_id,
      ownerId: binding.owner_id,
      resource: binding.resource,
      scope: binding.scope,
    });
    const refresh = await store.mintRefreshToken({
      clientId: binding.client_id,
      ownerId: binding.owner_id,
      resource: binding.resource,
      scope: binding.scope,
    });
    return c.json({
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: access.expiresIn,
      refresh_token: refresh.token,
      scope: binding.scope,
    });
  }

  if (grantType === 'refresh_token') {
    const presented = typeof form.refresh_token === 'string' ? form.refresh_token : '';
    const clientId = typeof form.client_id === 'string' ? form.client_id : undefined;
    if (!presented) {
      return oauthError(c, 400, 'invalid_grant', 'refresh_token required');
    }
    // Rotate with reuse-detection: a replayed (already-consumed) token revokes
    // the whole chain and fails; unknown/expired/revoked also fail.
    const rot = await store.rotateRefreshToken(presented, now);
    if (rot.status !== 'ok') {
      return oauthError(c, 400, 'invalid_grant', 'refresh token invalid, expired, or reused');
    }
    // If the client identifies itself it must be the token's own client.
    if (clientId !== undefined && clientId !== rot.client_id) {
      return oauthError(c, 400, 'invalid_client', 'client_id does not match the refresh token');
    }
    const access = await store.mintAccessToken({
      clientId: rot.client_id,
      ownerId: rot.owner_id,
      resource: rot.resource,
      scope: rot.scope,
    });
    return c.json({
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: rot.refresh_token,
      scope: rot.scope,
    });
  }

  return oauthError(c, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
});

export default app;
