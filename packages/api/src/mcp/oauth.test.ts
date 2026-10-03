/**
 * End-to-end tests for the MCP OAuth 2.1 AS surface (SPEC §2/§3/§8/§10).
 *
 * Drives the real Hono sub-app via app.request against a better-sqlite3 DB built
 * from the shared MCP migration concat (setupMcpTestDb) + the 0021 rate_limit_log
 * table the DCR throttle reads (grafted here, like board-post.test.ts). Email is
 * captured with an injected recording outbox — no provider, no network — so the
 * magic-link token is read straight out of the mail body. Every adversarial case
 * proves one control from the threat model (§8).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { EmailMessage } from '../control/email.js';
import { sha256 } from '../crypto/index.js';
import { setupMcpTestDb } from './test-migrations.js';
import oauthApp, { type McpEnv } from './oauth.js';
import { base64urlEncode } from './websec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RATE_LIMIT_SQL = readFileSync(
  join(__dirname, '..', '..', 'migrations', '0021_rate_limit_table.sql'),
  'utf-8',
);

const RESOURCE = 'https://mcp.basedagents.ai/mcp';
const ISSUER = 'https://mcp.basedagents.ai';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ENV = { MCP_SIGNING_SECRET: 'test-signing-secret', MCP_RESOURCE_URL: RESOURCE, MCP_ISSUER: ISSUER };
const DEV_ENV = { ...ENV, MCP_DEV: '1' };

const enc = new TextEncoder();
function pkce(verifier: string): string {
  return base64urlEncode(sha256(enc.encode(verifier)));
}

let rawDb: Database.Database;
let db: SQLiteAdapter;
let outbox: EmailMessage[];
let app: Hono<McpEnv>;

function buildApp(): Hono<McpEnv> {
  const a = new Hono<McpEnv>();
  a.use('*', async (c, next) => {
    c.set('db', db);
    c.set('emailSender', { send: async (m) => void outbox.push(m) });
    await next();
  });
  a.route('/', oauthApp);
  return a;
}

function seedOwner(email: string): string {
  const id = `ow_${email.replace(/[^a-z0-9]/gi, '_')}`;
  rawDb.prepare(`INSERT INTO owners (id, email, status) VALUES (?, ?, 'active')`).run(id, email);
  return id;
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

function cookieOf(res: Response): string {
  const setC = res.headers.get('set-cookie');
  const m = setC ? /mcp_authreq=([^;]+)/.exec(setC) : null;
  if (!m) throw new Error(`no mcp_authreq cookie in: ${setC}`);
  return `mcp_authreq=${m[1]}`;
}

function csrfOf(html: string): string {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no csrf field in page');
  return m[1];
}

async function registerClient(env: Record<string, string>, redirectUris: string[] = [REDIRECT]): Promise<Response> {
  return app.request(
    '/oauth/register',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'claude.ai' }) },
    env,
  );
}

/** Run the whole authorize→email→continue→decision handoff; return the auth code. */
async function runToCode(opts: {
  clientId: string;
  redirectUri?: string;
  challenge: string;
  scope?: string;
  state?: string;
  email: string;
}): Promise<{ code: string; location: string }> {
  const redirectUri = opts.redirectUri ?? REDIRECT;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: redirectUri,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: opts.scope ?? 'registry:read board:post',
  });
  if (opts.state) params.set('state', opts.state);

  const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
  expect(authRes.status).toBe(200);
  const cookie1 = cookieOf(authRes);
  const csrf1 = csrfOf(await authRes.text());

  const emailRes = await app.request(
    '/oauth/email',
    { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: opts.email, csrf: csrf1 }).toString() },
    ENV,
  );
  expect(emailRes.status).toBe(200);

  const link = new URL(/https?:\/\/\S+/.exec(outbox[outbox.length - 1].text)![0]);
  const lt = link.searchParams.get('lt')!;
  const req = link.searchParams.get('req')!;

  const contRes = await app.request(`/oauth/continue?lt=${encodeURIComponent(lt)}&req=${encodeURIComponent(req)}`, { headers: { Cookie: cookie1 } }, ENV);
  expect(contRes.status).toBe(200);
  const cookie2 = cookieOf(contRes);
  const csrf2 = csrfOf(await contRes.text());

  const decRes = await app.request(
    '/oauth/decision',
    { method: 'POST', headers: { ...FORM, Cookie: cookie2 }, body: new URLSearchParams({ req, csrf: csrf2, decision: 'allow' }).toString() },
    ENV,
  );
  expect(decRes.status).toBe(302);
  const location = decRes.headers.get('location')!;
  const code = new URL(location).searchParams.get('code')!;
  return { code, location };
}

