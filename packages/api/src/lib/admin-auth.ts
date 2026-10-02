/**
 * Admin bearer gate shared by the ADMIN_SECRET-protected routes
 * (the funnel reader). Fail closed: a deployment without the
 * secret disables the endpoint (403) rather than leaving it open; a wrong or
 * missing token is 401. Comparison is constant-time (mcp/websec.ts).
 */
import type { Context } from 'hono';
import type { AppEnv } from '../types/index.js';
import { timingSafeEqual } from '../mcp/websec.js';

/** Returns a JSON error Response when the request is not an admin call, else null. */
export function requireAdmin(c: Context<AppEnv>): Response | null {
  const adminSecret = c.env?.ADMIN_SECRET;
  if (!adminSecret) {
    return c.json({ error: 'forbidden', message: 'Admin endpoint disabled — ADMIN_SECRET not configured' }, 403);
  }
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !timingSafeEqual(token, adminSecret)) {
    return c.json({ error: 'unauthorized', message: 'Invalid admin token' }, 401);
  }
  return null;
}
