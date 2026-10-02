/**
 * Acquisition attribution capture (migration 0048, acquisition/capture.ts) —
 * the data boundaries, not the helper internals:
 *
 *  - the INSERT that creates an installation is the immutable first
 *    observation (unknown included), and later evidence never rewrites it
 *  - an untagged request never erases a known source; a changed tag adds a
 *    touch and moves latest_* only
 *  - a forged agent id can never create an authenticated link — only verified
 *    AgentSig auth links
 *  - invalid header values are dropped without affecting the request
 *  - a setup-flow acquisition id resolves server-side; expired/unknown ids
 *    degrade to the explicit config tag
 *  - the rollup classifies discovery vs meaningful server-side
 *  - ACQUISITION_ANALYTICS='0' writes nothing, and failed requests observe
 *    nothing
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';

const INSTALL_A = '11111111-2222-4333-8444-555555555555';
const INSTALL_B = '99999999-8888-4777-8666-555555555555';

const H = {
  install: 'X-BasedAgents-Installation-Id',
  source: 'X-BasedAgents-Acquisition-Source',
  campaign: 'X-BasedAgents-Acquisition-Campaign',
  acq: 'X-BasedAgents-Acquisition-Id',
  iface: 'X-BasedAgents-Interface',
  clientName: 'X-BasedAgents-Client-Name',
} as const;

interface InstallationRow {
  installation_id: string;
  first_observed_at: string;
  source_at_first_observation: string;
  campaign_at_first_observation: string;
  method_at_first_observation: string;
  first_known_source: string | null;
  first_known_campaign: string | null;
  first_known_source_at: string | null;
  first_known_method: string | null;
  latest_source: string;
  latest_campaign: string;
  client_name: string;
}

describe('acquisition capture', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  const installation = (id: string) =>
    db.get<InstallationRow>('SELECT * FROM mcp_installations WHERE installation_id = ?', id);
  const touches = (id: string) =>
    db.all<{ source: string; campaign: string; method: string }>(
      'SELECT source, campaign, method FROM acquisition_touches WHERE installation_id = ? ORDER BY observed_at',
      id,
    );
  const links = () =>
    db.all<{ installation_id: string; agent_id: string }>('SELECT installation_id, agent_id FROM installation_agent_links');

  const get = (path: string, headers: Record<string, string>) => app.request(path, { headers });

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
  });

  it('records an immutable unknown first observation for an untagged installation', async () => {
    const res = await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' });
    expect(res.status).toBe(200);
    const row = await installation(INSTALL_A);
    expect(row).toBeDefined();
    expect(row!.source_at_first_observation).toBe('unknown');
    expect(row!.method_at_first_observation).toBe('unknown');
    expect(row!.first_known_source).toBeNull();
    expect(await touches(INSTALL_A)).toHaveLength(0);
  });

  it('keeps the original observation when a tag arrives later, recording first_known at its real time', async () => {
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' });
    const before = (await installation(INSTALL_A))!;
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.source]: 'pulsemcp', [H.campaign]: 'directory_listing' });
    const after = (await installation(INSTALL_A))!;
    // Original observation is untouched — later evidence is never backdated.
    expect(after.source_at_first_observation).toBe('unknown');
    expect(after.first_observed_at).toBe(before.first_observed_at);
    expect(after.first_known_source).toBe('pulsemcp');
    expect(after.first_known_campaign).toBe('directory_listing');
    expect(after.first_known_method).toBe('config_tag');
    expect(after.first_known_source_at! >= before.first_observed_at).toBe(true);
    expect(after.latest_source).toBe('pulsemcp');
    expect(await touches(INSTALL_A)).toEqual([
      { source: 'pulsemcp', campaign: 'directory_listing', method: 'config_tag' },
    ]);
  });

  it('never lets an untagged request erase a known source', async () => {
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.source]: 'github' });
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' }); // untagged restart
    const row = (await installation(INSTALL_A))!;
    expect(row.source_at_first_observation).toBe('github');
    expect(row.first_known_source).toBe('github');
    expect(row.latest_source).toBe('github');
  });

  it('treats a changed tag as a new touch, never a rewrite of original attribution', async () => {
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.source]: 'github' });
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.source]: 'hackernews', [H.campaign]: 'october_launch' });
    const row = (await installation(INSTALL_A))!;
    expect(row.source_at_first_observation).toBe('github');
    expect(row.first_known_source).toBe('github');
    expect(row.latest_source).toBe('hackernews');
    expect(row.latest_campaign).toBe('october_launch');
    expect(await touches(INSTALL_A)).toHaveLength(2);
  });

  it('dedupes repeated identical tags (a stable config adds nothing)', async () => {
    for (let i = 0; i < 3; i++) {
      await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.source]: 'npm' });
    }
    expect(await touches(INSTALL_A)).toHaveLength(1);
    const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mcp_installations');
    expect(count!.n).toBe(1);
  });

  it('links installation to agent only on verified AgentSig auth — a forged header never links', async () => {
    const agent = await createTestAgent(db);
    // Unsigned request to a public endpoint: no link, whatever headers claim.
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' });
    expect(await links()).toHaveLength(0);

    // Signed request: the auth middleware sets agentId — the link is real.
    const path = `/v1/agents/${agent.agentId}/messages`;
    const auth = await signRequest(agent, 'GET', path);
    const res = await app.request(path, { headers: { ...auth, [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' } });
    expect(res.status).toBe(200);
    expect(await links()).toEqual([{ installation_id: INSTALL_A, agent_id: agent.agentId }]);
  });

  it('keeps multiple agents on one installation distinct, and installations per agent distinct', async () => {
    const a = await createTestAgent(db);
    const b = await createTestAgent(db);
    for (const [agent, install] of [[a, INSTALL_A], [b, INSTALL_A], [a, INSTALL_B]] as const) {
      const path = `/v1/agents/${agent.agentId}/messages`;
      const auth = await signRequest(agent, 'GET', path);
      await app.request(path, { headers: { ...auth, [H.install]: install, [H.iface]: 'mcp_stdio' } });
    }
    const rows = await links();
    expect(rows).toHaveLength(3);
  });

  it('drops invalid values without touching the request', async () => {
    const res = await get('/v1/tasks', {
      [H.install]: 'not-a-uuid',
      [H.source]: 'Totally<script>',
      [H.iface]: 'mcp_stdio',
    });
    expect(res.status).toBe(200);
    const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mcp_installations');
    expect(count!.n).toBe(0);
  });

  it('treats a source outside the normalized registry as unknown', async () => {
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.source]: 'my-cool-blog' });
    const row = (await installation(INSTALL_A))!;
    expect(row.source_at_first_observation).toBe('unknown');
    expect(row.first_known_source).toBeNull();
  });

  it('resolves a valid setup-flow acquisition id server-side (method setup_token)', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await db.run(
      `INSERT INTO acquisition_ids (id, source, campaign, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      'acq_test12345', 'hackernews', 'october_launch', new Date().toISOString(), future,
    );
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.acq]: 'acq_test12345' });
    const row = (await installation(INSTALL_A))!;
    expect(row.source_at_first_observation).toBe('hackernews');
    expect(row.method_at_first_observation).toBe('setup_token');
    expect(row.campaign_at_first_observation).toBe('october_launch');
  });

  it('degrades an expired or unknown acquisition id to the explicit tag, or unknown', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await db.run(
      `INSERT INTO acquisition_ids (id, source, campaign, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      'acq_expired1', 'glama', '', past, past,
    );
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.acq]: 'acq_expired1', [H.source]: 'pulsemcp' });
    const a = (await installation(INSTALL_A))!;
    expect(a.source_at_first_observation).toBe('pulsemcp');
    expect(a.method_at_first_observation).toBe('config_tag');

    await get('/v1/tasks', { [H.install]: INSTALL_B, [H.iface]: 'mcp_stdio', [H.acq]: 'acq_never_issued' });
    const b = (await installation(INSTALL_B))!;
    expect(b.source_at_first_observation).toBe('unknown');
  });

  it('rolls up discovery vs meaningful activity, classified server-side', async () => {
    const agent = await createTestAgent(db);
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' }); // GET = discovery
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' });
    const body = JSON.stringify({ body: 'hello from the attribution test' });
    const auth = await signRequest(agent, 'POST', '/v1/board/posts', body);
    const res = await app.request('/v1/board/posts', {
      method: 'POST',
      body,
      headers: { ...auth, 'Content-Type': 'application/json', [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' },
    });
    expect(res.status).toBeLessThan(300);
    const rows = await db.all<{ kind: string; count: number }>(
      'SELECT kind, count FROM installation_usage_daily WHERE installation_id = ? ORDER BY kind',
      INSTALL_A,
    );
    expect(rows).toEqual([
      { kind: 'discovery', count: 2 },
      { kind: 'meaningful', count: 1 },
    ]);
  });

  it('records bounded client metadata, never trusting it as a source', async () => {
    await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.clientName]: '  Claude Desktop\u0007  ' });
    const row = (await installation(INSTALL_A))!;
    expect(row.client_name).toBe('Claude Desktop');
    expect(row.source_at_first_observation).toBe('unknown');
  });

  it('observes nothing on a failed request', async () => {
    const res = await get('/v1/tasks/task_does_not_exist', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mcp_installations');
    expect(count!.n).toBe(0);
  });

  it('writes nothing when ACQUISITION_ANALYTICS is off, and the request still succeeds', async () => {
    const offApp = createTestApp(db, { ACQUISITION_ANALYTICS: '0' });
    const res = await offApp.request('/v1/tasks', { headers: { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.source]: 'github' } });
    expect(res.status).toBe(200);
    const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mcp_installations');
    expect(count!.n).toBe(0);
  });

  it('survives an analytics storage failure without failing the business request', async () => {
    await db.exec('DROP TABLE mcp_installations');
    const res = await get('/v1/tasks', { [H.install]: INSTALL_A, [H.iface]: 'mcp_stdio', [H.source]: 'github' });
    expect(res.status).toBe(200);
  });
});