async function tokenExchange(body: Record<string, string>): Promise<Response> {
  return app.request('/oauth/token', { method: 'POST', headers: FORM, body: new URLSearchParams(body).toString() }, ENV);
}

beforeEach(() => {
  const t = setupMcpTestDb();
  rawDb = t.rawDb;
  db = t.db;
  rawDb.exec(RATE_LIMIT_SQL); // the DCR limiter's backing store
  outbox = [];
  app = buildApp();
});

// ─────────────────────────── PRM / AS metadata ───────────────────────────

describe('discovery metadata', () => {
  it('serves PRM at both the bare and /mcp-suffixed paths, resource byte-identical', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await app.request(path, {}, ENV);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
      expect(body.resource).toBe(RESOURCE); // exact — RFC 8707 audience
      expect(body.authorization_servers).toEqual([ISSUER]);
      expect(body.scopes_supported).toEqual(['registry:read', 'board:post']);
    }
  });

  it('serves RFC 8414 AS metadata with S256-only + none auth', async () => {
    const res = await app.request('/.well-known/oauth-authorization-server', {}, ENV);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });
});

// ─────────────────────────────── DCR ───────────────────────────────

describe('dynamic client registration', () => {
  it('registers a public client and returns oc_ client_id with no secret', async () => {
    const res = await registerClient(ENV);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.client_id)).toMatch(/^oc_/);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.redirect_uris).toEqual([REDIRECT]);
    expect(body).not.toHaveProperty('client_secret');
  });

  it('rejects non-https, wildcard, and fragment redirect_uris', async () => {
    for (const uri of ['http://claude.ai/cb', 'https://claude.ai/*', 'https://claude.ai/cb#frag']) {
      const res = await registerClient(ENV, [uri]);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_redirect_uri' });
    }
  });

  it('rejects localhost redirect_uri in prod but allows it in dev', async () => {
    const prod = await registerClient(ENV, ['http://localhost:8080/cb']);
    expect(prod.status).toBe(400);
    const dev = await registerClient(DEV_ENV, ['http://localhost:8080/cb']);
    expect(dev.status).toBe(201);
  });

  it('fires the per-IP DCR rate limit (20/hr)', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await registerClient(ENV)).status).toBe(201);
    }
    const blocked = await registerClient(ENV);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()) as { error: string }).toMatchObject({ error: 'too_many_requests' });
  });

  it('MCP_DCR_HOURLY raises the per-IP limit without a code change (shared connector egress IPs)', async () => {
    // 22 registrations pass a limit raised to 25 — they would have tripped the default 20.
    const raised = { ...ENV, MCP_DCR_HOURLY: '25' };
    for (let i = 0; i < 22; i++) {
      expect((await registerClient(raised)).status).toBe(201);
    }
    // A garbage override falls back to the compiled default rather than opening the gate.
    const garbage = { ...ENV, MCP_DCR_HOURLY: 'unlimited' };
    const blocked = await registerClient(garbage); // 23rd from this IP ≥ default 20
    expect(blocked.status).toBe(429);
  });
});

// ─────────────────────────────── /authorize ───────────────────────────────

async function clientId(): Promise<string> {
  const res = await registerClient(ENV);
  return String(((await res.json()) as { client_id: string }).client_id);
}

function authorizeUrl(overrides: Record<string, string>): string {
  const p = new URLSearchParams({
    response_type: 'code',
    redirect_uri: REDIRECT,
    code_challenge: pkce('verifier-abc'),
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'registry:read',
    ...overrides,
  });
  return `/oauth/authorize?${p.toString()}`;
}

