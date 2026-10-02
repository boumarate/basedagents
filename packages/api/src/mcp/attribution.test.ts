/**
 * Hosted-MCP acquisition attribution (handler.ts recordHostedAttribution):
 *
 *  - the "installation" is the OAuth client registration (hosted:<client_id>),
 *    tagged through the connection URL (…/mcp?source=…)
 *  - the client's self-reported clientInfo is bounded metadata, never a source
 *  - owner identity never reaches attribution rows, and two owners sharing a
 *    client registration never leak into each other's context
 *  - ACQUISITION_ANALYTICS='0' writes nothing; untagged connections are unknown
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { setupMcpTestDb } from './test-migrations.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { OAuthStore } from './oauth-store.js';
import mcpHandler, { type McpEnv } from './handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RATE_LIMIT_SQL = readFileSync(join(__dirname, '..', '..', 'migrations', '0021_rate_limit_table.sql'), 'utf-8');

const ENV = {
  MCP_ISSUER: 'https://mcp.basedagents.ai',
  MCP_RESOURCE_URL: 'https://mcp.basedagents.ai/mcp',
  API_BASE_URL: 'https://api.basedagents.ai',
};

describe('hosted MCP attribution', () => {
  let rawDb: Database.Database;
  let db: SQLiteAdapter;
  let store: OAuthStore;
  let app: Hono<McpEnv>;

  beforeEach(() => {
    const setup = setupMcpTestDb();
    rawDb = setup.rawDb;
    db = setup.db;
    rawDb.exec(RATE_LIMIT_SQL);
    store = new OAuthStore(db);
    app = new Hono<McpEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.route('/', mcpHandler);
  });

  async function mintToken(ownerId: string, clientId: string): Promise<string> {
    rawDb.prepare('INSERT OR IGNORE INTO owners (id, email) VALUES (?, ?)').run(ownerId, `${ownerId}@example.com`);
    const { token } = await store.mintAccessToken({
      clientId,
      ownerId,
      resource: ENV.MCP_RESOURCE_URL,
      scope: 'mcp:read',
    });
    return token;
  }

  const rpc = (bearer: string, path: string, body: unknown, env: Record<string, string> = ENV) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }, env);

  const initialize = (clientInfo?: { name: string; version: string }) => ({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, ...(clientInfo ? { clientInfo } : {}) },
  });

  it('records a tagged connection as one installation per OAuth client, with bounded clientInfo', async () => {
    const token = await mintToken('ow_a', 'oc_tagged');
    const res = await rpc(token, '/mcp?source=pulsemcp&campaign=directory_listing', initialize({ name: 'Claude Desktop', version: '1.2.3' }));
    expect(res.status).toBe(200);
    const row = await db.get<Record<string, unknown>>(
      "SELECT * FROM mcp_installations WHERE installation_id = 'hosted:oc_tagged'",
    );
    expect(row).toBeDefined();
    expect(row!.source_at_first_observation).toBe('pulsemcp');
    expect(row!.campaign_at_first_observation).toBe('directory_listing');
    expect(row!.interface).toBe('mcp_http');
    expect(row!.client_name).toBe('Claude Desktop');
    // Owner identity stays out of attribution rows entirely.
    expect(JSON.stringify(row)).not.toContain('ow_a');
    const links = await db.all('SELECT * FROM installation_agent_links');
    expect(links).toHaveLength(0);
  });

  it('keeps one shared client registration as one installation, with no per-owner leakage', async () => {
    const tokenA = await mintToken('ow_a', 'oc_shared');
    const tokenB = await mintToken('ow_b', 'oc_shared');
    await rpc(tokenA, '/mcp?source=glama', initialize());
    await rpc(tokenB, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const rows = await db.all<{ installation_id: string; source_at_first_observation: string }>(
      'SELECT installation_id, source_at_first_observation FROM mcp_installations',
    );
    expect(rows).toEqual([{ installation_id: 'hosted:oc_shared', source_at_first_observation: 'glama' }]);
    // The untagged second owner's traffic did not erase the known source.
    const usage = await db.all('SELECT * FROM installation_usage_daily');
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage as Array<{ agent_id: string }>) expect(u.agent_id).toBe('');
  });

  it('records untagged connections as unknown and writes nothing when the flag is off', async () => {
    const token = await mintToken('ow_a', 'oc_plain');
    await rpc(token, '/mcp', initialize());
    const row = await db.get<{ source_at_first_observation: string }>(
      "SELECT source_at_first_observation FROM mcp_installations WHERE installation_id = 'hosted:oc_plain'",
    );
    expect(row!.source_at_first_observation).toBe('unknown');

    const token2 = await mintToken('ow_a', 'oc_off');
    const res = await rpc(token2, '/mcp?source=pulsemcp', initialize(), { ...ENV, ACQUISITION_ANALYTICS: '0' });
    expect(res.status).toBe(200);
    const off = await db.get('SELECT * FROM mcp_installations WHERE installation_id = ?', 'hosted:oc_off');
    expect(off).toBeNull();
  });
});
