/**
 * PostHog product analytics + Error Tracking (server side).
 *
 * One shared posthog-node client per isolate, created lazily inside a request
 * (Workers forbid I/O and timers in global scope) and keyed on token|host so
 * a changed binding never reuses a stale client. Batching is immediate
 * (flushAt 1, flushInterval 0): a Worker isolate can be recycled right after
 * the response, so every event is handed to the transport at capture time and
 * the pending delivery is parked on executionCtx.waitUntil (the Node entry
 * awaits it instead, mirroring the usage-telemetry middleware in index.ts).
 *
 * Configuration comes from the Hono env — Worker bindings in production
 * (wrangler vars/secrets per environment), process.env on the Node entry:
 *   POSTHOG_PROJECT_TOKEN   the project API token (phc_…)
 *   POSTHOG_HOST            optional; defaults to https://us.i.posthog.com
 * A missing token is LOUD outside production (one error log per isolate, so
 * local dev and staging notice the dead wiring) and a silent no-op in
 * production — analytics must never take the API down.
 *
 * Identity: auth middleware stashes the stable actor id (agent ag_… or owner
 * ow_…) in the `posthogDistinctId` context var; unauthenticated requests fall
 * back to a constant anonymous id, never to a request-controlled value. No
 * person properties are sent — emails and names stay out of PostHog.
 */
import { PostHog } from 'posthog-node';
import type { Context } from 'hono';
import type { AppEnv, Bindings } from '../types/index.js';

const DEFAULT_HOST = 'https://us.i.posthog.com';

/** Distinct id for unauthenticated requests — constant on purpose (non-PII, not request-derived). */
export const POSTHOG_ANONYMOUS_ID = 'anonymous';

/** client: null = construction failed for this token|host; kept so it is not retried (and re-logged) per capture. */
let cached: { key: string; client: PostHog | null } | null = null;
let warnedUnconfigured = false;

/**
 * The shared PostHog client for this environment, or null when unconfigured
 * (loud outside production — see the file header). Never throws: a client
 * whose CONSTRUCTION fails is logged once and pinned to null, so an already
 * completed action can never turn into a 500 over analytics. Call sites flush
 * before the Worker request ends; captureServerEvent below does both.
 */
export function getPostHog(env: Bindings | undefined): PostHog | null {
  const token = env?.POSTHOG_PROJECT_TOKEN;
  if (!token) {
    if (env?.ENVIRONMENT !== 'production' && !warnedUnconfigured) {
      warnedUnconfigured = true;
      console.error(
        '[posthog] POSTHOG_PROJECT_TOKEN is not set — product analytics and error tracking are OFF. '
        + 'Set it (and optionally POSTHOG_HOST) in .env / the Worker vars for this environment.',
      );
    }
    return null;
  }
  const host = env?.POSTHOG_HOST || DEFAULT_HOST;
  const key = `${token}|${host}`;
  if (cached?.key === key) return cached.client;
  let client: PostHog | null = null;
  try {
    client = new PostHog(token, {
      host,
      // A Worker request may be the isolate's last: send at capture time
      // instead of batching, and keep the worst-case flush wait short.
      flushAt: 1,
      flushInterval: 0,
      requestTimeout: 3000,
      // Process-level exception autocapture registers process.on handlers —
      // present on the Node entry and under nodejs_compat (wrangler.toml);
      // guarded so any other runtime can still construct the client.
      enableExceptionAutocapture: typeof process !== 'undefined' && typeof process.on === 'function',
    });
  } catch (err) {
    console.error('[posthog] client construction failed — analytics are OFF for this isolate:', err);
  }
  cached = { key, client };
  return client;
}

/** The stable analytics identity established at auth time, else the anonymous fallback. */
export function postHogDistinctId(c: Context<AppEnv>): string {
  return c.get('posthogDistinctId') ?? POSTHOG_ANONYMOUS_ID;
}

/**
 * Capture one product event for this request's authenticated actor and hand
 * the delivery to the platform (waitUntil in Workers — the response is not
 * delayed; awaited on the Node entry). No-op when unconfigured; never throws.
 * Properties must stay non-sensitive lifecycle context: no titles, notes,
 * reasons, free text, or record identifiers.
 */
export async function captureServerEvent(
  c: Context<AppEnv>, event: string, properties?: Record<string, unknown>,
): Promise<void> {
  let work: Promise<void>;
  try {
    const client = getPostHog(c.env);
    if (!client) return;
    client.capture({ distinctId: postHogDistinctId(c), event, properties });
    work = client.flush().catch((err: unknown) => console.error('[posthog] flush failed:', err));
  } catch (err) {
    console.error(`[posthog] capture ${event} failed:`, err);
    return;
  }
  try { c.executionCtx.waitUntil(work); } catch { await work; }
}

/**
 * Error Tracking for app.onError: capture the exception attributed to the
 * authenticated actor (agent or owner id, else the anonymous fallback) with
 * the route PATTERN — never the concrete URL, which can embed record ids.
 * The flush is AWAITED: onError is the last code to run before the 500
 * leaves, so waitUntil alone would race process exit on the Node entry.
 * Never throws — an analytics failure must not mask the real 500.
 */
export async function captureServerException(c: Context<AppEnv>, err: unknown): Promise<void> {
  try {
    const client = getPostHog(c.env);
    if (!client) return;
    client.captureException(err, postHogDistinctId(c), {
      route: c.req.routePath,
      method: c.req.method,
    });
    await client.flush();
  } catch (captureErr) {
    console.error('[posthog] captureException failed:', captureErr);
  }
}
