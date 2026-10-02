/**
 * POST /v1/telemetry/mcp — client-reported MCP tool outcomes:
 *
 *  - ingestion is idempotent by tool_call_id (retried batches add nothing)
 *  - batches are bounded in count and bytes
 *  - agent_id binds ONLY through verified AgentSig auth; a body field or
 *    header claiming an agent is ignored (spoofed events stay anonymous
 *    reported activity and can never become conversions — those derive from
 *    domain tables this endpoint cannot write)
 *  - outcome values are the bounded taxonomy, error_code a bounded category
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestApp, createTestAgent, signRequest } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';

const INSTALL = '11111111-2222-4333-8444-555555555555';
const CALL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const event = (overrides: Record<string, unknown> = {}) => ({
  tool_call_id: CALL_ID,
  tool_name: 'browse_tasks',
  outcome: 'ok',
  ...overrides,
});

describe('POST /v1/telemetry/mcp', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/v1/telemetry/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const rows = () =>
    db.all<{ tool_call_id: string; agent_id: string; installation_id: string; outcome: string; error_code: string }>(
      'SELECT tool_call_id, agent_id, installation_id, outcome, error_code FROM mcp_tool_outcomes',
    );

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
  });

  it('stores a batch and dedupes retried deliveries by tool_call_id', async () => {
    const res1 = await post({ events: [event()] }, { 'X-BasedAgents-Installation-Id': INSTALL });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ ok: true, accepted: 1 });
    const res2 = await post({ events: [event({ outcome: 'tool_error' })] });
    expect(await res2.json()).toMatchObject({ ok: true, accepted: 0 }); // one FINAL outcome per call
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe('ok');
    expect(all[0].installation_id).toBe(INSTALL);
  });

  it('binds agent_id only through verified AgentSig auth', async () => {
    const agent = await createTestAgent(db);
    const body = JSON.stringify({ events: [event()] });
    const auth = await signRequest(agent, 'POST', '/v1/telemetry/mcp', body);
    const res = await app.request('/v1/telemetry/mcp', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect((await rows())[0].agent_id).toBe(agent.agentId);
  });

  it('ignores a spoofed agent id in the body — unsigned events stay anonymous', async () => {
    const victim = await createTestAgent(db);
    const res = await post({ events: [event({ agent_id: victim.agentId })] });
    expect(res.status).toBe(200);
    expect((await rows())[0].agent_id).toBe('');
  });

  it('rejects an oversized batch count and an oversized body', async () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      event({ tool_call_id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}` }));
    expect((await post({ events: many })).status).toBe(400);
    const huge = { events: [event({ client_time: 'x'.repeat(40_000) })] };
    expect((await post(huge)).status).toBe(413);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects outcomes outside the taxonomy and unbounded error text', async () => {
    expect((await post({ events: [event({ outcome: 'exploded' })] })).status).toBe(400);
    expect((await post({ events: [event({ error_code: 'RAW: secret stack trace!' })] })).status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it('tolerates malformed JSON and empty batches without storing anything', async () => {
    const bad = await app.request('/v1/telemetry/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{',
    });
    expect(bad.status).toBe(400);
    expect((await post({ events: [] })).status).toBe(400);
  });

  it('cannot create conversions: only mcp_tool_outcomes rows are written', async () => {
    await post({ events: [event({ outcome: 'payment_required' })] });
    for (const table of ['tasks', 'agent_acquisition', 'payment_events']) {
      const n = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(n!.n, table).toBe(0);
    }
  });
});
