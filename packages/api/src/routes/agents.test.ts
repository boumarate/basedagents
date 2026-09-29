import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupTestDb, createTestApp, createTestAgent, signRequest, walletBindBody, personalSign, TEST_WALLET_KEYS } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';

// Mock twitter
vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

// Mock skills resolver
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

describe('GET /v1/agents/search', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns list of agents', async () => {
    await createTestAgent(db, { name: 'AgentAlpha', status: 'active' });
    await createTestAgent(db, { name: 'AgentBeta', status: 'active' });

    const res = await app.request('/v1/agents/search');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: unknown[]; pagination: { total: number } };
    expect(data.agents).toBeDefined();
    expect(data.agents.length).toBeGreaterThanOrEqual(2);
    expect(data.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it('pagination works', async () => {
    // Create 5 agents
    for (let i = 0; i < 5; i++) {
      await createTestAgent(db, { name: `PaginationAgent-${i}`, status: 'active' });
    }

    const res = await app.request('/v1/agents/search?limit=2&page=1');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: unknown[]; pagination: { total: number; total_pages: number } };
    expect(data.agents.length).toBeLessThanOrEqual(2);
    expect(data.pagination.total).toBeGreaterThanOrEqual(5);
    expect(data.pagination.total_pages).toBeGreaterThanOrEqual(3);
  });

  it('text search on name works', async () => {
    await createTestAgent(db, { name: 'UniqueSearchableName', status: 'active' });
    await createTestAgent(db, { name: 'SomethingElse', status: 'active' });

    const res = await app.request('/v1/agents/search?q=UniqueSearchableName');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.some(a => a.name === 'UniqueSearchableName')).toBe(true);
    expect(data.agents.every(a => a.name !== 'SomethingElse')).toBe(true);
  });

  it('capabilities filter works', async () => {
    await createTestAgent(db, {
      name: 'CodeBot',
      status: 'active',
      capabilities: ['code-generation', 'debugging'],
    });
    await createTestAgent(db, {
      name: 'DataBot',
      status: 'active',
      capabilities: ['data-analysis'],
    });

    const res = await app.request('/v1/agents/search?capabilities=code-generation');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.some(a => a.name === 'CodeBot')).toBe(true);
    expect(data.agents.every(a => a.name !== 'DataBot')).toBe(true);
  });

  it('does not include suspended agents by default', async () => {
    await createTestAgent(db, { name: 'ActiveAgent', status: 'active' });
    await createTestAgent(db, { name: 'SuspendedAgent', status: 'suspended' });

    const res = await app.request('/v1/agents/search');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.every(a => a.name !== 'SuspendedAgent')).toBe(true);
  });
});