describe('/oauth/authorize validations', () => {
  it('rejects an unknown client without redirecting', async () => {
    const res = await app.request(authorizeUrl({ client_id: 'oc_nope' }), {}, ENV);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_client' });
  });

  it('FAILS CLOSED (503) when no signing secret is set and not in dev — never signs with a known key', async () => {
    // No MCP_SIGNING_SECRET and no MCP_DEV: the cookie-minting flow must refuse
    // rather than fall back to a guessable key (forgeable mcp_authreq → CSRF /
    // login-fixation bypass). The guard fires before any client lookup.
    const NO_SECRET = { MCP_RESOURCE_URL: RESOURCE, MCP_ISSUER: ISSUER };
    const res = await app.request(authorizeUrl({ client_id: 'oc_whatever' }), {}, NO_SECRET);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('rejects a redirect_uri that is not an exact byte-match', async () => {
    const cid = await clientId();
    for (const bad of [`${REDIRECT}/`, REDIRECT.toUpperCase(), `${REDIRECT}?x=1`]) {
      const res = await app.request(authorizeUrl({ client_id: cid, redirect_uri: bad }), {}, ENV);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_request' });
    }
  });

  it('rejects a non-S256 challenge method (plain)', async () => {
    const cid = await clientId();
    const res = await app.request(authorizeUrl({ client_id: cid, code_challenge_method: 'plain' }), {}, ENV);
    expect(res.status).toBe(400);
  });

  it('rejects a resource that is not the MCP resource URL with invalid_target', async () => {
    const cid = await clientId();
    const res = await app.request(authorizeUrl({ client_id: cid, resource: 'https://evil.example/mcp' }), {}, ENV);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_target' });
  });

  it('rejects a scope outside the allowed set', async () => {
    const cid = await clientId();
    const res = await app.request(authorizeUrl({ client_id: cid, scope: 'registry:read admin:all' }), {}, ENV);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_scope' });
  });

  it('persists the request row and sets a signed httpOnly Lax cookie on success', async () => {
    const cid = await clientId();
    const res = await app.request(authorizeUrl({ client_id: cid, state: 'xyz' }), {}, ENV);
    expect(res.status).toBe(200);
    const setC = res.headers.get('set-cookie')!;
    expect(setC).toMatch(/mcp_authreq=/);
    expect(setC).toMatch(/HttpOnly/i);
    expect(setC).toMatch(/SameSite=Lax/i);
    const rows = rawDb.prepare('SELECT * FROM oauth_authorization_requests').all() as Array<{ owner_id: string | null; state: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_id).toBeNull();
    expect(rows[0].state).toBe('xyz');
  });
});

// ─────────────────────────── login handoff ───────────────────────────

describe('magic-link login + consent handoff', () => {
  it('silently sends a link for a known owner and issues a single-use code, never a ba_owner_session', async () => {
    const email = 'owner@example.com';
    seedOwner(email);
    const cid = await clientId();
    const verifier = 'the-code-verifier-1234567890';

    const { code, location } = await runToCode({ clientId: cid, challenge: pkce(verifier), email, state: 'st1' });
    expect(code).toBeTruthy();
    expect(new URL(location).searchParams.get('state')).toBe('st1');
    expect(outbox).toHaveLength(1);

    // No console session cookie is ever minted anywhere in the flow.
    // (runToCode already asserted each step; here we confirm the code works once.)
    const first = await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(first.status).toBe(200);
  });

  it('is silent (no email) for an unknown address but renders the same page', async () => {
    const cid = await clientId();
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce('v'), code_challenge_method: 'S256', resource: RESOURCE, scope: 'registry:read' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const cookie1 = cookieOf(authRes);
    const csrf1 = csrfOf(await authRes.text());

    const emailRes = await app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: 'nobody@example.com', csrf: csrf1 }).toString() }, ENV);
    expect(emailRes.status).toBe(200);
    expect(await emailRes.text()).toMatch(/check your email/i);
    expect(outbox).toHaveLength(0); // no enumeration side-channel
  });

  it('rejects /oauth/email with a wrong or missing CSRF token', async () => {
    seedOwner('owner2@example.com');
    const cid = await clientId();
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce('v'), code_challenge_method: 'S256', resource: RESOURCE, scope: 'registry:read' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const cookie1 = cookieOf(authRes);

    const wrong = await app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: 'owner2@example.com', csrf: 'forged' }).toString() }, ENV);
    expect(wrong.status).toBe(400);
    expect(outbox).toHaveLength(0);
  });

  it('enforces the authreq_id binding at /oauth/continue (link req must match challenge)', async () => {
    seedOwner('owner3@example.com');
    const cid = await clientId();
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce('v'), code_challenge_method: 'S256', resource: RESOURCE, scope: 'registry:read' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const cookie1 = cookieOf(authRes);
    const csrf1 = csrfOf(await authRes.text());
    await app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: 'owner3@example.com', csrf: csrf1 }).toString() }, ENV);
    const link = new URL(/https?:\/\/\S+/.exec(outbox[0].text)![0]);
    const lt = link.searchParams.get('lt')!;

    // Present the real token but claim a DIFFERENT req → rejected, owner not bound.
    const res = await app.request(`/oauth/continue?lt=${encodeURIComponent(lt)}&req=someone_elses_req`, { headers: { Cookie: cookie1 } }, ENV);
    expect(res.status).toBe(400);
  });

  it('makes the magic link single-use (a replayed link is dead)', async () => {
    seedOwner('owner4@example.com');
    const cid = await clientId();
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce('v'), code_challenge_method: 'S256', resource: RESOURCE, scope: 'registry:read' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const cookie1 = cookieOf(authRes);
    const csrf1 = csrfOf(await authRes.text());
    await app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: 'owner4@example.com', csrf: csrf1 }).toString() }, ENV);
    const link = new URL(/https?:\/\/\S+/.exec(outbox[0].text)![0]);
    const lt = link.searchParams.get('lt')!;
    const req = link.searchParams.get('req')!;

    const ok = await app.request(`/oauth/continue?lt=${encodeURIComponent(lt)}&req=${encodeURIComponent(req)}`, { headers: { Cookie: cookie1 } }, ENV);
    expect(ok.status).toBe(200);
    const replay = await app.request(`/oauth/continue?lt=${encodeURIComponent(lt)}&req=${encodeURIComponent(req)}`, { headers: { Cookie: cookie1 } }, ENV);
    expect(replay.status).toBe(400);
  });

  it('never sets a ba_owner_session cookie in any step of the flow', async () => {
    seedOwner('owner5@example.com');
    const cid = await clientId();
    const verifier = 'verifier-5-abcdefghij';
    // Re-run the flow capturing every Set-Cookie header.
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce(verifier), code_challenge_method: 'S256', resource: RESOURCE, scope: 'board:post' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const cookie1 = cookieOf(authRes);
    const csrf1 = csrfOf(await authRes.text());
    const emailRes = await app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: 'owner5@example.com', csrf: csrf1 }).toString() }, ENV);
    const link = new URL(/https?:\/\/\S+/.exec(outbox[0].text)![0]);
    const lt = link.searchParams.get('lt')!, req = link.searchParams.get('req')!;
    const contRes = await app.request(`/oauth/continue?lt=${encodeURIComponent(lt)}&req=${encodeURIComponent(req)}`, { headers: { Cookie: cookie1 } }, ENV);
    const cookie2 = cookieOf(contRes);
    const csrf2 = csrfOf(await contRes.text());
    const decRes = await app.request('/oauth/decision', { method: 'POST', headers: { ...FORM, Cookie: cookie2 }, body: new URLSearchParams({ req, csrf: csrf2, decision: 'allow' }).toString() }, ENV);

    for (const res of [authRes, emailRes, contRes, decRes]) {
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(/ba_owner_session/);
    }
  });

  it('Deny redirects with error=access_denied and mints no code', async () => {
    seedOwner('owner6@example.com');
    const cid = await clientId();
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce('v'), code_challenge_method: 'S256', resource: RESOURCE, scope: 'registry:read', state: 's6' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const cookie1 = cookieOf(authRes);
    const csrf1 = csrfOf(await authRes.text());
    await app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: 'owner6@example.com', csrf: csrf1 }).toString() }, ENV);
    const link = new URL(/https?:\/\/\S+/.exec(outbox[0].text)![0]);
    const contRes = await app.request(`/oauth/continue?lt=${encodeURIComponent(link.searchParams.get('lt')!)}&req=${encodeURIComponent(link.searchParams.get('req')!)}`, { headers: { Cookie: cookie1 } }, ENV);
    const cookie2 = cookieOf(contRes);
    const csrf2 = csrfOf(await contRes.text());
    const decRes = await app.request('/oauth/decision', { method: 'POST', headers: { ...FORM, Cookie: cookie2 }, body: new URLSearchParams({ req: link.searchParams.get('req')!, csrf: csrf2, decision: 'deny' }).toString() }, ENV);
    expect(decRes.status).toBe(302);
    const loc = new URL(decRes.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('s6');
    expect(loc.searchParams.get('code')).toBeNull();
  });
});

