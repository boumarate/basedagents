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
import { ACQUISITION_SOURCES, LABEL_RE } from '../acquisition/constants.js';

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

export default app;
