import { Hono } from 'hono';
import type { AppEnv, ChainEntry } from '../types/index.js';
import { GENESIS_HASH, CHAIN_CHECKPOINTS, bytesToHex } from '../crypto/index.js';

const chain = new Hono<AppEnv>();

/**
 * The public verification contract, served beside the data it governs:
 * recompute every entry_hash from its public fields, hash-link from the
 * head down to the highest checkpoint, and take the links at or below a
 * checkpoint's sequence as attested by the registry (see CHAIN_CHECKPOINTS
 * in crypto/index.ts for the documented dev-era seam).
 */
const VERIFICATION =
  'Recompute each entry_hash from its public fields — sha256 over length-prefixed (4-byte big-endian) parts [previous_hash, public_key bytes, nonce, profile_hash, timestamp]; the earliest entries use the pre-migration raw concatenation of the same parts — and check previous_hash equals the prior entry_hash from the head down to the highest checkpoint. Links whose sequence is at or below a checkpoint are attested by the registry via `checkpoints` instead of hash linkage.';

/**
 * Format a chain entry row for API response.
 */
function formatChainEntry(entry: ChainEntry & { agent_name?: string; agent_comment?: string }) {
  // public_key comes as Uint8Array (or ArrayBuffer from D1) — convert to hex
  const pkBytes = entry.public_key instanceof Uint8Array
    ? entry.public_key
    : new Uint8Array(entry.public_key as ArrayBufferLike);
  return {
    sequence: entry.sequence,
    entry_hash: entry.entry_hash,
    previous_hash: entry.previous_hash,
    agent_id: entry.agent_id,
    agent_name: entry.agent_name ?? null,
    agent_comment: entry.agent_comment ?? null,
    public_key: bytesToHex(pkBytes),
    nonce: entry.nonce,
    profile_hash: entry.profile_hash,
    timestamp: entry.timestamp,
    entry_type: (entry as ChainEntry & { entry_type?: string }).entry_type ?? 'registration',
  };
}

/**
 * GET /v1/chain/latest
 * Returns the latest chain entry hash + sequence number.
 */
chain.get('/latest', async (c) => {
  const db = c.get('db');

  const latest = await db.get<ChainEntry>(
    'SELECT * FROM chain ORDER BY sequence DESC LIMIT 1'
  );

  if (!latest) {
    return c.json({
      sequence: 0,
      entry_hash: GENESIS_HASH,
      message: 'Chain is empty — genesis state',
      checkpoints: CHAIN_CHECKPOINTS,
      verification: VERIFICATION,
    });
  }

  return c.json({ ...formatChainEntry(latest), checkpoints: CHAIN_CHECKPOINTS, verification: VERIFICATION });
});

/**
 * GET /v1/chain?from=N&to=M
 * Returns a range of chain entries. If no from/to, returns latest 20.
 */
chain.get('/', async (c) => {
  const db = c.get('db');

  const fromStr = c.req.query('from');
  const toStr = c.req.query('to');

  if (!fromStr && !toStr) {
    const entries = await db.all<ChainEntry & { agent_name?: string; agent_comment?: string }>(
      `SELECT c.*, a.name as agent_name, a.comment as agent_comment
       FROM chain c LEFT JOIN agents a ON c.agent_id = a.id
       ORDER BY c.sequence DESC LIMIT 20`
    );
    const countRow = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM chain');

    return c.json({
      entries: entries.map(formatChainEntry),
      total: countRow?.count ?? 0,
      checkpoints: CHAIN_CHECKPOINTS,
      verification: VERIFICATION,
    });
  }

  const from = fromStr ? parseInt(fromStr, 10) : 1;
  const to = toStr ? parseInt(toStr, 10) : from + 99;

  if (isNaN(from) || isNaN(to) || from < 1 || to < from) {
    return c.json({ error: 'bad_request', message: 'Invalid range — from must be >= 1 and to >= from' }, 400);
  }

  const cappedTo = Math.min(to, from + 999);

  const entries = await db.all<ChainEntry & { agent_name?: string; agent_comment?: string }>(
    `SELECT c.*, a.name as agent_name, a.comment as agent_comment
     FROM chain c LEFT JOIN agents a ON c.agent_id = a.id
     WHERE c.sequence >= ? AND c.sequence <= ? ORDER BY c.sequence ASC`,
    from, cappedTo
  );

  return c.json({
    entries: entries.map(formatChainEntry),
    from,
    to: cappedTo,
    checkpoints: CHAIN_CHECKPOINTS,
    verification: VERIFICATION,
  });
});

/**
 * GET /v1/chain/:sequence
 * Returns a specific chain entry by sequence number.
 */
chain.get('/:sequence', async (c) => {
  const seqStr = c.req.param('sequence');

  if (seqStr === 'latest') {
    return c.json({ error: 'bad_request', message: 'Use /v1/chain/latest endpoint' }, 400);
  }

  const sequence = parseInt(seqStr, 10);
  if (isNaN(sequence) || sequence < 1) {
    return c.json({ error: 'bad_request', message: 'Invalid sequence number' }, 400);
  }

  const db = c.get('db');
  const entry = await db.get<ChainEntry & { agent_name?: string; agent_comment?: string }>(
    `SELECT c.*, a.name as agent_name, a.comment as agent_comment
     FROM chain c LEFT JOIN agents a ON c.agent_id = a.id
     WHERE c.sequence = ?`,
    sequence
  );

  if (!entry) {
    return c.json({ error: 'not_found', message: `Chain entry ${sequence} not found` }, 404);
  }

  return c.json(formatChainEntry(entry));
});

export default chain;
