/**
 * PostHog task-lifecycle analytics through the REAL agent routes, with a
 * recording stub in place of posthog-node: event names, distinct ids and
 * properties are asserted per action, refusals capture nothing, and the
 * idempotent re-accept counts exactly once. The suite runs with a token in
 * env — without one every capture is a no-op (covered by lib/posthog.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';

const { captured } = vi.hoisted(() => ({
  captured: [] as Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }>,
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture(msg: { distinctId: string; event: string; properties?: Record<string, unknown> }) {
      captured.push(msg);
    }
    captureException() { /* not exercised here — see lib/posthog.test.ts */ }
    flush(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const POSTHOG_ENV = { POSTHOG_PROJECT_TOKEN: 'phc_test_token' };

function events(name: string) {
  return captured.filter((e) => e.event === name);
}

describe('Task lifecycle analytics (PostHog)', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let creator: TestKeypair & { name: string };
  let claimer: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db, POSTHOG_ENV);
    captured.length = 0;
    // Webhook fetches (agent notifications) must never leave the test.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    creator = await createTestAgent(db, { status: 'active', capabilities: ['research', 'code'] });
    claimer = await createTestAgent(db, { status: 'active', capabilities: ['code', 'data'] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function post(agent: TestKeypair, path: string, payload?: Record<string, unknown>): Promise<Response> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = await signRequest(agent, 'POST', path, body);
    return app.request(path, {
      method: 'POST',
      headers: payload === undefined ? { ...headers } : { 'Content-Type': 'application/json', ...headers },
      ...(payload === undefined ? {} : { body }),
    });
  }

  async function createTask(overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await post(creator, '/v1/tasks', {
      title: 'Test Task',
      description: 'Do something useful',
      category: 'code',
      required_capabilities: ['code'],
      ...overrides,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { task_id: string }).task_id;
  }

  async function submittedTask(): Promise<string> {
    const taskId = await createTask();
    expect((await post(claimer, `/v1/tasks/${taskId}/claim`)).status).toBe(200);
    const submitted = await post(claimer, `/v1/tasks/${taskId}/submit`, {
      submission_type: 'json',
      content: '{"result": "done"}',
      summary: 'All done',
    });
    expect(submitted.status).toBe(200);
    return taskId;
  }

  it('captures task_created for the creator with lifecycle-only properties', async () => {
    await createTask();
    expect(events('task_created')).toEqual([{
      distinctId: creator.agentId,
      event: 'task_created',
      properties: { has_bounty: false, escrow: false, category: 'code', output_format: 'json', bounty_network: null },
    }]);
  });

  it('captures nothing when the action is refused', async () => {
    // Validation failure (no title) and a bounty while payments are disabled.
    expect((await post(creator, '/v1/tasks', { description: 'no title' })).status).toBe(400);
    const paid = await post(creator, '/v1/tasks', {
      title: 'Paid', description: 'x', bounty: { amount: '1000000' },
    });
    expect(paid.status).toBe(503);
    // Claim refusal: claiming your own task.
    const taskId = await createTask();
    captured.length = 0;
    expect((await post(creator, `/v1/tasks/${taskId}/claim`)).status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it('captures claim, delivery, and acceptance for the acting agent', async () => {
    const taskId = await submittedTask();
    expect((await post(creator, `/v1/tasks/${taskId}/accept`)).status).toBe(200);

    expect(events('task_claimed')).toEqual([{
      distinctId: claimer.agentId,
      event: 'task_claimed',
      properties: { has_bounty: false, escrow: false, category: 'code' },
    }]);
    expect(events('task_delivered')).toEqual([{
      distinctId: claimer.agentId,
      event: 'task_delivered',
      properties: { via: 'submit', submission_type: 'json', has_bounty: false, revision_round: 0 },
    }]);
    expect(events('task_accepted')).toEqual([{
      distinctId: creator.agentId,
      event: 'task_accepted',
      properties: { has_bounty: false, escrow: false, revision_count: 0 },
    }]);
  });

  it('an idempotent re-accept counts exactly one acceptance', async () => {
    const taskId = await submittedTask();
    expect((await post(creator, `/v1/tasks/${taskId}/accept`)).status).toBe(200);
    expect((await post(creator, `/v1/tasks/${taskId}/accept`)).status).toBe(200);
    expect(events('task_accepted')).toHaveLength(1);
  });

  it('captures a revision request, a dispute, and the cancellation stage', async () => {
    const taskId = await submittedTask();
    expect((await post(creator, `/v1/tasks/${taskId}/revision`, { note: 'Please add tests' })).status).toBe(200);
    // Deliver again, then dispute and cancel.
    const redelivered = await post(claimer, `/v1/tasks/${taskId}/submit`, {
      submission_type: 'json', content: '{"result": "done2"}', summary: 'Round two',
    });
    expect(redelivered.status).toBe(200);
    expect((await post(creator, `/v1/tasks/${taskId}/dispute`, { reason: 'Not what was asked' })).status).toBe(200);
    expect((await post(creator, `/v1/tasks/${taskId}/cancel`)).status).toBe(200);

    expect(events('task_revision_requested')).toEqual([{
      distinctId: creator.agentId,
      event: 'task_revision_requested',
      properties: { revision_count: 1, has_bounty: false },
    }]);
    expect(events('task_disputed')).toEqual([{
      distinctId: creator.agentId,
      event: 'task_disputed',
      properties: { has_bounty: false, escrow: false, revision_count: 1, bond_slashed: false },
    }]);
    expect(events('task_cancelled')).toEqual([{
      distinctId: creator.agentId,
      event: 'task_cancelled',
      properties: { status_before: 'submitted', has_bounty: false, escrow: false, was_disputed: true },
    }]);
  });

  it('captures publishing and unpublishing of a delivery', async () => {
    const taskId = await submittedTask();
    captured.length = 0;
    expect((await post(creator, `/v1/tasks/${taskId}/submission/publish`)).status).toBe(200);
    expect((await post(creator, `/v1/tasks/${taskId}/submission/unpublish`)).status).toBe(200);
    expect(captured).toEqual([
      { distinctId: creator.agentId, event: 'task_submission_published', properties: undefined },
      { distinctId: creator.agentId, event: 'task_submission_unpublished', properties: undefined },
    ]);
  });
});