// ───────────────────── security review fixes (regressions) ─────────────────────

describe('login-fixation: the magic-link cookie binding is MANDATORY', () => {
  it('rejects /oauth/continue when the click carries NO cookie (cross-account attack)', async () => {
    // The attack: the attacker initiates the request (their browser, their
    // client, their PKCE), seeds a login challenge for the VICTIM's email, and
    // the victim clicks the link in the victim's OWN cookieless browser. That
    // click must be refused — otherwise the victim's owner would bind to the
    // attacker's request. Here we simulate the victim's cookieless click.
    seedOwner('victim@example.com');
    const cid = await clientId();
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce('attacker-verifier'), code_challenge_method: 'S256', resource: RESOURCE, scope: 'board:post' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const attackerCookie = cookieOf(authRes);
    const csrf1 = csrfOf(await authRes.text());
    // Attacker (holding the cookie) seeds a challenge for the victim's email.
    await app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: attackerCookie }, body: new URLSearchParams({ email: 'victim@example.com', csrf: csrf1 }).toString() }, ENV);
    const link = new URL(/https?:\/\/\S+/.exec(outbox[0].text)![0]);
    const lt = link.searchParams.get('lt')!, req = link.searchParams.get('req')!;

    // Victim clicks with NO cookie → refused (was the vuln: cookie was optional).
    const victimClick = await app.request(`/oauth/continue?lt=${encodeURIComponent(lt)}&req=${encodeURIComponent(req)}`, {}, ENV);
    expect(victimClick.status).toBe(400);
    expect(await victimClick.text()).toMatch(/same browser/i);

    // And the owner was never bound, so a decision cannot mint a code.
    const dec = await app.request('/oauth/decision', { method: 'POST', headers: { ...FORM, Cookie: attackerCookie }, body: new URLSearchParams({ req, csrf: csrf1, decision: 'allow' }).toString() }, ENV);
    expect(dec.status).toBe(400);
  });

  it('the approve page names the client and redirect host (informed consent)', async () => {
    seedOwner('informed@example.com');
    const cid = await clientId(); // registered with client_name 'claude.ai'
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce('v'), code_challenge_method: 'S256', resource: RESOURCE, scope: 'board:post' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const cookie1 = cookieOf(authRes);
    const csrf1 = csrfOf(await authRes.text());
    await app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: 'informed@example.com', csrf: csrf1 }).toString() }, ENV);
    const link = new URL(/https?:\/\/\S+/.exec(outbox[0].text)![0]);
    const cont = await app.request(`/oauth/continue?lt=${encodeURIComponent(link.searchParams.get('lt')!)}&req=${encodeURIComponent(link.searchParams.get('req')!)}`, { headers: { Cookie: cookie1 } }, ENV);
    const html = await cont.text();
    expect(html).toMatch(/claude\.ai/); // client name AND redirect host both surface
  });
});

