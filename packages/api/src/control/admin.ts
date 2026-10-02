/**
 * Operator-only console routes (WS5): triage agent feedback.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 *   GET  /v1/owner/admin/feedback?status=open|fixed|wont_fix|all&limit=50&before=<next_before>
 *   POST /v1/owner/admin/feedback/:id   { status: open|fixed|wont_fix, note? }
 *
 * Behind the owner session, then ADMIN_OWNER_IDS (comma-separated ow_… ids).
 * Anyone else gets 404, so the routes don't advertise themselves.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ownerSession } from './routes.js';
import type { FeedbackRow } from '../feedback/service.js';
import { isAdminOwner } from './admin-ids.js';

export { isAdminOwner };

const admin = new Hono<AppEnv>();

const ownerIdOf = (c: Context<AppEnv>) => (c.get as (k: string) => string | undefined)('ownerId');

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdminOwner(c.env, ownerIdOf(c))) return c.json({ error: 'not_found', message: 'Not found' }, 404);
  await next();
};

const STATUSES = ['open', 'fixed', 'wont_fix'] as const;

function shape(r: FeedbackRow) {
  const list = (s: string | null) => { try { return s ? JSON.parse(s) as string[] : []; } catch { return []; } };
  return { ...r, error_codes: list(r.error_codes), request_ids: list(r.request_ids) };
}

admin.get('/admin/feedback', ownerSession, requireAdmin, async (c) => {
  const db = c.get('db');
  const status = c.req.query('status') ?? 'open';
  if (status !== 'all' && !(STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: 'bad_request', message: `status must be one of ${[...STATUSES, 'all'].join(', ')}` }, 400);
  }
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);
  // Cursor `<created_at>|<feedback_id>`: ordering by both keeps reports that
  // share a timestamp reachable across a page boundary.
  const before = c.req.query('before');
  const where: string[] = [];
  const params: unknown[] = [];
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (before) {
    const [at, id] = before.split('|');
    if (!at || !id) return c.json({ error: 'bad_request', message: 'before must be the next_before value of a previous page' }, 400);
    where.push('(created_at < ? OR (created_at = ? AND feedback_id < ?))');
    params.push(at, at, id);
  }
  const rows = await db.all<FeedbackRow>(
    `SELECT * FROM feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, feedback_id DESC LIMIT ?`, ...params, limit,
  );
  const counts = await db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status');
  return c.json({
    feedback: rows.map(shape),
    counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((x) => x.status === s)?.n ?? 0])),
    next_before: rows.length === limit ? `${rows[rows.length - 1].created_at}|${rows[rows.length - 1].feedback_id}` : null,
  });
});

const UpdateSchema = z.object({ status: z.enum(STATUSES), note: z.string().max(2000).optional() }).strict();

admin.post('/admin/feedback/:id', ownerSession, requireAdmin, async (c) => {
  const db = c.get('db');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  const id = c.req.param('id');
  const nowIso = new Date().toISOString();
  const res = await db.run(
    'UPDATE feedback SET status = ?, status_note = COALESCE(?, status_note), updated_at = ? WHERE feedback_id = ?',
    parsed.data.status, parsed.data.note ?? null, nowIso, id,
  );
  if (res.changes === 0) return c.json({ error: 'not_found', message: 'Feedback not found' }, 404);
  const row = await db.get<FeedbackRow>('SELECT * FROM feedback WHERE feedback_id = ?', id);
  return c.json({ feedback: shape(row!) });
});

export default admin;
