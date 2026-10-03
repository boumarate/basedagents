/**
 * Website-to-installation bridge: POST /v1/acquisition mints the opaque setup
 * id that /mcp/setup embeds in copyable install snippets.
 *
 * The id is a random public handle whose source/campaign mapping stays
 * SERVER-side (bounded retention; cleanup deletes expired rows). It proves
 * the setup flow issued it — not that the visitor truly discovered
 * BasedAgents through the claimed channel — so capture records it as
 * method 'setup_token', evidence rather than identity. One copied snippet may
 * be launched by several installations: resolution never assumes uniqueness,
 * and an expired or unknown id degrades gracefully at ingestion (it never
 * blocks a tool or fabricates a resolved setup event).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { generatePublicId } from '../lib/ids.js';
import { requireAdmin } from '../lib/admin-auth.js';
import { ACQUISITION_ID_RE, ACQUISITION_SOURCES, LABEL_RE } from '../acquisition/constants.js';
import { recordFunnel } from '../tasks/service.js';
import { runAcquisitionReport } from '../acquisition/report.js';

/** 90 days: the documented raw-analytics retention default. */
export const ACQUISITION_ID_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const IssueSchema = z.object({
  source: z.enum(ACQUISITION_SOURCES.filter((s) => s !== 'unknown') as [string, ...string[]]),
  campaign: z.string().regex(LABEL_RE).optional(),
});

const app = new Hono<AppEnv>();

app.post('/acquisition', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = IssueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }
  const id = generatePublicId('acq');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACQUISITION_ID_TTL_MS).toISOString();
  await c.get('db').run(
    `INSERT INTO acquisition_ids (id, source, campaign, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    id, parsed.data.source, parsed.data.campaign ?? '', now.toISOString(), expiresAt,
  );
  return c.json({ acquisition_id: id, source: parsed.data.source, campaign: parsed.data.campaign ?? null, expires_at: expiresAt });
});

/**
 * The two setup-page interactions: a view of /mcp/setup and a copy of one of
 * its snippets. Written to funnel_events (via recordFunnel, like the
 * server-side task funnel) with funnel_id = the setup flow's acquisition id
 * when there is one. Anonymous and allowlisted; neither event is an
 * installation — installations are counted only when the API later observes
 * activity carrying an installation id.
 */
const SETUP_EVENTS = ['mcp_setup_viewed', 'mcp_install_copied'] as const;
const EventSchema = z.object({
  event: z.enum(SETUP_EVENTS),
  acquisition_id: z.string().regex(ACQUISITION_ID_RE).optional(),
  source: z.enum(ACQUISITION_SOURCES.filter((s) => s !== 'unknown') as [string, ...string[]]).optional(),
});

app.post('/acquisition/events', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = EventSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'Validation failed' }, 400);
  if (c.env?.ACQUISITION_ANALYTICS !== '0') {
    await recordFunnel(c.get('db'), parsed.data.event, parsed.data.acquisition_id ?? null, parsed.data.source ?? null);
  }
  return c.json({ ok: true });
});

/**
 * GET /v1/admin/acquisition — the acquisition report (ADMIN_SECRET bearer,
 * like the other ADMIN_SECRET routes). ?view=cohort|activity, ?format=json|csv
 * (+ ?table=installations|agents for cohort CSV), ?from/?to/?source/?campaign/
 * ?interface filters, ?include_internal=1 to include house/monitoring traffic
 * (excluded by default, from env lists — never a client header).
 */
app.get('/admin/acquisition', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const result = await runAcquisitionReport(c.get('db'), c.env, (n) => c.req.query(n));
  if (result.kind === 'error') return c.json({ error: 'bad_request', message: result.message }, result.status);
  if (result.kind === 'csv') {
    return c.body(result.body, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
    });
  }
  return c.json({ ok: true, ...result.body });
});

export default app;