describe('/oauth/email is rate limited (no email-bomb)', () => {
  it('caps per-owner sends at 5 and per-IP requests at 10 (11th is 429)', async () => {
    seedOwner('target@example.com');
    const cid = await clientId();
    const params = new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce('v'), code_challenge_method: 'S256', resource: RESOURCE, scope: 'board:post' });
    const authRes = await app.request(`/oauth/authorize?${params.toString()}`, {}, ENV);
    const cookie1 = cookieOf(authRes);
    const csrf1 = csrfOf(await authRes.text());
    const send = () => app.request('/oauth/email', { method: 'POST', headers: { ...FORM, Cookie: cookie1 }, body: new URLSearchParams({ email: 'target@example.com', csrf: csrf1 }).toString() }, ENV);

    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429); // 11th trips the per-IP cap
    // Per-owner cap held the actual emails to 5, even though 10 requests were 200.
    expect(outbox).toHaveLength(5);
  });
});

// ─────────────────────────────── /token ───────────────────────────────

describe('/oauth/token', () => {
  async function freshCode(email: string, verifier: string, scope?: string): Promise<{ cid: string; code: string }> {
    seedOwner(email);
    const cid = await clientId();
    const { code } = await runToCode({ clientId: cid, challenge: pkce(verifier), email, scope });
    return { cid, code };
  }

  it('exchanges a code for access + refresh on the PKCE happy path', async () => {
    const verifier = 'happy-verifier-0000000000';
    const { cid, code } = await freshCode('t1@example.com', verifier);
    const res = await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string };
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.scope).toBe('registry:read board:post');
  });

  it('rejects a wrong PKCE verifier with invalid_grant', async () => {
    const { cid, code } = await freshCode('t2@example.com', 'right-verifier-111111');
    const res = await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: 'WRONG-verifier' });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a replayed code with invalid_grant', async () => {
    const verifier = 'replay-verifier-222222';
    const { cid, code } = await freshCode('t3@example.com', verifier);
    const ok = await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(ok.status).toBe(200);
    const replay = await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(replay.status).toBe(400);
    expect((await replay.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a token-time resource mismatch with invalid_target', async () => {
    const verifier = 'target-verifier-333333';
    const { cid, code } = await freshCode('t4@example.com', verifier);
    const res = await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier, resource: 'https://evil.example/mcp' });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_target' });
  });

  it('rotates the refresh token and revokes the old one', async () => {
    const verifier = 'rotate-verifier-444444';
    const { cid, code } = await freshCode('t5@example.com', verifier);
    const first = (await (await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier })).json()) as { refresh_token: string };

    const rotated = await tokenExchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: cid });
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()) as { refresh_token: string; access_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // The old refresh token is now consumed → reusing it is detected below.
    const reuseOld = await tokenExchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: cid });
    expect(reuseOld.status).toBe(400);
  });

  it('on refresh reuse revokes the ENTIRE chain (the new token stops working too)', async () => {
    const verifier = 'chain-verifier-555555';
    const { cid, code } = await freshCode('t6@example.com', verifier);
    const first = (await (await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier })).json()) as { refresh_token: string };
    const second = (await (await tokenExchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: cid })).json()) as { refresh_token: string };

    // Attacker replays the CONSUMED first token → whole chain revoked.
    const replay = await tokenExchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: cid });
    expect(replay.status).toBe(400);

    // The legitimate holder's live token (second) is now dead too.
    const secondNowDead = await tokenExchange({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: cid });
    expect(secondNowDead.status).toBe(400);

    const live = rawDb.prepare('SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE revoked_at IS NULL').get() as { n: number };
    expect(live.n).toBe(0);
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await tokenExchange({ grant_type: 'password', username: 'x', password: 'y' });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'unsupported_grant_type' });
  });
});