describe('GET /v1/agents/:id', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns agent with verifications', async () => {
    const agent = await createTestAgent(db, { name: 'TestAgent', status: 'active' });
    const verifier = await createTestAgent(db, { status: 'active' });

    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'pass', 0.9, NULL, 'sig', NULL, 'n1', ?)`,
      verifier.agentId, agent.agentId, new Date().toISOString()
    );

    const res = await app.request(`/v1/agents/${agent.agentId}`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.agent_id).toBe(agent.agentId);
    expect(data.name).toBe('TestAgent');
    expect(Array.isArray(data.recent_verifications)).toBe(true);
    expect((data.recent_verifications as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('resolves agent by name (case-insensitive)', async () => {
    const agent = await createTestAgent(db, { name: 'HansTheAgent', status: 'active' });

    // Exact name
    const res1 = await app.request('/v1/agents/HansTheAgent');
    expect(res1.status).toBe(200);
    const data1 = await res1.json() as Record<string, unknown>;
    expect(data1.agent_id).toBe(agent.agentId);

    // Different casing
    const res2 = await app.request('/v1/agents/hanstheagent');
    expect(res2.status).toBe(200);
    const data2 = await res2.json() as Record<string, unknown>;
    expect(data2.agent_id).toBe(agent.agentId);
  });

  it('returns 404 for unknown name', async () => {
    const res = await app.request('/v1/agents/NonExistentAgentName');
    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('not found → 404', async () => {
    const res = await app.request('/v1/agents/ag_nonexistent123');
    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('not_found');
  });
});

describe('PATCH /v1/agents/:id/profile', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let agent: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
    agent = await createTestAgent(db, { name: 'UpdateableAgent', status: 'active' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates profile with auth', async () => {
    const patch = { description: 'Updated description for testing' };
    const bodyStr = JSON.stringify(patch);
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { description: string };
    expect(data.description).toBe('Updated description for testing');
  });

  it('clears webhook_url when set to empty string', async () => {
    // First set a webhook URL
    const setBody = JSON.stringify({ webhook_url: 'https://example.com/hook' });
    const setHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, setBody);
    await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...setHeaders },
      body: setBody,
    });

    // Now clear it with empty string
    const clearBody = JSON.stringify({ webhook_url: '' });
    const clearHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, clearBody);
    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...clearHeaders },
      body: clearBody,
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { webhook_url: string | null };
    expect(data.webhook_url).toBeNull();
  });

  it('name already taken → 409', async () => {
    await createTestAgent(db, { name: 'OtherAgent', status: 'active' });

    const patch = { name: 'OtherAgent' }; // same name as other agent
    const bodyStr = JSON.stringify(patch);
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(409);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('conflict');
  });

  it('trust-relevant update creates chain entry', async () => {
    const initialChainCount = (await db.all('SELECT * FROM chain WHERE agent_id = ?', agent.agentId)).length;

    const patch = { capabilities: ['new-capability', 'another-one'] };
    const bodyStr = JSON.stringify(patch);
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(200);

    const afterChainCount = (await db.all('SELECT * FROM chain WHERE agent_id = ?', agent.agentId)).length;
    expect(afterChainCount).toBeGreaterThan(initialChainCount);
  });

  it('cosmetic update does NOT create chain entry', async () => {
    const initialChainCount = (await db.all('SELECT * FROM chain WHERE agent_id = ?', agent.agentId)).length;

    const patch = { description: 'Changed description — purely cosmetic' };
    const bodyStr = JSON.stringify(patch);
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(200);

    const afterChainCount = (await db.all('SELECT * FROM chain WHERE agent_id = ?', agent.agentId)).length;
    expect(afterChainCount).toBe(initialChainCount);
  });

  it('without auth → 401', async () => {
    const patch = { description: 'No auth update' };
    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(401);
  });

  it('cannot update another agent profile → 403', async () => {
    const other = await createTestAgent(db, { name: 'OtherAgentToEdit', status: 'active' });

    const patch = { description: 'Trying to edit someone else' };
    const bodyStr = JSON.stringify(patch);
    // Sign as 'agent' but try to update 'other.agentId'
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${other.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${other.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(403);
  });
});

describe('GET /v1/agents/:id/reputation', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns reputation breakdown', async () => {
    const agent = await createTestAgent(db, { status: 'active' });

    const res = await app.request(`/v1/agents/${agent.agentId}/reputation`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.agent_id).toBe(agent.agentId);
    expect(typeof data.reputation_score).toBe('number');
    expect(data.breakdown).toBeDefined();
    expect(data.confidence).toBeDefined();
    expect(data.verifications_received).toBeDefined();
    expect(data.verifications_given).toBeDefined();
  });

  it('not found → 404', async () => {
    const res = await app.request('/v1/agents/ag_nonexistent999/reputation');
    expect(res.status).toBe(404);
  });
});

describe('Wallet Endpoints', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let agent: TestKeypair & { name: string };
  let otherAgent: TestKeypair & { name: string };
  const A_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // TEST_WALLET_KEYS.a
  const B_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // TEST_WALLET_KEYS.b

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
    agent = await createTestAgent(db, { name: 'WalletAgent', status: 'active' });
    otherAgent = await createTestAgent(db, { name: 'OtherWalletAgent', status: 'active' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const patchWallet = async (who: TestKeypair, body: Record<string, unknown>, target = agent.agentId) => {
    const text = JSON.stringify(body);
    const headers = await signRequest(who, 'PATCH', `/v1/agents/${target}/wallet`, text);
    return app.request(`/v1/agents/${target}/wallet`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
  };
  const getWallet = async (id = agent.agentId) => (await app.request(`/v1/agents/${id}/wallet`)).json() as Promise<Record<string, unknown>>;

  it('GET /v1/agents/:id/wallet returns wallet info', async () => {
    const res = await app.request(`/v1/agents/${agent.agentId}/wallet`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toMatchObject({ agent_id: agent.agentId, wallet_address: null, wallet_network: 'eip155:8453', wallet_verified: false, wallet_proof: null });
  });

  it('PATCH binds a wallet with a signature from it (D8), and anyone can re-check the proof', async () => {
    const body = walletBindBody(agent.agentId, TEST_WALLET_KEYS.a);
    const res = await patchWallet(agent, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ wallet_address: A_ADDR, wallet_network: 'eip155:8453', wallet_verified: true, signer_kind: 'eoa' });
    const view = await getWallet();
    expect(view).toMatchObject({ wallet_address: A_ADDR, wallet_verified: true });
    expect((view.wallet_proof as { message: string }).message).toBe(body.wallet_proof.message);
    const profile = await (await app.request(`/v1/agents/${agent.agentId}`)).json() as Record<string, unknown>;
    expect(profile).toMatchObject({ wallet_address: A_ADDR, wallet_verified: true });
  });

  it('PATCH without a proof → 400 wallet_proof_required with a message to sign; nothing changes', async () => {
    const res = await patchWallet(agent, { wallet_address: A_ADDR });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string; sign_this: string };
    expect(data.error).toBe('wallet_proof_required');
    expect(data.sign_this).toContain(`Agent: ${agent.agentId}`);
    expect(data.sign_this).toContain(`Wallet: ${A_ADDR.toLowerCase()}`);
    // Signing exactly that text and resending works.
    const retry = await patchWallet(agent, { wallet_address: A_ADDR, wallet_proof: { message: data.sign_this, signature: personalSign(data.sign_this, TEST_WALLET_KEYS.a) } });
    expect(retry.status).toBe(200);
  });

  it('refuses a proof signed by another key, for another agent, or reused', async () => {
    const wrongKey = walletBindBody(agent.agentId, TEST_WALLET_KEYS.b);
    const r1 = await patchWallet(agent, { ...wrongKey, wallet_address: A_ADDR });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toMatchObject({ error: 'wallet_proof_invalid', reason: 'address_mismatch' });

    const forOther = walletBindBody(otherAgent.agentId, TEST_WALLET_KEYS.a);
    const r2 = await patchWallet(agent, forOther);
    expect(await r2.json()).toMatchObject({ error: 'wallet_proof_invalid', reason: 'agent_mismatch' });

    const good = walletBindBody(agent.agentId, TEST_WALLET_KEYS.a);
    expect((await patchWallet(agent, good)).status).toBe(200);
    expect((await patchWallet(agent, { ...walletBindBody(agent.agentId, TEST_WALLET_KEYS.b) })).status).toBe(200);
    const replay = await patchWallet(agent, good);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: 'wallet_proof_reused' });
    expect(await getWallet()).toMatchObject({ wallet_address: B_ADDR });
  });

  it('refuses a CRLF copy of the message and a signature that is not whole bytes; the wallet is unchanged', async () => {
    const good = walletBindBody(agent.agentId, TEST_WALLET_KEYS.a);
    const crlf = good.wallet_proof.message.replace(/\n/g, '\r\n');
    const r1 = await patchWallet(agent, { ...good, wallet_proof: { message: crlf, signature: personalSign(crlf, TEST_WALLET_KEYS.a) } });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toMatchObject({ error: 'wallet_proof_invalid', reason: 'malformed_message' });

    const r2 = await patchWallet(agent, { ...good, wallet_proof: { message: good.wallet_proof.message, signature: good.wallet_proof.signature + '0' } });
    expect(r2.status).toBe(400);
    expect(await r2.json()).toMatchObject({ error: 'bad_request' });
    expect(await getWallet()).toMatchObject({ wallet_address: null, wallet_verified: false });
  });

  it('publishes the proof of the current wallet only (the bind is one atomic write)', async () => {
    expect((await patchWallet(agent, walletBindBody(agent.agentId, TEST_WALLET_KEYS.a))).status).toBe(200);
    // A stray live row for another address (as a lost race could leave) is never shown as this wallet's proof.
    await db.run(
      `INSERT INTO agent_wallet_bindings (id, agent_id, wallet_address, wallet_network, signer_kind, message, signature, nonce, bound_at)
       VALUES ('wbind_stray', ?, ?, 'eip155:8453', 'eoa', 'm', '0x00', 'straynonce', '2999-01-01T00:00:00.000Z')`,
      agent.agentId, B_ADDR,
    );
    const view = await getWallet() as { wallet_address: string; wallet_proof: { message: string } | null };
    expect(view.wallet_address).toBe(A_ADDR);
    expect(view.wallet_proof?.message).toContain(`Wallet: ${A_ADDR.toLowerCase()}`);
  });

  it('keeps a history: a new bind unbinds the old one; clearing needs no proof', async () => {
    expect((await patchWallet(agent, walletBindBody(agent.agentId, TEST_WALLET_KEYS.a))).status).toBe(200);
    expect((await patchWallet(agent, walletBindBody(agent.agentId, TEST_WALLET_KEYS.b))).status).toBe(200);
    const rows = await db.all<{ wallet_address: string; unbound_at: string | null }>('SELECT wallet_address, unbound_at FROM agent_wallet_bindings WHERE agent_id = ? ORDER BY bound_at', agent.agentId);
    expect(rows.map((r) => [r.wallet_address, r.unbound_at === null])).toEqual([[A_ADDR, false], [B_ADDR, true]]);

    const cleared = await patchWallet(agent, { wallet_address: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ wallet_address: null, wallet_verified: false, wallet_proof: null });
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_wallet_bindings WHERE agent_id = ? AND unbound_at IS NULL', agent.agentId))!.n).toBe(0);
  });

  it('re-sending the current verified wallet is a no-op; changing its network needs a new proof', async () => {
    expect((await patchWallet(agent, walletBindBody(agent.agentId, TEST_WALLET_KEYS.a))).status).toBe(200);
    expect((await patchWallet(agent, { wallet_address: A_ADDR })).status).toBe(200);
    const netOnly = await patchWallet(agent, { wallet_network: 'eip155:84532' });
    expect(netOnly.status).toBe(400);
    expect(((await netOnly.json()) as { error: string }).error).toBe('wallet_proof_required');
    expect((await patchWallet(agent, walletBindBody(agent.agentId, TEST_WALLET_KEYS.a, 'eip155:84532'))).status).toBe(200);
    expect(await getWallet()).toMatchObject({ wallet_network: 'eip155:84532', wallet_verified: true });
  });

  it('an address set before proofs existed reads as unverified until it is bound again', async () => {
    await db.run('UPDATE agents SET wallet_address = ? WHERE id = ?', '0x1111111111111111111111111111111111111111', agent.agentId);
    expect(await getWallet()).toMatchObject({ wallet_address: '0x1111111111111111111111111111111111111111', wallet_verified: false });
    const profile = await (await app.request(`/v1/agents/${agent.agentId}`)).json() as Record<string, unknown>;
    expect(profile).toMatchObject({ wallet_address: '0x1111111111111111111111111111111111111111', wallet_network: 'eip155:8453', wallet_verified: false });
  });

  it('PATCH /v1/agents/:id/wallet rejects other agent → 403', async () => {
    const res = await patchWallet(otherAgent, walletBindBody(agent.agentId, TEST_WALLET_KEYS.a));
    expect(res.status).toBe(403);
  });

  it('GET /v1/agents/:id/wallet returns 404 for unknown agent', async () => {
    const res = await app.request('/v1/agents/ag_nonexistent/wallet');
    expect(res.status).toBe(404);
  });

  it('PATCH /v1/agents/:id/wallet rejects invalid network or address → 400 bad_request', async () => {
    for (const body of [{ wallet_address: A_ADDR, wallet_network: 'not-a-valid-network' }, { wallet_address: 'not-an-evm-address' }]) {
      const res = await patchWallet(agent, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('bad_request');
    }
  });

  it('binds on every EVM network in ALLOWED_WALLET_NETWORKS; Solana has no EVM proof', async () => {
    for (const network of ['eip155:8453', 'eip155:84532', 'eip155:1', 'eip155:137', 'eip155:42161', 'eip155:10']) {
      const res = await patchWallet(agent, walletBindBody(agent.agentId, TEST_WALLET_KEYS.a, network));
      expect(res.status, network).toBe(200);
      expect(((await res.json()) as Record<string, unknown>).wallet_network).toBe(network);
    }
    const sol = await patchWallet(agent, { wallet_address: A_ADDR, wallet_network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' });
    expect(await sol.json()).toMatchObject({ error: 'wallet_proof_invalid', reason: 'unsupported_network' });
  });

  it('PATCH /v1/agents/:id/wallet without auth → 401', async () => {
    const res = await app.request(`/v1/agents/${agent.agentId}/wallet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(walletBindBody(agent.agentId)),
    });
    expect(res.status).toBe(401);
  });
});

