/**
 * Smoke test for the assembled MCP Worker (SPEC §1/§5/§9, build-order 7).
 *
 * PROPRIETARY control-plane code — see ../control/LICENSE and LICENSING.md.
 *
 * Drives the REAL top-level Hono app (the same object `export default { fetch }`
 * wraps) via app.request, proving the three wiring invariants that only exist
 * once oauth.ts + handler.ts are mounted together behind the cookieless CORS:
 *   1. PRM is served (oauth sub-app is mounted) and its `resource` is the exact
 *      MCP_RESOURCE_URL binding.
 *   2. An unauthenticated POST /mcp ANSWERS (anonymous reads are the ChatGPT-
 *      plugin shape), while an auth-marked tool still 401s with the exact
 *      WWW-Authenticate the handler emits (handler sub-app is mounted).
 *   3. The CORS preflight is COOKIELESS — it must NOT carry Access-Control-Allow-
 *      Credentials (the api Worker's credentialed allow-list is a different app).
 *   4. /.well-known/openai-apps-challenge serves the env token as plain text,
 *      404s when unset (plugin-directory domain verification).
 *
 * None of these paths touch the DB (PRM is pure config; tools/list and the
 * per-tool 401 run before any token/limiter lookup; a preflight never reaches a
 * handler), so the harness passes an env with the vars but no DB binding —
 * exactly the Node/test shape the worker's guarded db middleware tolerates.
 */
import { describe, it, expect } from 'vitest';
import { app } from './worker.js';

const RESOURCE = 'https://mcp.basedagents.ai/mcp';
const ISSUER = 'https://mcp.basedagents.ai';
const ENV = {
  MCP_RESOURCE_URL: RESOURCE,
  MCP_ISSUER: ISSUER,
  API_BASE_URL: 'https://api.basedagents.ai',
  MCP_SIGNING_SECRET: 'test-signing-secret',
} as const;

describe('MCP Worker (assembled app)', () => {
  it('serves PRM with resource byte-identical to MCP_RESOURCE_URL', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource', {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
  });

  it('serves the RFC 9728 path-suffixed PRM too (oauth sub-app mounted)', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource/mcp', {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe(RESOURCE);
  });

  it('answers an unauthenticated tools/list (anonymous reads; the ChatGPT-plugin shape)', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string; annotations?: Record<string, unknown> }[] } };
    expect(body.result.tools.length).toBeGreaterThan(0);
    for (const t of body.result.tools) expect(typeof t.annotations?.readOnlyHint).toBe('boolean');
  });

  it('still 401s an unauthenticated call to the auth-marked tool, with exact WWW-Authenticate', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_to_board', arguments: { body: 'hi' } } }),
      },
      ENV,
    );
    expect(res.status).toBe(401);
    const www = res.headers.get('WWW-Authenticate') ?? res.headers.get('www-authenticate');
    expect(www).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", error="invalid_token"`,
    );
  });

  it('serves the OpenAI domain-verification challenge from the env var, 404 when unset', async () => {
    const withToken = await app.request(
      '/.well-known/openai-apps-challenge', {}, { ...ENV, OPENAI_APPS_CHALLENGE: 'challenge-token-123' },
    );
    expect(withToken.status).toBe(200);
    expect(withToken.headers.get('content-type')).toContain('text/plain');
    expect(await withToken.text()).toBe('challenge-token-123');

    const without = await app.request('/.well-known/openai-apps-challenge', {}, ENV);
    expect(without.status).toBe(404);
  });

  it('CORS preflight is cookieless — no Access-Control-Allow-Credentials', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://claude.ai',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, content-type, mcp-protocol-version',
        },
      },
      ENV,
    );
    // The preflight is answered permissively (any origin reflected)…
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    // …but carries NO credential flag — the whole point of a bearer-only host.
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});
