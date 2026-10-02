/**
 * POST /v1/acquisition (setup-flow id issuance) and the website→installation
 * bridge: a minted id carries its server-side source mapping through MCP-style
 * traffic and registration, several installations may share one copied
 * snippet, and the funnel allowlist accepts the two setup events.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestApp } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';

const INSTALL_A = '11111111-2222-4333-8444-555555555555';
const INSTALL_B = '99999999-8888-4777-8666-555555555555';

describe('acquisition id issuance + bridge', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  const mint = (body: unknown) =>
    app.request('/v1/acquisition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
  });

  it('mints a bounded opaque id with server-side mapping and 90-day expiry', async () => {
    const res = await mint({ source: 'hackernews', campaign: 'october_launch' });
    expect(res.status).toBe(200);
    const body = await res.json() as { acquisition_id: string; expires_at: string };
    expect(body.acquisition_id).toMatch(/^acq_[0-9A-Za-z]{21}$/);
    const row = await db.get<{ source: string; campaign: string; expires_at: string }>(
      'SELECT source, campaign, expires_at FROM acquisition_ids WHERE id = ?', body.acquisition_id,
    );
    expect(row).toMatchObject({ source: 'hackernews', campaign: 'october_launch' });
    const days = (Date.parse(row!.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it('rejects sources outside the registry (and "unknown")', async () => {
    expect((await mint({ source: 'my_blog' })).status).toBe(400);
    expect((await mint({ source: 'unknown' })).status).toBe(400);
    expect((await mint({ source: 'pulsemcp', campaign: 'NOT VALID' })).status).toBe(400);
  });

  it('bridges one copied snippet to several installations without merging them', async () => {
    const minted = await (await mint({ source: 'pulsemcp', campaign: 'directory_listing' })).json() as { acquisition_id: string };
    for (const install of [INSTALL_A, INSTALL_B]) {
      await app.request('/v1/tasks', {
        headers: {
          'X-BasedAgents-Installation-Id': install,
          'X-BasedAgents-Interface': 'mcp_stdio',
          'X-BasedAgents-Acquisition-Id': minted.acquisition_id,
        },
      });
    }
    const rows = await db.all<{ installation_id: string; source_at_first_observation: string; method_at_first_observation: string }>(
      'SELECT installation_id, source_at_first_observation, method_at_first_observation FROM mcp_installations ORDER BY installation_id',
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.source_at_first_observation).toBe('pulsemcp');
      expect(r.method_at_first_observation).toBe('setup_token');
    }
  });

  it('accepts the two setup funnel events with the acquisition id as funnel_id', async () => {
    for (const event of ['mcp_setup_viewed', 'mcp_install_copied']) {
      const res = await app.request('/v1/funnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, funnel_id: 'acq_test12345' }),
      });
      expect(res.status, event).toBe(200);
    }
    const rows = await db.all<{ event: string }>('SELECT event FROM funnel_events ORDER BY event');
    expect(rows.map((r) => r.event)).toEqual(['mcp_install_copied', 'mcp_setup_viewed']);
  });
});
