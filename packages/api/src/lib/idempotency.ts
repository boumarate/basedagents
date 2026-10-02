/**
 * `Idempotency-Key` for write endpoints (agent-first plan §0.2). A client that
 * retries a POST with the same key gets the first response back instead of a
 * second write. Keys are scoped (to the signing agent, or an anonymous bucket)
 * and kept 24 h.
 *
 * The key is RESERVED before the write, with one conditional insert, so two
 * concurrent requests carrying the same key can't both write:
 *
 *   const idem = await reserveIdempotent(db, scope, key, bodyText, nowIso);
 *   'replay'      → return the stored response
 *   'conflict'    → 422: the same key was used with a different body
 *   'in_progress' → 409: the first request with this key hasn't finished
 *   'reserved'    → do the write in one db.batch with completeIdempotentStatement(…);
 *                   on failure releaseIdempotent(…)
 *   'none'        → no key sent; just do the write
 */
import type { DBAdapter } from '../db/adapter.js';
import { sha256, bytesToHex } from '../crypto/index.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;
/** status 0 marks a reservation whose request is still running. */
const IN_PROGRESS = 0;

export type IdempotencyStart =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'reserved' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

const hashBody = (body: string) => bytesToHex(sha256(new TextEncoder().encode(body)));

export async function reserveIdempotent(db: DBAdapter, scope: string, key: string | undefined, body: string, nowIso: string): Promise<IdempotencyStart> {
  if (key === undefined || key === '') return { kind: 'none' };
  if (!KEY_RE.test(key)) return { kind: 'invalid' };
  const requestHash = hashBody(body);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ins = await db.run(
      `INSERT OR IGNORE INTO idempotency_keys (scope, idem_key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, '', ?)`,
      scope, key, requestHash, IN_PROGRESS, nowIso,
    );
    if (ins.changes === 1) return { kind: 'reserved' };
    const row = await db.get<{ request_hash: string; status: number; response: string; created_at: string }>(
      'SELECT request_hash, status, response, created_at FROM idempotency_keys WHERE scope = ? AND idem_key = ?', scope, key,
    );
    if (!row) continue; // released between the insert and the read: try again
    if (Date.parse(row.created_at) < Date.parse(nowIso) - IDEMPOTENCY_TTL_MS) {
      // Expired: drop it (only if it is still that same old row) and reserve afresh.
      await db.run('DELETE FROM idempotency_keys WHERE scope = ? AND idem_key = ? AND created_at = ?', scope, key, row.created_at);
      continue;
    }
    if (row.request_hash !== requestHash) return { kind: 'conflict' };
    if (row.status === IN_PROGRESS) return { kind: 'in_progress' };
    return { kind: 'replay', status: row.status, body: JSON.parse(row.response) };
  }
  return { kind: 'in_progress' };
}

/**
 * The statement that stores the response for a reserved key. Run it in the
 * SAME db.batch as the write it guards, so the write and its stored response
 * commit together: a report can't be filed while its key stays in progress.
 * null when no key was sent.
 */
export function completeIdempotentStatement(scope: string, key: string | undefined, status: number, response: unknown): { sql: string; params: unknown[] } | null {
  if (!key || !KEY_RE.test(key)) return null;
  return {
    sql: 'UPDATE idempotency_keys SET status = ?, response = ? WHERE scope = ? AND idem_key = ? AND status = ?',
    params: [status, JSON.stringify(response), scope, key, IN_PROGRESS],
  };
}

/** Store the response for a reserved key on its own (prefer completeIdempotentStatement in a batch). */
export async function completeIdempotent(db: DBAdapter, scope: string, key: string | undefined, status: number, response: unknown): Promise<void> {
  const st = completeIdempotentStatement(scope, key, status, response);
  if (st) await db.run(st.sql, ...st.params);
}

/** Give a reservation back when the write failed, so a retry can run it. */
export async function releaseIdempotent(db: DBAdapter, scope: string, key: string | undefined): Promise<void> {
  if (!key || !KEY_RE.test(key)) return;
  await db.run('DELETE FROM idempotency_keys WHERE scope = ? AND idem_key = ? AND status = ?', scope, key, IN_PROGRESS);
}

export async function sweepIdempotencyKeys(db: DBAdapter, nowIso: string): Promise<void> {
  await db.run('DELETE FROM idempotency_keys WHERE created_at < ?', new Date(Date.parse(nowIso) - IDEMPOTENCY_TTL_MS).toISOString());
}
