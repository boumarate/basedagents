/**
 * Onboarding funnel + provider vote tiles (onboarding redesign, marketing page).
 *
 * Deliberately anonymous: no auth, no cookies, no identity. A funnel event is
 * an event name, an optional random correlation id (minted by the client for
 * one onboarding run — meaningless across runs), and an optional provider
 * slug. A vote is +1 on a fixed allowlisted slug. Everything is fire-and-
 * forget from the clients' side; abuse is rate-limited at the edge like the
 * other public endpoints and is low-stakes by construction (counters only).
 *
 *   POST /v1/funnel                    {event, funnel_id?, provider?}
 *   POST /v1/providers/:provider/vote  gray "vote for next" tile tap
 *   GET  /v1/providers/votes           tile counts for the grid
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { requireAdmin } from '../lib/admin-auth.js';

/** The funnel of the onboarding redesign, in order. */
export const FUNNEL_EVENTS = [
  'copy_command',
  'email_door', // the /start "Start in your browser" email submit
  'init_run',
  'mcp_config_written',
  'passkey_created',
  'provider_connected',
  'first_lease', // accepted for a future local opt-in; nothing ships it today
  'codex_recovery_view', // a /codex pageview ≈ one cold-sandbox npm block in the wild
  // MCP acquisition setup flow (/mcp/setup, funnel_id = acquisition_id).
  // A view is an observed page request, not necessarily a human; a copy is a
  // client-reported interaction, not an installation — installations are
  // counted only when the backend later observes activity with the id.
  'mcp_setup_viewed',
  'mcp_install_copied',
  // Tasks marketplace conversion funnel (Tasks P0). The two client-side events
  // arrive through POST /v1/funnel; the rest are written server-side from
  // tasks/service.ts with funnel_id = task_id, so every client (SDK, MCP, CLI,
  // console) is counted without instrumenting each one.
  'task_cta_click',
  'task_composer_view',
  'task_posted',
  'task_claimed',
  'task_delivered',
  'task_revision_requested',
  'task_disputed',
  'task_accepted',
  'task_cancelled',
  'task_paid',
  'task_payment_failed',
] as const;

/** The marketing grid's "vote for next" tiles. Live providers are not votable. */
export const VOTABLE_PROVIDERS = [
  'railway',
  'flyio',
  'cloudflare',
  'aws',
  'neon',
  'upstash',
  'anthropic',
  'openrouter',
] as const;

const FunnelSchema = z.object({
  event: z.enum(FUNNEL_EVENTS),
  funnel_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  provider: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});

const app = new Hono<AppEnv>();

app.post('/funnel', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = FunnelSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'validation failed' }, 400);

  await c.get('db').run(
    `INSERT INTO funnel_events (event, funnel_id, provider) VALUES (?, ?, ?)`,
    parsed.data.event,
    parsed.data.funnel_id ?? null,
    parsed.data.provider ?? null,
  );
  return c.json({ ok: true });
});

app.post('/providers/:provider/vote', async (c) => {
  const provider = c.req.param('provider');
  if (!(VOTABLE_PROVIDERS as readonly string[]).includes(provider)) {
    return c.json({ error: 'bad_request', message: 'unknown provider' }, 400);
  }
  await c.get('db').run(
    `INSERT INTO provider_votes (provider, votes) VALUES (?, 1)
     ON CONFLICT(provider) DO UPDATE SET
       votes = votes + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
    provider,
  );
  const row = await c.get('db').get<{ votes: number }>(
    `SELECT votes FROM provider_votes WHERE provider = ?`, provider,
  );
  return c.json({ provider, votes: Number(row?.votes ?? 1) });
});

app.get('/providers/votes', async (c) => {
  const rows = await c.get('db').all<{ provider: string; votes: number }>(
    `SELECT provider, votes FROM provider_votes ORDER BY votes DESC, provider ASC`,
  );
  return c.json({ votes: rows.map((r) => ({ provider: r.provider, votes: Number(r.votes) })) });
});

/**
 * GET /v1/admin/funnel?since=<iso> — read side of the server-emitted task_*
 * funnel events (Tasks P0, N10). ADMIN_SECRET bearer; default window 30 days.
 */
app.get('/admin/funnel', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const db = c.get('db');
  const sinceRaw = c.req.query('since');
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
    ? new Date(sinceRaw).toISOString()
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.all<{ event: string; count: number; distinct_funnels: number }>(
    `SELECT event, COUNT(*) AS count, COUNT(DISTINCT funnel_id) AS distinct_funnels
     FROM funnel_events WHERE event LIKE 'task_%' AND created_at >= ? GROUP BY event ORDER BY event`,
    since,
  );
  const events: Record<string, { count: number; distinct_funnels: number }> = {};
  for (const r of rows) events[r.event] = { count: r.count, distinct_funnels: r.distinct_funnels };
  return c.json({ ok: true, since, events });
});

export default app;
