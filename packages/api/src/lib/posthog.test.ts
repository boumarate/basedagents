import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types/index.js';
import { getPostHog, captureServerEvent, captureServerException, POSTHOG_ANONYMOUS_ID } from './posthog.js';

// Recording stub for posthog-node: what the helpers hand to the client is the
// whole contract under test (event names, distinct ids, properties), plus the
// construction guard — a throwing constructor must never escape the helpers.
const { calls } = vi.hoisted(() => ({
  calls: {
    captured: [] as Array<{ distinctId: string; event: string; properties?: Record<string, unknown> }>,
    exceptions: [] as Array<{ error: unknown; distinctId?: string; properties?: Record<string, unknown> }>,
    constructed: [] as string[],
  },
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(token: string) {
      if (token === 'phc_construction_throws') throw new Error('bad client config');
      calls.constructed.push(token);
    }
    capture(msg: { distinctId: string; event: string; properties?: Record<string, unknown> }) {
      calls.captured.push(msg);
    }
    captureException(error: unknown, distinctId?: string, properties?: Record<string, unknown>) {
      calls.exceptions.push({ error, distinctId, properties });
    }
    flush(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

/** A minimal app shaped like index.ts: one authed route, one thrower, the onError capture. */
function buildApp() {
  const app = new Hono<AppEnv>();
  app.post('/authed', async (c) => {
    c.set('posthogDistinctId', 'ag_TestAgent');
    await captureServerEvent(c, 'thing_happened', { n: 1 });
    return c.json({ ok: true });
  });
  app.get('/boom/:id', () => {
    throw new Error('kaboom');
  });
  app.onError(async (err, c) => {
    await captureServerException(c, err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}

describe('lib/posthog', () => {
  beforeEach(() => {
    calls.captured.length = 0;
    calls.exceptions.length = 0;
    calls.constructed.length = 0;
  });

  it('is a no-op without a token and never throws', () => {
    expect(getPostHog(undefined)).toBeNull();
    expect(getPostHog({})).toBeNull();
    expect(getPostHog({ ENVIRONMENT: 'production' })).toBeNull();
  });

  it('creates one client per token|host and reuses it', () => {
    const env = { POSTHOG_PROJECT_TOKEN: 'phc_cache_test' };
    const a = getPostHog(env);
    const b = getPostHog(env);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(calls.constructed.filter((t) => t === 'phc_cache_test')).toHaveLength(1);
  });

  it('pins a client whose construction throws to null instead of throwing', () => {
    const env = { POSTHOG_PROJECT_TOKEN: 'phc_construction_throws' };
    expect(getPostHog(env)).toBeNull();
    // The failure is cached — no retry storm, still no throw.
    expect(getPostHog(env)).toBeNull();
  });

  it('captures an event for the identified actor and the request still succeeds', async () => {
    const app = buildApp();
    const res = await app.request('/authed', { method: 'POST' }, { POSTHOG_PROJECT_TOKEN: 'phc_events' });
    expect(res.status).toBe(200);
    expect(calls.captured).toEqual([
      { distinctId: 'ag_TestAgent', event: 'thing_happened', properties: { n: 1 } },
    ]);
  });

  it('captures nothing when unconfigured', async () => {
    const app = buildApp();
    const res = await app.request('/authed', { method: 'POST' }, {});
    expect(res.status).toBe(200);
    expect(calls.captured).toHaveLength(0);
  });

  it('a throwing client constructor never breaks the request (capture path)', async () => {
    const app = buildApp();
    const res = await app.request('/authed', { method: 'POST' }, { POSTHOG_PROJECT_TOKEN: 'phc_construction_throws' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls.captured).toHaveLength(0);
  });

  it('onError captures the exception with the anonymous fallback and the route PATTERN, not the URL', async () => {
    const app = buildApp();
    const res = await app.request('/boom/task_secret-id-123', {}, { POSTHOG_PROJECT_TOKEN: 'phc_events' });
    expect(res.status).toBe(500);
    expect(calls.exceptions).toHaveLength(1);
    const captured = calls.exceptions[0];
    expect((captured.error as Error).message).toBe('kaboom');
    expect(captured.distinctId).toBe(POSTHOG_ANONYMOUS_ID);
    expect(captured.properties).toEqual({ route: '/boom/:id', method: 'GET' });
  });

  it('a throwing client constructor never masks the error response (exception path)', async () => {
    const app = buildApp();
    const res = await app.request('/boom/x', {}, { POSTHOG_PROJECT_TOKEN: 'phc_construction_throws' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(calls.exceptions).toHaveLength(0);
  });
});
