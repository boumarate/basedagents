/**
 * Acquisition attribution in the stdio server (src/attribution.ts), driven
 * through the REAL server over MCP stdio like the other suites, against the
 * api workspace's Hono app wrapped in a header recorder:
 *
 *  - a tagged environment shows up as bounded attribution headers, whatever
 *    MCP client is used (the client name is metadata, never the source)
 *  - the installation id persists across restarts; distinct state paths are
 *    distinct installations
 *  - an unwritable state location degrades to NO installation id (tools keep
 *    working) instead of minting a fresh id per launch
 *  - invalid tags are discarded without blocking startup
 *  - both opt-outs (BASEDAGENTS_TELEMETRY=off, BASEDAGENTS_NO_TELEMETRY=1)
 *    silence every attribution header and create no state file
 *  - concurrent tool calls carry distinct tool-call ids (no context leak),
 *    and stdout stays valid MCP protocol throughout
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { etc } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

etc.sha512Sync = (...m: Parameters<typeof sha512>) => sha512(...m);

import { setupTestDb, createTestApp } from './api-harness.js';
import type { SQLiteAdapter } from './api-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

describe('MCP attribution', () => {
  let db: SQLiteAdapter;
  let httpServer: ServerType;
  let apiUrl: string;
  let tmp: string;
  const recorded: RecordedRequest[] = [];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-attribution-'));
    db = setupTestDb();
    const app = createTestApp(db);
    // Record every request's attribution headers, then hand it to the real app.
    const recordingFetch = (req: Request): Response | Promise<Response> => {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      recorded.push({ method: req.method, path: url.pathname, headers });
      return app.fetch(req);
    };
    const port = await new Promise<number>((resolve) => {
      httpServer = serve({ fetch: recordingFetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
    });
    apiUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawn(env: Record<string, string>, clientName = 'mcp-attribution-test'): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [require_.resolve('tsx/cli'), join(__dirname, '..', 'src', 'index.ts')],
      env: {
        ...(Object.fromEntries(
          Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('BASEDAGENTS_'))
        ) as Record<string, string>),
        BASEDAGENTS_API_URL: apiUrl,
        ...env,
      },
    });
    const client = new Client({ name: clientName, version: '0.0.0' });
    await client.connect(transport);
    return client;
  }

  function lastRequestTo(path: string): RecordedRequest {
    const match = [...recorded].reverse().find((r) => r.path === path);
    expect(match, `expected a recorded request to ${path}`).toBeDefined();
    return match!;
  }

  it('sends bounded attribution headers from a tagged environment, whatever the client', async () => {
    const statePath = join(tmp, 'tagged', 'state.json');
    const client = await spawn({
      BASEDAGENTS_ATTRIBUTION_STATE_PATH: statePath,
      BASEDAGENTS_ACQUISITION_SOURCE: 'pulsemcp',
      BASEDAGENTS_ACQUISITION_CAMPAIGN: 'directory_listing',
    });
    try {
      await client.callTool({ name: 'browse_tasks', arguments: {} });
      const req = lastRequestTo('/v1/tasks');
      expect(req.headers['x-basedagents-interface']).toBe('mcp_stdio');
      expect(req.headers['x-basedagents-acquisition-source']).toBe('pulsemcp');
      expect(req.headers['x-basedagents-acquisition-campaign']).toBe('directory_listing');
      expect(req.headers['x-basedagents-installation-id']).toMatch(UUID_RE);
      expect(req.headers['x-basedagents-mcp-version']).toMatch(/^\d+\.\d+\.\d+/);
      expect(req.headers['x-basedagents-tool-name']).toBe('browse_tasks');
      expect(req.headers['x-basedagents-tool-call-id']).toMatch(UUID_RE);
      // The MCP application is metadata, never the acquisition source.
      expect(req.headers['x-basedagents-client-name']).toBe('mcp-attribution-test');
      // And the backend recorded the source as tagged, not as the client name.
      const row = await db.get<{ source_at_first_observation: string }>(
        'SELECT source_at_first_observation FROM mcp_installations WHERE installation_id = ?',
        req.headers['x-basedagents-installation-id'],
      );
      expect(row?.source_at_first_observation).toBe('pulsemcp');
    } finally {
      await client.close();
    }
  });

  it('persists the installation id across restarts; repeated launches add no installations', async () => {
    const statePath = join(tmp, 'restart', 'state.json');
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const client = await spawn({ BASEDAGENTS_ATTRIBUTION_STATE_PATH: statePath });
      try {
        await client.callTool({ name: 'browse_tasks', arguments: {} });
        ids.push(lastRequestTo('/v1/tasks').headers['x-basedagents-installation-id']);
      } finally {
        await client.close();
      }
    }
    expect(ids[0]).toMatch(UUID_RE);
    expect(ids[1]).toBe(ids[0]);
    const saved = JSON.parse(readFileSync(statePath, 'utf-8')) as { installation_id: string };
    expect(saved.installation_id).toBe(ids[0]);
    const count = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM mcp_installations WHERE installation_id = ?', ids[0],
    );
    expect(count!.n).toBe(1);
  });

  it('gives distinct state paths distinct installation identities', async () => {
    const ids: string[] = [];
    for (const name of ['profile-a', 'profile-b']) {
      const client = await spawn({ BASEDAGENTS_ATTRIBUTION_STATE_PATH: join(tmp, name, 'state.json') });
      try {
        await client.callTool({ name: 'browse_tasks', arguments: {} });
        ids.push(lastRequestTo('/v1/tasks').headers['x-basedagents-installation-id']);
      } finally {
        await client.close();
      }
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('runs unattributed (no installation id, tools fine) when state cannot be persisted', async () => {
    // The parent "directory" is a FILE, so both read and write must fail.
    const blocker = join(tmp, 'blocker');
    writeFileSync(blocker, 'not a directory\n');
    const client = await spawn({ BASEDAGENTS_ATTRIBUTION_STATE_PATH: join(blocker, 'state.json') });
    try {
      const res = (await client.callTool({ name: 'browse_tasks', arguments: {} })) as { isError?: boolean };
      expect(res.isError ?? false).toBe(false);
      const req = lastRequestTo('/v1/tasks');
      expect(req.headers['x-basedagents-installation-id']).toBeUndefined();
      expect(req.headers['x-basedagents-interface']).toBe('mcp_stdio');
    } finally {
      await client.close();
    }
  });

  it('discards an invalid source tag without blocking startup', async () => {
    const client = await spawn({
      BASEDAGENTS_ATTRIBUTION_STATE_PATH: join(tmp, 'invalid-tag', 'state.json'),
      BASEDAGENTS_ACQUISITION_SOURCE: 'NOT A VALID SOURCE!!',
    });
    try {
      const res = (await client.callTool({ name: 'browse_tasks', arguments: {} })) as { isError?: boolean };
      expect(res.isError ?? false).toBe(false);
      const req = lastRequestTo('/v1/tasks');
      expect(req.headers['x-basedagents-acquisition-source']).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it.each([
    ['BASEDAGENTS_TELEMETRY', 'off'],
    ['BASEDAGENTS_NO_TELEMETRY', '1'],
  ])('sends no attribution and creates no state when %s=%s', async (key, value) => {
    const statePath = join(tmp, `optout-${key}`, 'state.json');
    const client = await spawn({
      BASEDAGENTS_ATTRIBUTION_STATE_PATH: statePath,
      BASEDAGENTS_ACQUISITION_SOURCE: 'pulsemcp',
      [key]: value,
    });
    try {
      const res = (await client.callTool({ name: 'browse_tasks', arguments: {} })) as { isError?: boolean };
      expect(res.isError ?? false).toBe(false);
      const req = lastRequestTo('/v1/tasks');
      for (const h of Object.keys(req.headers)) {
        expect(h.startsWith('x-basedagents-'), `unexpected analytics header ${h}`).toBe(false);
      }
      expect(existsSync(statePath)).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('delivers batched tool outcomes to /v1/telemetry/mcp, deduplicated by tool-call id', async () => {
    const client = await spawn({ BASEDAGENTS_ATTRIBUTION_STATE_PATH: join(tmp, 'outcomes', 'state.json') });
    try {
      // The queue flushes at 20 entries; drive past the threshold.
      for (let i = 0; i < 20; i++) {
        await client.callTool({ name: 'browse_tasks', arguments: {} });
      }
      const deadline = Date.now() + 5_000;
      let n = 0;
      while (Date.now() < deadline) {
        n = (await db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM mcp_tool_outcomes WHERE tool_name = 'browse_tasks' AND outcome = 'ok'",
        ))!.n;
        if (n >= 20) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(n).toBeGreaterThanOrEqual(20);
      const dupes = await db.get<{ n: number }>(
        'SELECT COUNT(*) - COUNT(DISTINCT tool_call_id) AS n FROM mcp_tool_outcomes',
      );
      expect(dupes!.n).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('keeps concurrent tool calls on distinct tool-call ids', async () => {
    const client = await spawn({ BASEDAGENTS_ATTRIBUTION_STATE_PATH: join(tmp, 'concurrent', 'state.json') });
    try {
      const before = recorded.length;
      await Promise.all([
        client.callTool({ name: 'browse_tasks', arguments: {} }),
        client.callTool({ name: 'browse_tasks', arguments: {} }),
        client.callTool({ name: 'get_chain_status', arguments: {} }),
      ]);
      const since = recorded.slice(before).filter((r) => r.headers['x-basedagents-tool-call-id']);
      const byTool = new Map<string, Set<string>>();
      for (const r of since) {
        const name = r.headers['x-basedagents-tool-name'];
        if (!byTool.has(name)) byTool.set(name, new Set());
        byTool.get(name)!.add(r.headers['x-basedagents-tool-call-id']);
      }
      // Two concurrent browse_tasks = two distinct call ids; get_chain_status
      // fires two API requests inside ONE call = one id.
      expect(byTool.get('browse_tasks')!.size).toBe(2);
      expect(byTool.get('get_chain_status')!.size).toBe(1);
    } finally {
      await client.close();
    }
  });
});
