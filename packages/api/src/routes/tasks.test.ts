import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { drainOutbox } from '../events/service.js';
import type { TestKeypair } from '../test-helpers.js';
import { enablePaymentsForTests, resetPaymentsForTests } from '../payments/test-fixtures.js';

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

describe('Task Marketplace', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let creator: TestKeypair & { name: string };
  let claimer: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    creator = await createTestAgent(db, { status: 'active', capabilities: ['research', 'code'] });
    claimer = await createTestAgent(db, { status: 'active', capabilities: ['code', 'data'] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Helper ───

  async function createTask(agent: TestKeypair, overrides: Record<string, unknown> = {}): Promise<string> {
    const body = JSON.stringify({
      title: 'Test Task',
      description: 'Do something useful',
      category: 'code',
      required_capabilities: ['code'],
      ...overrides,
    });
    const headers = await signRequest(agent, 'POST', '/v1/tasks', body);
    const res = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    const data = await res.json() as { task_id: string };
    return data.task_id;
  }

  async function claimTask(agent: TestKeypair, taskId: string): Promise<Response> {
    const headers = await signRequest(agent, 'POST', `/v1/tasks/${taskId}/claim`);
    return app.request(`/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { ...headers },
    });
  }

  async function submitDeliverable(agent: TestKeypair, taskId: string, overrides: Record<string, unknown> = {}): Promise<Response> {
    const body = JSON.stringify({
      submission_type: 'json',
      content: '{"result": "done"}',
      summary: 'Task completed successfully',
      ...overrides,
    });
    const headers = await signRequest(agent, 'POST', `/v1/tasks/${taskId}/submit`, body);
    return app.request(`/v1/tasks/${taskId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  }

  async function deliverTask(agent: TestKeypair, taskId: string, overrides: Record<string, unknown> = {}): Promise<Response> {
    const body = JSON.stringify({
      summary: 'Delivered the work',
      submission_type: 'json',
      submission_content: '{"result": "done"}',
      ...overrides,
    });
    const headers = await signRequest(agent, 'POST', `/v1/tasks/${taskId}/deliver`, body);
    return app.request(`/v1/tasks/${taskId}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  }

  // ─── Claim-delivery timer (claim_expires_at) ───

  describe('claim-delivery timer (claim_expires_at)', () => {
    async function claimExpiresAt(taskId: string): Promise<string | null> {
      return (await db.get<{ claim_expires_at: string | null }>('SELECT claim_expires_at FROM tasks WHERE task_id = ?', taskId))!.claim_expires_at;
    }

    it('arms on claim, clears on deliver, re-arms on a revision request; exposed on public reads', async () => {
      const taskId = await createTask(creator);
      expect(await claimExpiresAt(taskId)).toBeNull();               // open: no timer

      await claimTask(claimer, taskId);
      expect(await claimExpiresAt(taskId)).not.toBeNull();           // claimed: armed
      const publicView = await (await app.request(`/v1/tasks/${taskId}`)).json() as { task: { claim_expires_at: string | null } };
      expect(publicView.task.claim_expires_at).not.toBeNull();       // exposed for the UI

      await deliverTask(claimer, taskId);
      expect(await claimExpiresAt(taskId)).toBeNull();               // submitted: cleared

      const body = JSON.stringify({ note: 'more please' });
      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/revision`, body);
      await app.request(`/v1/tasks/${taskId}/revision`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
      expect(await claimExpiresAt(taskId)).not.toBeNull();           // claimed again: re-armed
    });
  });

  // ─── POST /v1/tasks — Create task ───

  describe('POST /v1/tasks — Create task', () => {
    it('creates a task successfully', async () => {
      const body = JSON.stringify({
        title: 'Research AI Safety',
        description: 'Write a report on AI safety best practices',
        category: 'research',
        required_capabilities: ['research'],
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.task_id).toBeDefined();
      expect((data.task_id as string).startsWith('task_')).toBe(true);
      expect(data.status).toBe('open');
    });

    it('creates a task with minimal fields', async () => {
      const body = JSON.stringify({
        title: 'Simple Task',
        description: 'Do this thing',
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(200);
    });

    it('unauthenticated create → 401', async () => {
      const body = JSON.stringify({ title: 'Test', description: 'Test' });
      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('invalid body → 400', async () => {
      const body = JSON.stringify({ title: '' });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      expect(res.status).toBe(400);
    });

    it('notifies matching agents via webhook on create', async () => {
      await createTestAgent(db, {
        status: 'active',
        capabilities: ['research'],
        webhookUrl: 'https://webhook.example.com/tasks',
      });

      const body = JSON.stringify({
        title: 'Research Task',
        description: 'Need research help',
        required_capabilities: ['research'],
      });
      const headers = await signRequest(creator, 'POST', '/v1/tasks', body);

      await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      await drainOutbox(db, new Date().toISOString());
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: string[]) => url === 'https://webhook.example.com/tasks'
      );
      expect(webhookCalls.length).toBe(1);
      const webhookBody = JSON.parse(webhookCalls[0][1].body);
      expect(webhookBody.type).toBe('task.available');
      expect(webhookBody.task.title).toBe('Research Task');
    });

    it('pending agent cannot create tasks → 403', async () => {
      const pendingAgent = await createTestAgent(db, { status: 'pending' });
      const body = JSON.stringify({ title: 'Test', description: 'Test' });
      const headers = await signRequest(pendingAgent, 'POST', '/v1/tasks', body);

      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── GET /v1/tasks — Browse tasks ───

  describe('GET /v1/tasks — Browse tasks', () => {
    it('lists open tasks by default (no auth needed)', async () => {
      await createTask(creator);
      await createTask(creator, { title: 'Second Task' });

      const res = await app.request('/v1/tasks');
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; tasks: unknown[] };
      expect(data.ok).toBe(true);
      expect(data.tasks.length).toBe(2);
    });

    it('filters by status', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      // Default (no filter) returns all non-cancelled tasks — includes claimed
      const res = await app.request('/v1/tasks');
      const data = await res.json() as { tasks: unknown[] };
      expect(data.tasks.length).toBe(1);

      // Explicit status=open should exclude claimed
      const resOpen = await app.request('/v1/tasks?status=open');
      const dataOpen = await resOpen.json() as { tasks: unknown[] };
      expect(dataOpen.tasks.length).toBe(0);

      // Explicit status=claimed
      const res2 = await app.request('/v1/tasks?status=claimed');
      const data2 = await res2.json() as { tasks: unknown[] };
      expect(data2.tasks.length).toBe(1);
    });

    it('filters by category', async () => {
      await createTask(creator, { category: 'research' });
      await createTask(creator, { category: 'code' });

      const res = await app.request('/v1/tasks?category=research');
      const data = await res.json() as { tasks: Record<string, unknown>[] };
      expect(data.tasks.length).toBe(1);
      expect(data.tasks[0].category).toBe('research');
    });

    it('filters by capability', async () => {
      await createTask(creator, { required_capabilities: ['research'] });
      await createTask(creator, { required_capabilities: ['code'] });

      const res = await app.request('/v1/tasks?capability=research');
      const data = await res.json() as { tasks: Record<string, unknown>[] };
      expect(data.tasks.length).toBe(1);
    });

    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await createTask(creator, { title: `Task ${i}` });
      }

      const res = await app.request('/v1/tasks?limit=2&offset=1');
      const data = await res.json() as { tasks: unknown[] };
      expect(data.tasks.length).toBe(2);
    });

    it('no-filter hides cancelled tasks; status=cancelled returns only cancelled', async () => {
      // Create two tasks
      const openTaskId = await createTask(creator, { title: 'Open Task' });
      const cancelledTaskId = await createTask(creator, { title: 'Cancelled Task' });

      // Cancel the second task
      const cancelHeaders = await signRequest(creator, 'POST', `/v1/tasks/${cancelledTaskId}/cancel`);
      await app.request(`/v1/tasks/${cancelledTaskId}/cancel`, {
        method: 'POST',
        headers: { ...cancelHeaders },
      });

      // Default (no filter) should NOT show cancelled tasks
      const defaultRes = await app.request('/v1/tasks');
      const defaultData = await defaultRes.json() as { tasks: Array<{ task_id: string; status: string }> };
      expect(defaultData.tasks.some(t => t.task_id === cancelledTaskId)).toBe(false);
      expect(defaultData.tasks.some(t => t.task_id === openTaskId)).toBe(true);
      expect(defaultData.tasks.every(t => t.status !== 'cancelled')).toBe(true);

      // Explicit status=cancelled should show only cancelled
      const cancelledRes = await app.request('/v1/tasks?status=cancelled');
      const cancelledData = await cancelledRes.json() as { tasks: Array<{ task_id: string; status: string }> };
      expect(cancelledData.tasks.some(t => t.task_id === cancelledTaskId)).toBe(true);
      expect(cancelledData.tasks.some(t => t.task_id === openTaskId)).toBe(false);
      expect(cancelledData.tasks.every(t => t.status === 'cancelled')).toBe(true);
    });

    it('no-filter includes non-cancelled statuses (open, claimed, submitted, verified)', async () => {
      const openTaskId = await createTask(creator, { title: 'Open Task' });
      const claimedTaskId = await createTask(creator, { title: 'Claimed Task' });
      await claimTask(claimer, claimedTaskId);

      const res = await app.request('/v1/tasks');
      const data = await res.json() as { tasks: Array<{ task_id: string; status: string }> };
      expect(data.tasks.some(t => t.task_id === openTaskId)).toBe(true);
      expect(data.tasks.some(t => t.task_id === claimedTaskId)).toBe(true);
    });
  });

  // ─── GET /v1/tasks/:id — Get task detail ───

  describe('GET /v1/tasks/:id — Get task detail', () => {
    it('returns full task details (no auth needed)', async () => {
      const taskId = await createTask(creator);

      const res = await app.request(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; task: Record<string, unknown>; submission: unknown };
      expect(data.ok).toBe(true);
      expect(data.task.task_id).toBe(taskId);
      expect(data.task.title).toBe('Test Task');
      expect(data.submission).toBeNull();
    });

    it('exposes only that a submission exists — the payload stays private', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const res = await app.request(`/v1/tasks/${taskId}`);
      const data = await res.json() as { task: Record<string, unknown>; submission: unknown; has_submission: boolean };
      expect(data.task.status).toBe('submitted');
      expect(data.submission).toBeNull();
      expect(data.has_submission).toBe(true);
    });

    it('nonexistent task → 404', async () => {
      const res = await app.request('/v1/tasks/task_nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ─── Publish opt-in — the poster may make a delivery a public sample ───

  describe('POST /v1/tasks/:id/submission/publish — opt-in public delivery', () => {
    async function publish(agent: TestKeypair, taskId: string, verb: 'publish' | 'unpublish'): Promise<Response> {
      const path = `/v1/tasks/${taskId}/submission/${verb}`;
      const headers = await signRequest(agent, 'POST', path);
      return app.request(path, { method: 'POST', headers: { ...headers } });
    }

    it('publishing exposes the content publicly; unpublishing hides it again', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId, { content: '{"answer": 42}', summary: 'the answer' });

      // Private by default.
      let data = await (await app.request(`/v1/tasks/${taskId}`)).json() as { submission: Record<string, unknown> | null; submission_public: boolean; has_submission: boolean };
      expect(data.submission).toBeNull();
      expect(data.submission_public).toBe(false);
      expect(data.has_submission).toBe(true);

      // The poster publishes.
      const pub = await publish(creator, taskId, 'publish');
      expect(pub.status).toBe(200);
      expect((await pub.json() as { submission_public: boolean }).submission_public).toBe(true);

      data = await (await app.request(`/v1/tasks/${taskId}`)).json() as typeof data;
      expect(data.submission_public).toBe(true);
      expect(data.submission?.content).toBe('{"answer": 42}');
      expect(data.submission?.summary).toBe('the answer');

      // And reverts it.
      const unpub = await publish(creator, taskId, 'unpublish');
      expect(unpub.status).toBe(200);
      data = await (await app.request(`/v1/tasks/${taskId}`)).json() as typeof data;
      expect(data.submission).toBeNull();
      expect(data.submission_public).toBe(false);
    });

    it('only the poster may publish — the deliverer gets 403', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const res = await publish(claimer, taskId, 'publish');
      expect(res.status).toBe(403);
      const data = await (await app.request(`/v1/tasks/${taskId}`)).json() as { submission_public: boolean };
      expect(data.submission_public).toBe(false);
    });

    it('publishing before any delivery → 404', async () => {
      const taskId = await createTask(creator);
      const res = await publish(creator, taskId, 'publish');
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /v1/tasks/:id/claim — Claim task ───

  describe('POST /v1/tasks/:id/claim — Claim task', () => {
    it('claims an open task successfully', async () => {
      const taskId = await createTask(creator);

      const res = await claimTask(claimer, taskId);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.task_id).toBe(taskId);
      expect(data.status).toBe('claimed');

      // Verify DB state
      const task = await db.get<{ status: string; claimed_by_agent_id: string }>(
        'SELECT status, claimed_by_agent_id FROM tasks WHERE task_id = ?', taskId
      );
      expect(task!.status).toBe('claimed');
      expect(task!.claimed_by_agent_id).toBe(claimer.agentId);
    });

    it('cannot claim your own task → 400', async () => {
      const taskId = await createTask(creator);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/claim`);
      const res = await app.request(`/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(400);
    });

    it('claim already-claimed task → 409', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const thirdAgent = await createTestAgent(db, { status: 'active' });
      const headers = await signRequest(thirdAgent, 'POST', `/v1/tasks/${taskId}/claim`);
      const res = await app.request(`/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(409);
    });

    it('claim nonexistent task → 404', async () => {
      const headers = await signRequest(claimer, 'POST', '/v1/tasks/task_nonexistent/claim');
      const res = await app.request('/v1/tasks/task_nonexistent/claim', {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(404);
    });

    it('unauthenticated claim → 401', async () => {
      const taskId = await createTask(creator);
      const res = await app.request(`/v1/tasks/${taskId}/claim`, { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('notifies creator via webhook on claim', async () => {
      const webhookCreator = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://creator-webhook.example.com/events',
      });
      const taskId = await createTask(webhookCreator);
      await claimTask(claimer, taskId);

      await drainOutbox(db, new Date().toISOString());
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: string[]) => url === 'https://creator-webhook.example.com/events'
      );
      expect(webhookCalls.length).toBeGreaterThan(0);
      const lastCall = webhookCalls[webhookCalls.length - 1];
      const webhookBody = JSON.parse(lastCall[1].body);
      expect(webhookBody.type).toBe('task.claimed');
      expect(webhookBody.claimed_by.agent_id).toBe(claimer.agentId);
    });
  });

  // ─── POST /v1/tasks/:id/submit — Submit deliverable ───

  describe('POST /v1/tasks/:id/submit — Submit deliverable', () => {
    it('submits deliverable successfully', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const res = await submitDeliverable(claimer, taskId);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.submission_id).toBeDefined();
      expect((data.submission_id as string).startsWith('sub_')).toBe(true);
      expect(data.status).toBe('submitted');
    });

    it('only claimer can submit → 403', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const thirdAgent = await createTestAgent(db, { status: 'active' });
      const res = await submitDeliverable(thirdAgent, taskId);
      expect(res.status).toBe(403);
    });

    it('cannot submit for unclaimed task → 403', async () => {
      const taskId = await createTask(creator);
      const res = await submitDeliverable(claimer, taskId);
      expect(res.status).toBe(403);
    });

    it('cannot submit for already submitted task → rejected', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const res = await submitDeliverable(claimer, taskId);
      // 401 (replay protection) or 400 (wrong state) — both are valid rejections
      expect([409, 401]).toContain(res.status);
    });

    it('invalid body → 400', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const body = JSON.stringify({ submission_type: 'invalid' });
      const headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/submit`, body);
      const res = await app.request(`/v1/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('notifies creator via webhook on submit', async () => {
      const webhookCreator = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://creator-webhook.example.com/events',
      });
      const taskId = await createTask(webhookCreator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      await drainOutbox(db, new Date().toISOString());
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: string[]) => url === 'https://creator-webhook.example.com/events'
      );
      const submitCalls = webhookCalls.filter(([, opts]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.submitted';
      });
      expect(submitCalls.length).toBe(1);
      const webhookBody = JSON.parse(submitCalls[0][1].body);
      expect(webhookBody.summary).toBe('Task completed successfully');
    });
  });

  // ─── POST /v1/tasks/:id/verify — Verify deliverable ───

  describe('POST /v1/tasks/:id/verify — Verify deliverable', () => {
    it('verifies deliverable successfully', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.status).toBe('verified');

      // Verify DB state
      const task = await db.get<{ status: string; verified_at: string }>(
        'SELECT status, verified_at FROM tasks WHERE task_id = ?', taskId
      );
      expect(task!.status).toBe('verified');
      expect(task!.verified_at).toBeDefined();
    });

    it('only creator can verify → 403', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(403);
    });

    it('cannot verify non-submitted task → 409 invalid_state', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(409);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe('invalid_state');
      expect(res.headers.get('Deprecation')).toBe('true');
    });

    it('POST /accept is the canonical route and is idempotent', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      let headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/accept`);
      const first = await app.request(`/v1/tasks/${taskId}/accept`, { method: 'POST', headers: { ...headers } });
      expect(first.status).toBe(200);
      expect(first.headers.get('Deprecation')).toBeNull();
      const firstData = await first.json() as Record<string, unknown>;
      expect(firstData.accepted_by).toBe('creator');
      expect(firstData.payment_status).toBe('none');
      expect(firstData.chain_sequence).toBeTypeOf('number');

      headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/accept`);
      const second = await app.request(`/v1/tasks/${taskId}/accept`, { method: 'POST', headers: { ...headers } });
      expect(second.status).toBe(200);
      const secondData = await second.json() as Record<string, unknown>;
      expect(secondData.status).toBe('verified');
      // No second chain entry for an idempotent re-accept
      const entries = await db.all<{ entry_type: string }>(`SELECT entry_type FROM chain WHERE entry_type = 'task_verified'`);
      expect(entries.length).toBe(1);
    });

    it('notifies claimer via webhook on verify', async () => {
      const webhookClaimer = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://claimer-webhook.example.com/events',
      });
      const taskId = await createTask(creator);
      await claimTask(webhookClaimer, taskId);
      await submitDeliverable(webhookClaimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });

      await drainOutbox(db, new Date().toISOString());
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: string[]) => url === 'https://claimer-webhook.example.com/events'
      );
      const verifyCalls = webhookCalls.filter(([, opts]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.verified';
      });
      expect(verifyCalls.length).toBe(1);
    });
  });

  // ─── POST /v1/tasks/:id/cancel — Cancel task ───

  describe('POST /v1/tasks/:id/cancel — Cancel task', () => {
    it('cancels an open task', async () => {
      const taskId = await createTask(creator);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.status).toBe('cancelled');
    });

    it('cancels a claimed task', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
    });

    it('only creator can cancel → 403', async () => {
      const taskId = await createTask(creator);

      const headers = await signRequest(claimer, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(403);
    });

    it('cannot cancel delivered work without a dispute → 409 dispute_first', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      let headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('dispute_first');

      // Dispute (reason required), then cancel is allowed
      const disputeBody = JSON.stringify({ reason: 'Not what was asked' });
      headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/dispute`, disputeBody);
      const disputeRes = await app.request(`/v1/tasks/${taskId}/dispute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: disputeBody,
      });
      expect(disputeRes.status).toBe(200);
      expect((await disputeRes.json() as Record<string, unknown>).review_state).toBe('disputed');

      headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const cancelRes = await app.request(`/v1/tasks/${taskId}/cancel`, { method: 'POST', headers: { ...headers } });
      expect(cancelRes.status).toBe(200);
      const row = await db.get<{ status: string; cancelled_at: string | null }>('SELECT status, cancelled_at FROM tasks WHERE task_id = ?', taskId);
      expect(row!.status).toBe('cancelled');
      expect(row!.cancelled_at).not.toBeNull();
    });

    it('notifies claimer via webhook on cancel', async () => {
      const webhookClaimer = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://claimer-webhook.example.com/events',
      });
      const taskId = await createTask(creator);
      await claimTask(webhookClaimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });

      await drainOutbox(db, new Date().toISOString());
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: string[]) => url === 'https://claimer-webhook.example.com/events'
      );
      const cancelCalls = webhookCalls.filter(([, opts]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.cancelled';
      });
      expect(cancelCalls.length).toBe(1);
    });
  });

  // ─── Invalid state transitions ───

  describe('Invalid state transitions', () => {
    it('cannot claim a cancelled task → 409', async () => {
      const taskId = await createTask(creator);
      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });

      const res = await claimTask(claimer, taskId);
      expect(res.status).toBe(409);
    });

    it('cannot verify an open task → 409', async () => {
      const taskId = await createTask(creator);
      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(409);
    });

    it('cannot cancel an accepted task → 409 already_accepted', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      let headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });

      headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const res = await app.request(`/v1/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('already_accepted');
    });
  });

  // ─── Full lifecycle ───

  describe('Full lifecycle: open → claimed → submitted → verified', () => {
    it('completes the full task lifecycle', async () => {
      // 1. Create
      const taskId = await createTask(creator);

      // 2. Browse and find it
      const browseRes = await app.request('/v1/tasks');
      const browseData = await browseRes.json() as { tasks: Record<string, unknown>[] };
      expect(browseData.tasks.some(t => t.task_id === taskId)).toBe(true);

      // 3. Claim
      const claimRes = await claimTask(claimer, taskId);
      expect(claimRes.status).toBe(200);

      // 4. Submit
      const submitRes = await submitDeliverable(claimer, taskId);
      expect(submitRes.status).toBe(200);

      // 5. Verify
      const verifyHeaders = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const verifyRes = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...verifyHeaders },
      });
      expect(verifyRes.status).toBe(200);

      // 6. Check final state
      const detailRes = await app.request(`/v1/tasks/${taskId}`);
      const detailData = await detailRes.json() as { task: Record<string, unknown>; submission: unknown; has_submission: boolean };
      expect(detailData.task.status).toBe('verified');
      // Public read: the payload is private, only its existence is exposed.
      expect(detailData.submission).toBeNull();
      expect(detailData.has_submission).toBe(true);
    });
  });

  // ─── Delivery Protocol ───

  describe('POST /v1/tasks/:id/deliver — Deliver with receipt', () => {
    it('delivers with receipt and creates chain entry', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const res = await deliverTask(claimer, taskId);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.receipt_id).toBeDefined();
      expect((data.receipt_id as string).startsWith('rcpt_')).toBe(true);
      expect(data.status).toBe('submitted');
      expect(data.chain_sequence).toBeDefined();
      expect(data.chain_entry_hash).toBeDefined();
    });

    it('delivery receipt includes chain_sequence and chain_entry_hash', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const res = await deliverTask(claimer, taskId);
      const data = await res.json() as Record<string, unknown>;
      expect(typeof data.chain_sequence).toBe('number');
      expect(typeof data.chain_entry_hash).toBe('string');
      expect((data.chain_entry_hash as string).length).toBe(64); // sha256 hex
    });

    it('delivers with artifact_urls and commit_hash', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const res = await deliverTask(claimer, taskId, {
        artifact_urls: ['https://example.com/artifact1.zip'],
        commit_hash: 'a'.repeat(40),
        pr_url: 'https://github.com/org/repo/pull/1',
        submission_type: 'pr',
      });
      expect(res.status).toBe(200);
    });

    it('rejects non-http(s) delivery links (javascript:/data:) → 400, task stays claimed', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/x']) {
        const res = await deliverTask(claimer, taskId, { artifact_urls: [bad], submission_type: 'link' });
        expect(res.status).toBe(400);
      }
      const pr = await deliverTask(claimer, taskId, { pr_url: 'javascript:alert(1)', submission_type: 'pr' });
      expect(pr.status).toBe(400);

      const row = await db.get<{ status: string }>('SELECT status FROM tasks WHERE task_id = ?', taskId);
      expect(row?.status).toBe('claimed');
    });

    it('cannot deliver if not claimed agent → 403', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      const thirdAgent = await createTestAgent(db, { status: 'active' });
      const res = await deliverTask(thirdAgent, taskId);
      expect(res.status).toBe(403);
    });

    it('cannot deliver if wrong status (open) → 403', async () => {
      const taskId = await createTask(creator);
      // Not claimed, so claimer is not assigned
      const res = await deliverTask(claimer, taskId);
      expect(res.status).toBe(403);
    });

    it('cannot deliver if already submitted → rejected', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const res = await deliverTask(claimer, taskId);
      // 401 (replay protection) or 400 (wrong state) — both are valid rejections
      expect([409, 401]).toContain(res.status);
    });

    it('notifies creator via webhook on deliver', async () => {
      const webhookCreator = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://creator-webhook.example.com/events',
      });
      const taskId = await createTask(webhookCreator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      await drainOutbox(db, new Date().toISOString());
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: string[]) => url === 'https://creator-webhook.example.com/events'
      );
      const deliverCalls = webhookCalls.filter(([, opts]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.delivered';
      });
      expect(deliverCalls.length).toBe(1);
      const webhookBody = JSON.parse(deliverCalls[0][1].body);
      expect(webhookBody.summary).toBe('Delivered the work');
      expect(webhookBody.receipt_id).toBeDefined();
    });
  });

  describe('GET /v1/tasks/:id — includes delivery_receipt', () => {
    it('includes receipt after delivery', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const res = await app.request(`/v1/tasks/${taskId}`);
      const data = await res.json() as { task: Record<string, unknown>; delivery_receipt: Record<string, unknown> | null };
      expect(data.task.status).toBe('submitted');
      expect(data.delivery_receipt).not.toBeNull();
      expect(data.delivery_receipt!.receipt_id).toBeDefined();
      expect(data.delivery_receipt!.chain_sequence).toBeDefined();
    });
  });

  describe('GET /v1/tasks/:id/receipt — Get delivery receipt (provenance only)', () => {
    it('returns provenance + agent public key, but never the private payload', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const res = await app.request(`/v1/tasks/${taskId}/receipt`);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; receipt: Record<string, unknown> };
      expect(data.ok).toBe(true);
      expect(data.receipt.receipt_id).toBeDefined();
      expect(data.receipt.task_id).toBe(taskId);
      expect(data.receipt.agent_id).toBe(claimer.agentId);
      expect(data.receipt.agent_public_key).toBeDefined();
      expect(data.receipt.chain_sequence).toBeDefined();
      expect(data.receipt.chain_entry_hash).toBeDefined();
      expect(data.receipt.signature).toBeDefined();
      expect(data.receipt.content_private).toBe(true);
      // The payload never appears on the public receipt.
      expect(data.receipt.summary).toBeUndefined();
      expect(data.receipt.submission_content).toBeUndefined();
      expect(data.receipt.artifact_urls).toBeUndefined();
    });

    it('returns 404 for task with no receipt', async () => {
      const taskId = await createTask(creator);
      const res = await app.request(`/v1/tasks/${taskId}/receipt`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/tasks/:id/submission — private payload (parties only)', () => {
    it('gives the payload to the runner and the poster, 403 to others, 401 anonymous', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId, { summary: 'private summary', submission_content: '{"secret":1}' });
      const path = `/v1/tasks/${taskId}/submission`;

      // The delivering agent can read its own submission.
      const asClaimer = await app.request(path, { headers: await signRequest(claimer, 'GET', path) });
      expect(asClaimer.status).toBe(200);
      const cd = await asClaimer.json() as { submission: { content: string } | null; receipts: Array<{ summary?: string; submission_content?: string }> };
      expect(cd.receipts[0].summary).toBe('private summary');
      expect(cd.receipts[0].submission_content).toBe('{"secret":1}');

      // The poster (creator agent) can read it too.
      const asCreator = await app.request(path, { headers: await signRequest(creator, 'GET', path) });
      expect(asCreator.status).toBe(200);

      // A third, unrelated agent cannot.
      const stranger = await createTestAgent(db, { status: 'active', capabilities: ['code'] });
      const asStranger = await app.request(path, { headers: await signRequest(stranger, 'GET', path) });
      expect(asStranger.status).toBe(403);

      // Unauthenticated is rejected by agentAuth.
      const anon = await app.request(path);
      expect(anon.status).toBe(401);
    });
  });

  describe('POST /v1/tasks/:id/verify — chain entry + reputation', () => {
    it('verify creates chain entry', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.status).toBe('verified');
      expect(data.chain_sequence).toBeDefined();
      expect(data.chain_entry_hash).toBeDefined();
      expect(typeof data.chain_sequence).toBe('number');
    });

    it('verify notifies deliverer with chain info', async () => {
      const webhookClaimer = await createTestAgent(db, {
        status: 'active',
        webhookUrl: 'https://claimer-webhook.example.com/events',
      });
      const taskId = await createTask(creator);
      await claimTask(webhookClaimer, taskId);
      await deliverTask(webhookClaimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });

      await drainOutbox(db, new Date().toISOString());
      await new Promise(r => setTimeout(r, 10));

      const webhookCalls = mockFetch.mock.calls.filter(
        ([url]: string[]) => url === 'https://claimer-webhook.example.com/events'
      );
      const verifyCalls = webhookCalls.filter(([, opts]) => {
        const b = JSON.parse(opts.body);
        return b.type === 'task.verified';
      });
      expect(verifyCalls.length).toBe(1);
      const webhookBody = JSON.parse(verifyCalls[0][1].body);
      expect(webhookBody.chain_sequence).toBeDefined();
      expect(webhookBody.chain_entry_hash).toBeDefined();
    });
  });

  // ─── Full lifecycle with delivery protocol ───

  describe('Full lifecycle with delivery protocol', () => {
    it('open → claimed → delivered → verified with chain entries', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);

      // Deliver
      const deliverRes = await deliverTask(claimer, taskId);
      expect(deliverRes.status).toBe(200);
      const deliverData = await deliverRes.json() as Record<string, unknown>;
      const deliverSeq = deliverData.chain_sequence as number;

      // Verify
      const verifyHeaders = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const verifyRes = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...verifyHeaders },
      });
      expect(verifyRes.status).toBe(200);
      const verifyData = await verifyRes.json() as Record<string, unknown>;
      const verifySeq = verifyData.chain_sequence as number;

      // Verify chain sequence increments
      expect(verifySeq).toBeGreaterThan(deliverSeq);

      // Check final state includes receipt
      const detailRes = await app.request(`/v1/tasks/${taskId}`);
      const detailData = await detailRes.json() as {
        task: Record<string, unknown>;
        submission: unknown;
        has_submission: boolean;
        delivery_receipt: Record<string, unknown>;
      };
      expect(detailData.task.status).toBe('verified');
      expect(detailData.submission).toBeNull();
      expect(detailData.has_submission).toBe(true);
      expect(detailData.delivery_receipt).not.toBeNull();
    });
  });

  // ─── Payment-related behavior on standard endpoints ───

  describe('Payment fields in standard endpoints', () => {
    it('GET /v1/tasks list strips payment_signature from responses', async () => {
      // Insert a task with payment_signature directly in DB
      const taskId = 'task_sig_strip_list';
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, bounty_amount, bounty_token, bounty_network, payment_signature, payment_status)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        taskId, creator.agentId, 'Sig Test', 'Test', now, '$5.00', 'USDC', 'eip155:8453', 'encrypted-secret-sig', 'authorized'
      );

      const res = await app.request('/v1/tasks?status=open');
      expect(res.status).toBe(200);
      const data = await res.json() as { tasks: Record<string, unknown>[] };
      const task = data.tasks.find(t => t.task_id === taskId);
      expect(task).toBeDefined();
      expect(task!.payment_signature).toBeUndefined();
      expect(task!.bounty_amount).toBe('$5.00');
      expect(task!.payment_status).toBe('authorized');
    });

    it('GET /v1/tasks/:id detail includes bounty fields but not payment_signature', async () => {
      const taskId = 'task_sig_strip_detail';
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, bounty_amount, bounty_token, bounty_network, payment_signature, payment_status)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        taskId, creator.agentId, 'Detail Test', 'Test', now, '$10.00', 'USDC', 'eip155:8453', 'encrypted-secret', 'authorized'
      );

      const res = await app.request(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { task: Record<string, unknown> };
      expect(data.task.payment_signature).toBeUndefined();
      expect(data.task.bounty_amount).toBe('$10.00');
      expect(data.task.bounty_token).toBe('USDC');
      expect(data.task.bounty_network).toBe('eip155:8453');
      expect(data.task.payment_status).toBe('authorized');
    });

    it('creating task without bounty still works (backward compat)', async () => {
      const taskId = await createTask(creator, {
        title: 'Free Task No Bounty',
        description: 'No bounty here',
      });

      const res = await app.request(`/v1/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as { task: Record<string, unknown> };
      expect(data.task.bounty_amount).toBeNull();
      expect(data.task.payment_status).toBe('none');
    });

    it('verify endpoint works normally without payment (no settlement triggered)', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await submitDeliverable(claimer, taskId);

      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/verify`);
      const res = await app.request(`/v1/tasks/${taskId}/verify`, {
        method: 'POST',
        headers: { ...headers },
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.ok).toBe(true);
      expect(data.status).toBe('verified');
      // Free tasks report payment_status 'none' and never a tx hash
      expect(data.payment_status).toBe('none');
      expect(data.payment_tx_hash).toBeUndefined();
    });
  });

  // ─── Testnet bounties are production-gated (mainnet USDC only) ───

  describe('Testnet bounties are prod-gated', () => {
    async function seedBountyTask(id: string, network: string): Promise<void> {
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at, bounty_amount, bounty_token, bounty_network, payment_status)
         VALUES (?, ?, ?, ?, 'open', ?, '100000', 'USDC', ?, 'pending')`,
        id, creator.agentId, `Task ${network}`, 'x', new Date().toISOString(), network,
      );
    }

    it('hides a testnet-bounty task from the public board in production, keeps mainnet + free', async () => {
      await seedBountyTask('task_testnet_hidden', 'eip155:84532');
      await seedBountyTask('task_mainnet_shown', 'eip155:8453');
      const freeId = await createTask(creator, { title: 'Free one', description: 'no bounty' });

      const prodApp = createTestApp(db, { ENVIRONMENT: 'production' });
      const prodList = (await (await prodApp.request('/v1/tasks?status=open')).json()) as { tasks: Array<{ task_id: string }> };
      const prodIds = prodList.tasks.map((t) => t.task_id);
      expect(prodIds).toContain('task_mainnet_shown');
      expect(prodIds).toContain(freeId);
      expect(prodIds).not.toContain('task_testnet_hidden');
      expect((await prodApp.request('/v1/tasks/task_testnet_hidden')).status).toBe(404);
      expect((await prodApp.request('/v1/tasks/task_mainnet_shown')).status).toBe(200);

      // Non-prod (staging/dev/tests): testnet task is still visible for QA.
      const devList = (await (await app.request('/v1/tasks?status=open')).json()) as { tasks: Array<{ task_id: string }> };
      expect(devList.tasks.map((t) => t.task_id)).toContain('task_testnet_hidden');
      expect((await app.request('/v1/tasks/task_testnet_hidden')).status).toBe(200);
    });

    it('rejects a testnet bounty at creation in production (declare + escrow paths); accepts mainnet', async () => {
      enablePaymentsForTests();
      try {
        const prodApp = createTestApp(db, { ENVIRONMENT: 'production' });
        const post = async (network: string, escrow: boolean) => {
          const body = JSON.stringify({ title: 'T', description: 'D', required_capabilities: ['code'], escrow, bounty: { amount: '100000', token: 'USDC', network } });
          const headers = await signRequest(creator, 'POST', '/v1/tasks', body);
          return prodApp.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
        };

        const testnetDeclare = await post('eip155:84532', false);
        expect(testnetDeclare.status).toBe(400);
        expect((await testnetDeclare.json() as { error: string }).error).toBe('bounty_network_not_allowed');

        // Rejected before any escrow deposit is taken, too.
        const testnetEscrow = await post('eip155:84532', true);
        expect(testnetEscrow.status).toBe(400);

        const mainnet = await post('eip155:8453', false);
        expect(mainnet.status).toBe(200);
        expect((await mainnet.json() as { status: string }).status).toBe('open');
      } finally {
        resetPaymentsForTests();
      }
    });

    it('refuses a bounty under the minimum (D3) on both paths, before any escrow deposit; free tasks and the floor itself pass', async () => {
      enablePaymentsForTests();
      try {
        const post = async (appUnderTest: typeof app, amount: string | null, escrow = false) => {
          const body = JSON.stringify({ title: 'T', description: 'D', required_capabilities: ['code'], escrow, ...(amount ? { bounty: { amount, token: 'USDC', network: 'eip155:8453' } } : {}) });
          const headers = await signRequest(creator, 'POST', '/v1/tasks', body);
          return appUnderTest.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
        };
        const before = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks'))!.n;

        for (const escrow of [false, true]) {
          const res = await post(app, '99999', escrow);
          expect(res.status).toBe(400); // never the escrow 402: nothing is signed for a post that would be refused
          expect(await res.json()).toMatchObject({ error: 'bounty_below_minimum', minimum_amount: '100000', minimum_usdc: '0.10' });
        }
        expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks'))!.n).toBe(before);

        expect((await post(app, '100000')).status).toBe(200); // the floor is inclusive
        expect((await post(app, null)).status).toBe(200);     // a free task has no floor

        // The floor is config: MIN_BOUNTY_ATOMIC_A2A raises it for agent posters.
        const strict = createTestApp(db, { MIN_BOUNTY_ATOMIC_A2A: '1000000' });
        const raised = await post(strict, '500000');
        expect(raised.status).toBe(400);
        expect(await raised.json()).toMatchObject({ error: 'bounty_below_minimum', minimum_amount: '1000000', minimum_usdc: '1.00' });
        expect((await post(strict, '1000000')).status).toBe(200);
      } finally {
        resetPaymentsForTests();
      }
    });
  });

  // ─── Bounty tasks: wallet required to claim (sign-at-accept model) ───

  describe('Claiming a bounty task', () => {
    async function createBountyTaskRow(): Promise<string> {
      const taskId = `task_bounty_${Math.random().toString(36).slice(2)}`;
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO tasks (task_id, creator_agent_id, title, description, status, created_at,
                            bounty_amount, bounty_token, bounty_network, payment_status)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, 'pending')`,
        taskId, creator.agentId, 'Bounty Task', 'Do work for pay', now, '5000000', 'USDC', 'eip155:8453',
      );
      return taskId;
    }

    it('rejects a claimer without a wallet → 409 wallet_required', async () => {
      const taskId = await createBountyTaskRow();
      const res = await claimTask(claimer, taskId);
      expect(res.status).toBe(409);
      const data = await res.json() as Record<string, unknown>;
      expect(data.error).toBe('wallet_required');
      const row = await db.get<{ status: string }>('SELECT status FROM tasks WHERE task_id = ?', taskId);
      expect(row!.status).toBe('open');
    });

    it('rejects a claimer whose wallet is on another network → 409 wallet_network_mismatch', async () => {
      const taskId = await createBountyTaskRow();
      await db.run(`UPDATE agents SET wallet_address = ?, wallet_network = ? WHERE id = ?`, '0x' + '1'.repeat(40), 'eip155:84532', claimer.agentId);
      const res = await claimTask(claimer, taskId);
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('wallet_network_mismatch');
    });

    it('lets a claimer with a matching wallet claim; no facilitator call is made', async () => {
      const taskId = await createBountyTaskRow();
      await db.run(`UPDATE agents SET wallet_address = ?, wallet_network = ? WHERE id = ?`, '0x' + '1'.repeat(40), 'eip155:8453', claimer.agentId);
      const res = await claimTask(claimer, taskId);
      expect(res.status).toBe(200);
      const cdpCalls = mockFetch.mock.calls.filter((call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('coinbase'));
      expect(cdpCalls.length).toBe(0);
    });

    it('allows claim when task has no bounty (no wallet check)', async () => {
      const taskId = await createTask(creator);
      const res = await claimTask(claimer, taskId);
      expect(res.status).toBe(200);
    });
  });

  // ─── Atomic transitions ───

  describe('Atomic transitions', () => {
    it('two concurrent claims → exactly one 200, one 409, one task.claimed webhook', async () => {
      const webhookCreator = await createTestAgent(db, { status: 'active', webhookUrl: 'https://creator-webhook.example.com/events' });
      const taskId = await createTask(webhookCreator);
      const other = await createTestAgent(db, { status: 'active', capabilities: ['code'] });

      const [a, b] = await Promise.all([claimTask(claimer, taskId), claimTask(other, taskId)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      const row = await db.get<{ claimed_by_agent_id: string; status: string }>('SELECT claimed_by_agent_id, status FROM tasks WHERE task_id = ?', taskId);
      expect(row!.status).toBe('claimed');
      const winner = a.status === 200 ? claimer.agentId : other.agentId;
      expect(row!.claimed_by_agent_id).toBe(winner);

      await drainOutbox(db, new Date().toISOString());
      await new Promise(r => setTimeout(r, 10));
      const claimedCalls = mockFetch.mock.calls.filter((call: unknown[]) => {
        const [url, opts] = call as [string, { body: string }];
        return url === 'https://creator-webhook.example.com/events' && JSON.parse(opts.body).type === 'task.claimed';
      });
      expect(claimedCalls.length).toBe(1);
    });

    it('two concurrent delivers → exactly one receipt', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      const [a, b] = await Promise.all([deliverTask(claimer, taskId), deliverTask(claimer, taskId)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const receipts = await db.all<{ receipt_id: string }>('SELECT receipt_id FROM delivery_receipts WHERE task_id = ?', taskId);
      expect(receipts.length).toBe(1);
    });

    it('accept racing cancel → one wins, the other gets 409', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);
      // dispute first so cancel is permitted
      const disputeBody = JSON.stringify({ reason: 'hmm' });
      const dh = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/dispute`, disputeBody);
      await app.request(`/v1/tasks/${taskId}/dispute`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...dh }, body: disputeBody });

      const ah = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/accept`);
      const ch = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/cancel`);
      const [a, b] = await Promise.all([
        app.request(`/v1/tasks/${taskId}/accept`, { method: 'POST', headers: { ...ah } }),
        app.request(`/v1/tasks/${taskId}/cancel`, { method: 'POST', headers: { ...ch } }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const row = await db.get<{ status: string }>('SELECT status FROM tasks WHERE task_id = ?', taskId);
      expect(['verified', 'cancelled']).toContain(row!.status);
    });

    it('concurrent chain entries do not collide', async () => {
      const taskA = await createTask(creator);
      const taskB = await createTask(creator);
      const other = await createTestAgent(db, { status: 'active', capabilities: ['code'] });
      await claimTask(claimer, taskA);
      await claimTask(other, taskB);
      const [a, b] = await Promise.all([deliverTask(claimer, taskA), deliverTask(other, taskB)]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const seqs = await db.all<{ sequence: number; previous_hash: string; entry_hash: string }>(
        `SELECT sequence, previous_hash, entry_hash FROM chain WHERE entry_type = 'task_delivered' ORDER BY sequence ASC`,
      );
      expect(seqs.length).toBe(2);
      expect(seqs[1].sequence).toBe(seqs[0].sequence + 1);
      expect(seqs[1].previous_hash).toBe(seqs[0].entry_hash);
    });
  });

  // ─── Review flow: request changes ───

  describe('POST /v1/tasks/:id/revision — Request changes', () => {
    async function requestRevision(taskId: string, note = 'Please add tests'): Promise<Response> {
      const body = JSON.stringify({ note });
      const headers = await signRequest(creator, 'POST', `/v1/tasks/${taskId}/revision`, body);
      return app.request(`/v1/tasks/${taskId}/revision`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    }

    it('sends a submitted task back to claimed; a second delivery adds a second receipt', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);

      const res = await requestRevision(taskId);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.status).toBe('claimed');
      expect(data.review_state).toBe('revision_requested');
      expect(data.revision_count).toBe(1);

      const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as { task: Record<string, unknown> };
      expect(detail.task.review_state).toBe('revision_requested');
      expect(detail.task.review_note).toBe('Please add tests');

      const second = await deliverTask(claimer, taskId, { summary: 'Now with tests' });
      expect(second.status).toBe(200);
      // Public receipts: two rows, provenance only — no payload leaks.
      const receipts = await (await app.request(`/v1/tasks/${taskId}/receipts`)).json() as { receipts: Array<Record<string, unknown>> };
      expect(receipts.receipts.length).toBe(2);
      expect(receipts.receipts.every((r) => r.content_private === true && r.summary === undefined)).toBe(true);
      expect(receipts.receipts[0].receipt_id).not.toBe(receipts.receipts[1].receipt_id);
    });

    it('caps revisions at 3 → 409 max_revisions', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      for (let i = 0; i < 3; i++) {
        await deliverTask(claimer, taskId);
        expect((await requestRevision(taskId)).status).toBe(200);
      }
      await deliverTask(claimer, taskId);
      const res = await requestRevision(taskId);
      expect(res.status).toBe(409);
      expect((await res.json() as Record<string, unknown>).error).toBe('max_revisions');
    });

    it('requires a note → 400', async () => {
      const taskId = await createTask(creator);
      await claimTask(claimer, taskId);
      await deliverTask(claimer, taskId);
      const res = await requestRevision(taskId, '');
      expect(res.status).toBe(400);
    });
  });

  describe('Task outcomes move the deliverer reputation', () => {
    it('accept raises it; a dispute followed by cancel lowers it', async () => {
      const score = async () => (await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', claimer.agentId))!.reputation_score;
      await db.run('UPDATE agents SET reputation_score = 0 WHERE id = ?', claimer.agentId);

      const t1 = await createTask(creator);
      await claimTask(claimer, t1);
      await deliverTask(claimer, t1);
      const h1 = await signRequest(creator, 'POST', `/v1/tasks/${t1}/accept`);
      expect((await app.request(`/v1/tasks/${t1}/accept`, { method: 'POST', headers: { ...h1 } })).status).toBe(200);
      const afterAcceptScore = await score();
      expect(afterAcceptScore).toBeGreaterThan(0);

      const t2 = await createTask(creator);
      await claimTask(claimer, t2);
      await deliverTask(claimer, t2);
      const body = JSON.stringify({ reason: 'wrong deliverable' });
      const h2 = await signRequest(creator, 'POST', `/v1/tasks/${t2}/dispute`, body);
      expect((await app.request(`/v1/tasks/${t2}/dispute`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h2 }, body })).status).toBe(200);
      const h3 = await signRequest(creator, 'POST', `/v1/tasks/${t2}/cancel`);
      expect((await app.request(`/v1/tasks/${t2}/cancel`, { method: 'POST', headers: { ...h3 } })).status).toBe(200);
      expect(await score()).toBeLessThan(afterAcceptScore);

      const rep = await (await app.request(`/v1/agents/${claimer.agentId}/reputation`)).json() as { breakdown: { task_completion: number } };
      expect(rep.breakdown.task_completion).toBeGreaterThan(0);
    });
  });

  describe('Creator on public reads', () => {
    it('resolves the creator name, short id and cert badge on list and detail', async () => {
      const taskId = await createTask(creator);
      const list = await (await app.request('/v1/tasks?status=open')).json() as { tasks: Array<{ task_id: string; creator: Record<string, unknown> }> };
      const t = list.tasks.find((x) => x.task_id === taskId)!;
      expect(t.creator).toEqual({ kind: 'agent', id: creator.agentId, short_id: `${creator.agentId.slice(0, 12)}…`, name: creator.name, cert: 'none' });
      const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as { task: { creator: Record<string, unknown>; creator_name?: unknown } };
      expect(detail.task.creator).toEqual(t.creator);
      expect(detail.task).not.toHaveProperty('creator_name');
      expect(detail.task).not.toHaveProperty('creator_certified');
    });
  });

  describe('Claimer on public reads', () => {
    it('is null while open, then resolves the claimer name and short id once claimed', async () => {
      const taskId = await createTask(creator);
      const open = await (await app.request(`/v1/tasks/${taskId}`)).json() as { task: { claimed_by: unknown } };
      expect(open.task.claimed_by).toBeNull();

      await claimTask(claimer, taskId);

      const list = await (await app.request('/v1/tasks?status=claimed')).json() as { tasks: Array<{ task_id: string; claimed_by: Record<string, unknown> }> };
      const t = list.tasks.find((x) => x.task_id === taskId)!;
      expect(t.claimed_by).toEqual({ id: claimer.agentId, short_id: `${claimer.agentId.slice(0, 12)}…`, name: claimer.name });

      const detail = await (await app.request(`/v1/tasks/${taskId}`)).json() as { task: { claimed_by: Record<string, unknown>; claimer_name?: unknown } };
      expect(detail.task.claimed_by).toEqual(t.claimed_by);
      expect(detail.task).not.toHaveProperty('claimer_name');
    });
  });
});