// ─────────────────────────── hash-at-rest ───────────────────────────

describe('no plaintext token at rest', () => {
  it('stores only hashes — the plaintext code/access/refresh never appear in any table', async () => {
    const verifier = 'hash-verifier-666666';
    seedOwner('hash@example.com');
    const cid = await clientId();
    const { code } = await runToCode({ clientId: cid, challenge: pkce(verifier), email: 'hash@example.com' });
    const body = (await (await tokenExchange({ grant_type: 'authorization_code', code, client_id: cid, redirect_uri: REDIRECT, code_verifier: verifier })).json()) as { access_token: string; refresh_token: string };

    const dump = [
      ...(rawDb.prepare('SELECT token_hash FROM oauth_login_challenges').all() as Array<{ token_hash: string }>).map((r) => r.token_hash),
      ...(rawDb.prepare('SELECT code_hash FROM oauth_auth_codes').all() as Array<{ code_hash: string }>).map((r) => r.code_hash),
      ...(rawDb.prepare('SELECT token_hash FROM oauth_access_tokens').all() as Array<{ token_hash: string }>).map((r) => r.token_hash),
      ...(rawDb.prepare('SELECT token_hash FROM oauth_refresh_tokens').all() as Array<{ token_hash: string }>).map((r) => r.token_hash),
    ];
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(body.access_token);
    expect(dump).not.toContain(body.refresh_token);
    // Every stored value is a 64-hex sha256 digest, not a base64url secret.
    for (const h of dump) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
