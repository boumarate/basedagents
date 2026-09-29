import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RegistryClient,
  generateKeypair,
  publicKeyToAgentId,
  usdcToAtomic,
  atomicToDisplay,
  ApiError,
  PaymentRequiredError,
  PaymentInvalidError,
  PAYMENT_HEADER,
  TASK_STATUSES,
  type Agent,
  type ReputationBreakdown,
  type WalletInfo,
  type PaymentRequiredBody,
} from './index.js';

// ─── Helpers ───

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_TestAgent123',
    name: 'TestAgent',
    description: 'A test agent',
    status: 'active',
    reputation_score: 0.8,
    verification_count: 10,
    capabilities: ['code'],
    protocols: ['https'],
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeReputation(agentId = 'ag_TestAgent123'): ReputationBreakdown {
  return {
    agent_id: agentId,
    reputation_score: 0.8,
    raw_score: 0.79,
    confidence: 0.9,
    penalty: 0,
    safety_flags: 0,
    breakdown: {
      pass_rate: 0.85,
      coherence: 0.80,
      contribution: 0.75,
      uptime: 0.90,
      cap_confirmation_rate: 0.70,
      task_completion: 0.42,
    },
    weights: {
      pass_rate: 0.35,
      coherence: 0.20,
      contribution: 0.15,
      uptime: 0.15,
      cap_confirmation_rate: 0.15,
      penalty: 0.20,
      task_completion: 0.15,
    },
    verifications_received: 20,
    verifications_given: 15,
    tasks_accepted: 3,
    tasks_failed: 0.5,
  };
}

function makeMockResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const PAYMENT_REQUIRED: PaymentRequiredBody = {
  error: 'payment_required',
  message: 'Sign an EIP-3009 USDC transfer of 5.00 USDC and retry with the PAYMENT-SIGNATURE header.',
  x402Version: 2,
  resource: { url: 'https://api.basedagents.ai/v1/tasks/task_paid/accept', description: 'BasedAgents task task_paid bounty', mimeType: 'application/json' },
  accepts: [{
    scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '5000000', payTo: '0x' + 'ab'.repeat(20), maxTimeoutSeconds: 3600, extra: { name: 'USD Coin', version: '2' },
  }],
  task_id: 'task_paid',
  bounty: { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' },
  accept_endpoint: 'POST /v1/tasks/task_paid/accept',
  payment_header: 'PAYMENT-SIGNATURE',
};

// ─── Tests ───

describe('RegistryClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── searchAgents ──

  describe('searchAgents()', () => {
    it('sends a GET request to /v1/agents/search', async () => {
      const payload = { agents: [makeAgent()], total: 1, page: 1 };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      await client.searchAgents({});

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/agents/search');
    });

    it('passes query parameters in the URL', async () => {
      const payload = { agents: [], total: 0, page: 1 };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      await client.searchAgents({ q: 'hello', status: 'active', page: 2 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('q=hello');
      expect(url).toContain('status=active');
      expect(url).toContain('page=2');
    });

    it('returns parsed agents array', async () => {
      const agents = [makeAgent({ name: 'AgentOne' }), makeAgent({ name: 'AgentTwo' })];
      mockFetch.mockResolvedValueOnce(makeMockResponse({ agents, total: 2, page: 1 }));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.searchAgents();

      expect(result.agents).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.agents[0].name).toBe('AgentOne');
    });
  });

  // ── getAgent ──

  describe('getAgent()', () => {
    it('sends GET to /v1/agents/:id', async () => {
      const agent = makeAgent();
      mockFetch.mockResolvedValueOnce(makeMockResponse(agent));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getAgent('ag_TestAgent123');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/agents/ag_TestAgent123');
      expect(result.name).toBe('TestAgent');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({ message: 'Not found' }, 404));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.getAgent('ag_missing')).rejects.toThrow('404');
    });

    it('throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.getAgent('ag_test')).rejects.toThrow('Network error');
    });
  });

  // ── getReputation ──

  describe('getReputation()', () => {
    it('sends GET to /v1/agents/:id/reputation', async () => {
      const rep = makeReputation();
      mockFetch.mockResolvedValueOnce(makeMockResponse(rep));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getReputation('ag_TestAgent123');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/agents/ag_TestAgent123/reputation');
      expect(result.reputation_score).toBe(0.8);
    });

    it('returns full reputation breakdown', async () => {
      const rep = makeReputation('ag_SomeAgent');
      mockFetch.mockResolvedValueOnce(makeMockResponse(rep));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getReputation('ag_SomeAgent');

      expect(result.agent_id).toBe('ag_SomeAgent');
      expect(result.breakdown).toHaveProperty('pass_rate');
      expect(result.breakdown).toHaveProperty('coherence');
      expect(result.breakdown.cap_confirmation_rate).toBe(0.70);
      expect(result.breakdown.task_completion).toBe(0.42);
      expect(result.weights.task_completion).toBe(0.15);
      expect(result.tasks_accepted).toBe(3);
      expect(result.tasks_failed).toBe(0.5);
    });
  });

  // ── updateProfile ──

  describe('updateProfile()', () => {
    it('sends PATCH to /v1/agents/:id/profile with auth headers', async () => {
      const kp = await generateKeypair();
      const agentId = publicKeyToAgentId(kp.publicKey);
      const updatedAgent = makeAgent({ name: 'UpdatedAgent' });
      mockFetch.mockResolvedValueOnce(makeMockResponse(updatedAgent));

      const client = new RegistryClient('https://api.test.local');
      await client.updateProfile(kp, { name: 'UpdatedAgent' });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain(`/v1/agents/${agentId}/profile`);
      expect(init.method).toBe('PATCH');
      expect(init.headers?.Authorization).toMatch(/^AgentSig /);
      expect(init.headers?.['X-Timestamp']).toBeDefined();
    });

    it('throws on 400 error', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ message: 'Validation failed' }, 400));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.updateProfile(kp, { name: '' })).rejects.toThrow('400');
    });
  });

  // ── register ──

  describe('register()', () => {
    it('solves PoW and submits registration', async () => {
      const kp = await generateKeypair();
      const challenge = 'dGVzdC1jaGFsbGVuZ2U='; // base64 test string

      // Step 1: init response (low difficulty for test speed)
      const initPayload = { challenge_id: 'chal_123', challenge, difficulty: 4 };
      // Step 2: complete response — the REAL shape the API returns (agent_id +
      // status at the top level, no nested `agent`).
      const completePayload = {
        agent_id: 'ag_test123',
        status: 'active',
        chain_sequence: 5,
        entry_hash: 'deadbeef',
        profile_url: 'https://basedagents.ai/agent/TestAgent',
        badge_url: 'https://api.basedagents.ai/v1/agents/ag_test123/badge',
        webhook_secret: 'whsec_abc',
      };

      mockFetch
        .mockResolvedValueOnce(makeMockResponse(initPayload))
        .mockResolvedValueOnce(makeMockResponse(completePayload));

      const client = new RegistryClient('https://api.test.local');
      const agent = await client.register(kp, {
        name: 'TestAgent',
        description: 'A test agent',
        capabilities: ['code'],
        protocols: ['https'],
      });

      // register() must return a usable agent built from the real response —
      // regression for the bug where it returned `result.agent` (undefined).
      expect(agent).toBeDefined();
      expect(agent.id).toBe('ag_test123');
      expect(agent.name).toBe('TestAgent');
      expect(agent.status).toBe('active');
      expect(agent.chain_sequence).toBe(5);
      expect(agent.webhook_secret).toBe('whsec_abc');

      // Verify init was called first
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [initUrl, initOpts] = mockFetch.mock.calls[0];
      expect(initUrl).toContain('/v1/register/init');
      expect(initOpts.method).toBe('POST');

      // Verify complete was called with all required fields
      const [completeUrl, completeOpts] = mockFetch.mock.calls[1];
      expect(completeUrl).toContain('/v1/register/complete');
      const completeBody = JSON.parse(completeOpts.body);
      expect(completeBody.challenge_id).toBe('chal_123');
      expect(completeBody.nonce).toMatch(/^[0-9a-f]{8}$/);
      expect(completeBody.signature).toBeDefined();
      expect(completeBody.profile.name).toBe('TestAgent');
    });

    it('throws when init fails', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ message: 'Server error' }, 500));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.register(kp, {
        name: 'TestAgent',
        description: 'desc',
        capabilities: ['code'],
        protocols: ['https'],
      })).rejects.toThrow('500');
    });
  });

  // ── submitVerification ──

  describe('submitVerification()', () => {
    it('sends POST to /v1/verify/submit with auth headers', async () => {
      const kp = await generateKeypair();
      const responsePayload = { ok: true, verification_id: 'v_123', target_reputation_delta: 0.01 };
      mockFetch.mockResolvedValueOnce(makeMockResponse(responsePayload));

      const client = new RegistryClient('https://api.test.local');
      await client.submitVerification(kp, {
        assignment_id: 'a_123',
        target_id: 'ag_target',
        result: 'pass',
        coherence_score: 0.9,
        notes: 'Excellent',
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/verify/submit');
      expect(init.method).toBe('POST');
      expect(init.headers?.Authorization).toMatch(/^AgentSig /);

      const body = JSON.parse(init.body);
      expect(body.assignment_id).toBe('a_123');
      expect(body.target_id).toBe('ag_target');
      expect(body.result).toBe('pass');
      expect(body.signature).toBeDefined(); // Report signed before submission
      expect(body.nonce).toBeDefined();
    });
  });

  // ── Error handling ──

  describe('error handling', () => {
    it('throws with status code on API error', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({ message: 'Bad request' }, 400));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.searchAgents()).rejects.toThrow('400');
    });

    it('throws an ApiError carrying status, machine code and body', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({ error: 'wallet_required', message: 'Set a wallet first', help: { set_wallet: 'PATCH /v1/agents/ag_x/wallet' } }, 409));

      const client = new RegistryClient('https://api.test.local');
      const err = await client.claimTask(await generateKeypair(), 'task_1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.code).toBe('wallet_required');
      expect((apiErr.body as { help: { set_wallet: string } }).help.set_wallet).toContain('/wallet');
      expect(apiErr.message).toContain('409');
    });

    it('propagates network errors', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.searchAgents()).rejects.toThrow('Failed to fetch');
    });
  });

  // ── getWallet ──

  describe('getWallet()', () => {
    it('sends GET to /v1/agents/:id/wallet', async () => {
      const payload: WalletInfo = { agent_id: 'ag_Test123', wallet_address: '0x' + 'ab'.repeat(20), wallet_network: 'eip155:8453' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getWallet('ag_Test123');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/agents/ag_Test123/wallet');
      expect(result.wallet_address).toBe('0x' + 'ab'.repeat(20));
    });
  });

  // ── updateWallet ──

  describe('updateWallet()', () => {
    it('sends PATCH to /v1/agents/:id/wallet with auth headers', async () => {
      const kp = await generateKeypair();
      const agentId = publicKeyToAgentId(kp.publicKey);
      const payload: WalletInfo = { agent_id: agentId, wallet_address: '0x' + 'ab'.repeat(20), wallet_network: 'eip155:8453' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.updateWallet(kp, { wallet_address: '0x' + 'ab'.repeat(20) });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain(`/v1/agents/${agentId}/wallet`);
      expect(init.method).toBe('PATCH');
      expect(init.headers?.Authorization).toMatch(/^AgentSig /);
      expect(result.wallet_address).toBe('0x' + 'ab'.repeat(20));
    });

    it('rejects invalid wallet address', async () => {
      const kp = await generateKeypair();
      const client = new RegistryClient('https://api.test.local');
      await expect(client.updateWallet(kp, { wallet_address: 'not-an-address' }))
        .rejects.toThrow('Invalid wallet address');
    });
  });

  // ── getTasks ──

  describe('getTasks()', () => {
    it('sends GET to /v1/tasks', async () => {
      const payload = { ok: true, tasks: [] };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getTasks();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/tasks');
      expect(result.tasks).toEqual([]);
    });

    it('passes query parameters', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({ ok: true, tasks: [] }));

      const client = new RegistryClient('https://api.test.local');
      await client.getTasks({ status: 'open', category: 'code', limit: 5, creator: 'ag_c', claimer: 'ag_d' });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('status=open');
      expect(url).toContain('category=code');
      expect(url).toContain('limit=5');
      expect(url).toContain('creator=ag_c');
      expect(url).toContain('claimer=ag_d');
    });
  });

  // ── getSettledTasks ──

  describe('getSettledTasks()', () => {
    it('sends GET to /v1/tasks/settled', async () => {
      const payload = { ok: true, stats: { n: 0 }, tasks: [], next_cursor: null };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getSettledTasks();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/tasks/settled');
      expect(result.next_cursor).toBeNull();
    });

    it('passes limit, cursor and window_days', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({ ok: true, stats: {}, tasks: [], next_cursor: null }));

      const client = new RegistryClient('https://api.test.local');
      await client.getSettledTasks({ limit: 25, cursor: '2026-09-23T14:36:22.188Z', window_days: 90 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('limit=25');
      expect(url).toContain('cursor=2026-09-23T14%3A36%3A22.188Z');
      expect(url).toContain('window_days=90');
    });
  });

  // ── getTask ──

  describe('getTask()', () => {
    it('sends GET to /v1/tasks/:id', async () => {
      const payload = {
        ok: true,
        task: { task_id: 'task_abc', title: 'Test', status: 'open' },
        submission: null,
        delivery_receipt: null,
      };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getTask('task_abc');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/tasks/task_abc');
      expect(result.task.task_id).toBe('task_abc');
    });
  });

  // ── createTask ──

  describe('createTask()', () => {
    it('sends POST to /v1/tasks with auth headers', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_new', status: 'open' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.createTask(kp, {
        title: 'Research AI safety',
        description: 'Write a report on AI safety frameworks',
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/tasks');
      expect(init.method).toBe('POST');
      expect(init.headers?.Authorization).toMatch(/^AgentSig /);
      expect(result.task_id).toBe('task_new');
    });

    it('declares a bounty in atomic units in the body and never sends a payment header', async () => {
      const kp = await generateKeypair();
      const payload = {
        ok: true, task_id: 'task_paid', status: 'open', payment_status: 'pending',
        bounty: { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' },
      };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.createTask(kp, {
        title: 'Paid task',
        description: 'A task with a bounty',
        bounty: { amount: usdcToAtomic('5.00'), token: 'USDC', network: 'eip155:8453' },
      });

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body).bounty).toEqual({ amount: '5000000', token: 'USDC', network: 'eip155:8453' });
      expect(init.headers?.[PAYMENT_HEADER]).toBeUndefined();
      expect(init.headers?.['X-PAYMENT-SIGNATURE']).toBeUndefined();
      expect(result.payment_status).toBe('pending');
      expect(result.bounty?.amount_display).toBe('5.00');
    });
  });

  // ── claimTask ──

  describe('claimTask()', () => {
    it('sends POST to /v1/tasks/:id/claim with auth', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_abc', status: 'claimed' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.claimTask(kp, 'task_abc');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/tasks/task_abc/claim');
      expect(init.method).toBe('POST');
      expect(result.status).toBe('claimed');
    });
  });

  // ── deliverTask ──

  describe('deliverTask()', () => {
    it('sends POST to /v1/tasks/:id/deliver with delivery body', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_abc', receipt_id: 'rcpt_1', chain_sequence: 5, chain_entry_hash: 'abc', status: 'submitted' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.deliverTask(kp, 'task_abc', {
        summary: 'Done',
        submission_type: 'pr',
        pr_url: 'https://github.com/org/repo/pull/1',
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/tasks/task_abc/deliver');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.summary).toBe('Done');
      expect(body.submission_type).toBe('pr');
      expect(result.receipt_id).toBe('rcpt_1');
    });

    it('maps the `content` alias to submission_content (the deliver route ignores `content`)', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ ok: true, task_id: 'task_abc', receipt_id: 'rcpt_2', status: 'submitted' }));

      const client = new RegistryClient('https://api.test.local');
      await client.deliverTask(kp, 'task_abc', { summary: 'Done', submission_type: 'json', content: '{"ok":true}' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.submission_content).toBe('{"ok":true}');
      expect(body.content).toBeUndefined();
    });

    it('does not overwrite an explicit submission_content with the alias', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ ok: true, task_id: 'task_abc', receipt_id: 'rcpt_3', status: 'submitted' }));

      const client = new RegistryClient('https://api.test.local');
      await client.deliverTask(kp, 'task_abc', { summary: 'Done', submission_type: 'json', submission_content: 'real', content: 'ignored' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.submission_content).toBe('real');
      expect(body.content).toBeUndefined();
    });
  });

  // ── acceptTask ──

  describe('acceptTask()', () => {
    it('sends POST to /v1/tasks/:id/accept with auth and an optional note', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_abc', status: 'verified', accepted_by: 'creator', payment_status: 'none', chain_sequence: 4, chain_entry_hash: 'abc' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.acceptTask(kp, 'task_abc', { note: 'Looks good' });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/tasks/task_abc/accept');
      expect(init.method).toBe('POST');
      expect(init.headers?.Authorization).toMatch(/^AgentSig /);
      expect(init.headers?.[PAYMENT_HEADER]).toBeUndefined();
      expect(JSON.parse(init.body)).toEqual({ note: 'Looks good' });
      expect(result.status).toBe('verified');
      expect(result.payment_status).toBe('none');
      expect(result.accepted_by).toBe('creator');
    });

    it('throws PaymentRequiredError on 402 payment_required, carrying the challenge and the PAYMENT-REQUIRED header', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse(PAYMENT_REQUIRED, 402, { 'PAYMENT-REQUIRED': 'eyJ4NDAyVmVyc2lvbiI6Mn0=' }));

      const client = new RegistryClient('https://api.test.local');
      const err = await client.acceptTask(kp, 'task_paid').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PaymentRequiredError);
      expect(err).toBeInstanceOf(ApiError);
      const pr = err as PaymentRequiredError;
      expect(pr.status).toBe(402);
      expect(pr.code).toBe('payment_required');
      expect(pr.taskId).toBe('task_paid');
      expect(pr.accepts).toHaveLength(1);
      expect(pr.accepts[0].payTo).toBe('0x' + 'ab'.repeat(20));
      expect(pr.accepts[0].amount).toBe('5000000');
      expect(pr.accepts[0].maxTimeoutSeconds).toBe(3600);
      expect(pr.resource.url).toContain('/v1/tasks/task_paid/accept');
      expect(pr.paymentRequired.bounty?.amount_display).toBe('5.00');
      expect(pr.paymentRequired.payment_header).toBe('PAYMENT-SIGNATURE');
      expect(pr.paymentRequiredHeader).toBe('eyJ4NDAyVmVyc2lvbiI6Mn0=');
      expect(pr.message).toContain('402');
    });

    it('sends paymentSignature as the PAYMENT-SIGNATURE header and surfaces settlement + PAYMENT-RESPONSE', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_paid', status: 'verified', accepted_by: 'creator', payment_status: 'settled', payment_tx_hash: '0xdef', chain_sequence: 5, chain_entry_hash: 'h' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload, 200, { 'PAYMENT-RESPONSE': 'eyJzdWNjZXNzIjp0cnVlfQ==' }));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.acceptTask(kp, 'task_paid', { paymentSignature: 'c2lnbmVk' });

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers?.[PAYMENT_HEADER]).toBe('c2lnbmVk');
      expect(init.headers?.['X-PAYMENT-SIGNATURE']).toBeUndefined();
      expect(result.payment_status).toBe('settled');
      expect(result.payment_tx_hash).toBe('0xdef');
      expect(result.payment_response_header).toBe('eyJzdWNjZXNzIjp0cnVlfQ==');
    });

    it('throws PaymentInvalidError on 402 payment_invalid with reason / expected / got', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({
        error: 'payment_invalid', reason: 'recipient_mismatch', expected: '0x' + 'ab'.repeat(20), got: '0x' + 'cd'.repeat(20),
        message: "The signed authorization does not match this task's payment requirements.", payment_requirements: PAYMENT_REQUIRED.accepts[0],
      }, 402));

      const client = new RegistryClient('https://api.test.local');
      const err = await client.acceptTask(kp, 'task_paid', { paymentSignature: 'bad' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PaymentInvalidError);
      const pi = err as PaymentInvalidError;
      expect(pi.status).toBe(402);
      expect(pi.code).toBe('payment_invalid');
      expect(pi.reason).toBe('recipient_mismatch');
      expect(pi.expected).toBe('0x' + 'ab'.repeat(20));
      expect(pi.got).toBe('0x' + 'cd'.repeat(20));
      expect(pi.paymentRequirements?.amount).toBe('5000000');
      expect(pi.message).toContain('recipient_mismatch');
    });

    it('maps insufficient_funds to PaymentInvalidError too', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ error: 'insufficient_funds', reason: 'insufficient_funds', message: 'Not enough USDC', payer: '0x' + 'ef'.repeat(20) }, 402));

      const client = new RegistryClient('https://api.test.local');
      const err = await client.acceptTask(kp, 'task_paid', { paymentSignature: 'sig' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PaymentInvalidError);
      expect((err as PaymentInvalidError).code).toBe('insufficient_funds');
      expect((err as PaymentInvalidError).payer).toBe('0x' + 'ef'.repeat(20));
    });

    it('throws a plain ApiError with the code on 409', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ error: 'settlement_in_progress', message: 'still settling', payment_status: 'settling' }, 409));

      const client = new RegistryClient('https://api.test.local');
      const err = await client.acceptTask(kp, 'task_paid', { paymentSignature: 'sig' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(PaymentRequiredError);
      expect((err as ApiError).code).toBe('settlement_in_progress');
      expect((err as ApiError).message).toContain('409');
    });
  });

  // ── verifyTask (deprecated alias) ──

  describe('verifyTask()', () => {
    it('is a deprecated alias that calls /accept', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_abc', status: 'verified', accepted_by: 'creator', payment_status: 'settled', payment_tx_hash: '0xdef' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.verifyTask(kp, 'task_abc');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/tasks/task_abc/accept');
      expect(url).not.toContain('/verify');
      expect(init.method).toBe('POST');
      expect(result.payment_status).toBe('settled');
      expect(result.payment_tx_hash).toBe('0xdef');
    });
  });

  // ── requestRevision ──

  describe('requestRevision()', () => {
    it('sends POST to /v1/tasks/:id/revision with the note', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_abc', status: 'claimed', review_state: 'revision_requested', revision_count: 1 };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.requestRevision(kp, 'task_abc', 'Please add tests');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/tasks/task_abc/revision');
      expect(init.method).toBe('POST');
      expect(init.headers?.Authorization).toMatch(/^AgentSig /);
      expect(JSON.parse(init.body)).toEqual({ note: 'Please add tests' });
      expect(result.status).toBe('claimed');
      expect(result.review_state).toBe('revision_requested');
      expect(result.revision_count).toBe(1);
    });

    it('requires a non-empty note (no request made)', async () => {
      const kp = await generateKeypair();
      const client = new RegistryClient('https://api.test.local');
      await expect(client.requestRevision(kp, 'task_abc', '  ')).rejects.toThrow('note');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── getTaskReceipts ──

  describe('getTaskReceipts()', () => {
    it('sends GET to /v1/tasks/:id/receipts', async () => {
      const payload = { ok: true, receipts: [{ receipt_id: 'rcpt_2', task_id: 'task_abc', completed_at: '2026-01-02T00:00:00Z' }, { receipt_id: 'rcpt_1', task_id: 'task_abc', completed_at: '2026-01-01T00:00:00Z' }] };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getTaskReceipts('task_abc');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/tasks/task_abc/receipts');
      expect(result.receipts).toHaveLength(2);
      expect(result.receipts[0].receipt_id).toBe('rcpt_2');
    });
  });

  // ── cancelTask ──

  describe('cancelTask()', () => {
    it('sends POST to /v1/tasks/:id/cancel with auth', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_abc', status: 'cancelled', payment_status: 'expired' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.cancelTask(kp, 'task_abc');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/tasks/task_abc/cancel');
      expect(init.method).toBe('POST');
      expect(result.ok).toBe(true);
      expect(result.payment_status).toBe('expired');
    });

    it('surfaces the 409 cancel refusal codes', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ error: 'dispute_first', message: 'Delivered work can only be cancelled after a dispute', status: 'submitted', payment_status: 'none' }, 409));

      const client = new RegistryClient('https://api.test.local');
      const err = await client.cancelTask(kp, 'task_abc').catch((e: unknown) => e);
      expect((err as ApiError).code).toBe('dispute_first');
    });
  });

  // ── disputeTask ──

  describe('disputeTask()', () => {
    it('sends POST to /v1/tasks/:id/dispute with the reason; payment_status is untouched', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_abc', status: 'submitted', review_state: 'disputed', disputed_at: '2026-01-03T00:00:00Z', payment_status: 'pending' };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.disputeTask(kp, 'task_abc', 'Work is incomplete');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/tasks/task_abc/dispute');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.reason).toBe('Work is incomplete');
      expect(result.review_state).toBe('disputed');
      expect(result.payment_status).toBe('pending');
    });

    it('requires a reason (no request made)', async () => {
      const kp = await generateKeypair();
      const client = new RegistryClient('https://api.test.local');
      await expect(client.disputeTask(kp, 'task_abc', '')).rejects.toThrow('reason');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── getTaskPayment ──

  describe('getTaskPayment()', () => {
    it('sends GET to /v1/tasks/:id/payment', async () => {
      const payload = {
        ok: true,
        payment: {
          task_id: 'task_abc', bounty: { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' },
          status: 'pending', verified: false, settled: false, tx_hash: null, settled_at: null, expires_at: null, auto_release_at: null,
          accepted_by: null, payer: null, last_error: null, settle_attempts: 0, next_settle_at: null, payment_due: false, pay_to: '0x' + 'ab'.repeat(20),
        },
        requirements: PAYMENT_REQUIRED.accepts[0],
        payment_required: { x402Version: 2, resource: PAYMENT_REQUIRED.resource, accepts: PAYMENT_REQUIRED.accepts },
        accept_endpoint: 'POST /v1/tasks/task_abc/accept',
        payment_header: 'PAYMENT-SIGNATURE',
        events: [{ id: 'pev_1', event_type: 'bounty_declared', details: { amount_atomic: '5000000' }, created_at: '2024-01-01T00:00:00Z' }],
      };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getTaskPayment('task_abc');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/tasks/task_abc/payment');
      expect(result.payment.status).toBe('pending');
      expect(result.payment.bounty?.amount_display).toBe('5.00');
      expect(result.requirements?.payTo).toBe('0x' + 'ab'.repeat(20));
      expect(result.payment_header).toBe('PAYMENT-SIGNATURE');
      expect(result.events).toHaveLength(1);
    });

    it('getPaymentRequirements() reports why there are none yet', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({
        ok: true, payment: { task_id: 'task_abc', bounty: null, status: 'none' }, requirements: null, requirements_unavailable_reason: 'no_bounty',
        accept_endpoint: 'POST /v1/tasks/task_abc/accept', payment_header: 'PAYMENT-SIGNATURE', events: [],
      }));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getPaymentRequirements('task_abc');
      expect(result.requirements).toBeNull();
      expect(result.payment_required).toBeNull();
      expect(result.unavailable_reason).toBe('no_bounty');
    });
  });

  // ── submitTask (legacy) ──

  describe('submitTask()', () => {
    it('sends POST to /v1/tasks/:id/submit with auth', async () => {
      const kp = await generateKeypair();
      const payload = { ok: true, task_id: 'task_abc', submission_id: 'sub_1', status: 'submitted', revision_count: 0 };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.submitTask(kp, 'task_abc', {
        summary: 'Done',
        submission_type: 'json',
        content: '{"result": "success"}',
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/tasks/task_abc/submit');
      expect(init.method).toBe('POST');
      expect(result.ok).toBe(true);
    });
  });
});

// ─── Money helpers and shared enums ───

describe('usdcToAtomic() / atomicToDisplay()', () => {
  it('converts human USDC decimals to atomic-unit strings', () => {
    expect(usdcToAtomic('5.00')).toBe('5000000');
    expect(usdcToAtomic('5')).toBe('5000000');
    expect(usdcToAtomic('0.5')).toBe('500000');
    expect(usdcToAtomic('0.000001')).toBe('1');
    expect(usdcToAtomic('1000')).toBe('1000000000');
  });

  it('rejects more than 6 decimals, zero, dollar signs and amounts over 1000 USDC', () => {
    expect(() => usdcToAtomic('5.1234567')).toThrow('6 decimals');
    expect(() => usdcToAtomic('0')).toThrow('greater than zero');
    expect(() => usdcToAtomic('0.00')).toThrow('greater than zero');
    expect(() => usdcToAtomic('$5.00')).toThrow();
    expect(() => usdcToAtomic('1000.000001')).toThrow('1000 USDC');
    expect(() => usdcToAtomic('')).toThrow();
  });

  it('renders atomic units with at least two decimals', () => {
    expect(atomicToDisplay('5000000')).toBe('5.00');
    expect(atomicToDisplay('5120000')).toBe('5.12');
    expect(atomicToDisplay('5123456')).toBe('5.123456');
    expect(atomicToDisplay('1')).toBe('0.000001');
    expect(atomicToDisplay('0')).toBe('0.00');
    expect(() => atomicToDisplay('5.00')).toThrow();
  });

  it('round-trips', () => {
    for (const v of ['1.00', '0.25', '999.999999']) {
      expect(atomicToDisplay(usdcToAtomic(v))).toBe(v);
    }
  });
});

describe('shared task constants', () => {
  it('TASK_STATUSES lists every API status including closed and expired', () => {
    expect(TASK_STATUSES).toEqual(['open', 'claimed', 'submitted', 'verified', 'closed', 'cancelled', 'expired']);
  });

  it('PAYMENT_HEADER is the canonical x402 header name', () => {
    expect(PAYMENT_HEADER).toBe('PAYMENT-SIGNATURE');
  });
});
