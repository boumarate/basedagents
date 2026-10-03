/**
 * Client-reported MCP tool outcomes: POST /v1/telemetry/mcp.
 *
 * REPORTED activity only. A row here can never create a registration, a
 * funded task, an accepted delivery or a settled payment — conversions derive
 * from committed domain state. agent_id binds only through verified AgentSig
 * auth (optionalAuth); an unsigned batch stores ''. Ingestion is idempotent
 * (INSERT OR IGNORE on tool_call_id: one final outcome per tool invocation,
 * retried deliveries add nothing), bounded (50 events / 32 KB per batch, the
 * /v1/telemetry/mcp rate-limit entry in index.ts), and lossy by design — a
 * dropped batch is a measurable collection gap, not an error.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { optionalAuth } from '../middleware/auth.js';
import { parseAttributionHeaders } from '../acquisition/capture.js';
import { ERROR_CODE_RE, MCP_TOOL_OUTCOMES, UUID_RE } from '../acquisition/constants.js';

const MAX_BODY_BYTES = 32_768;

const EventSchema = z.object({
  tool_call_id: z.string().regex(UUID_RE),
  tool_name: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  outcome: z.enum(MCP_TOOL_OUTCOMES),
  error_code: z.union([z.string().regex(ERROR_CODE_RE), z.literal('')]).optional().default(''),
  client_time: z.string().max(40).optional().default(''),
});

const BatchSchema = z.object({
  events: z.array(EventSchema).min(1).max(50),
});

const app = new Hono<AppEnv>();

app.post('/telemetry/mcp', optionalAuth, async (c) => {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return c.json({ error: 'bad_request', message: 'telemetry batch too large' }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const db = c.get('db');
  const ctx = parseAttributionHeaders((n) => c.req.header(n));
  // Set only by verified AgentSig auth — a body or header can never claim it.
  const agentId = (c.get as (k: string) => string | undefined)('agentId') ?? '';
  const receivedAt = new Date().toISOString();

  let accepted = 0;
  for (const e of parsed.data.events) {
    const res = await db.run(
      `INSERT OR IGNORE INTO mcp_tool_outcomes
         (tool_call_id, installation_id, agent_id, tool_name, outcome, error_code, client_time, received_at, interface)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.tool_call_id, ctx.installationId ?? '', agentId, e.tool_name, e.outcome,
      e.error_code, e.client_time.slice(0, 40), receivedAt, ctx.iface,
    );
    accepted += res.changes;
  }
  return c.json({ ok: true, accepted });
});

export default app;
