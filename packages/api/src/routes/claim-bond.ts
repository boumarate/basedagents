/**
 * Claim governance surface for agents (migration 0044):
 *
 *   GET  /v1/agents/me/claim-budget          the enforced budget, itemized
 *   POST /v1/agents/me/claim-bond            x402 deposit → extra budget slots
 *   POST /v1/agents/me/claim-bond/withdraw   durable payout of bonded USDC
 *
 * Mounted BEFORE the generic /v1/agents/:id routes so `me` never resolves as
 * an agent id. All three require AgentSig — the budget is the caller's own.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Bindings } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { claimBudget } from '../tasks/governance.js';
import { depositClaimBond, requestBondWithdrawal } from '../tasks/bonds.js';
import { PAYMENT_HEADER } from '../payments/accept.js';

const app = new Hono<AppEnv>();

app.get('/me/claim-budget', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const budget = await claimBudget(c.get('db'), c.env, agentId);
  return c.json({
    agent_id: agentId,
    ...budget,
    note: 'budget bounds concurrently CLAIMED tasks; human-accepted deliveries raise it, expired claims and disputes lower it, auto-accepted deliveries do not count.',
  });
});

const BondBody = z.object({ slots: z.number().int().min(1).max(1000) }).strict();

app.post('/me/claim-bond', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  let body: unknown = {};
  try {
    const text = await c.req.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = BondBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'slots (1..1000) is required' }, 400);
  const outcome = await depositClaimBond(
    c.get('db'), c.env as Bindings, agentId, parsed.data.slots, c.req.header(PAYMENT_HEADER) ?? null,
  );
  for (const [k, v] of Object.entries(outcome.headers ?? {})) c.header(k, v);
  return c.json(outcome.body, outcome.status as 200);
});

const WithdrawBody = z.object({ amount_atomic: z.string().regex(/^[1-9][0-9]{0,14}$/) }).strict();

app.post('/me/claim-bond/withdraw', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON body' }, 400);
  }
  const parsed = WithdrawBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'amount_atomic (positive digit string) is required' }, 400);
  const outcome = await requestBondWithdrawal(c.get('db'), c.env as Bindings, agentId, parsed.data.amount_atomic);
  return c.json(outcome.body, outcome.status as 200);
});

export default app;
