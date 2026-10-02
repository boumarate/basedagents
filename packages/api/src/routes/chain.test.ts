/**
 * Chain routes: the verification contract (registry checkpoints) is served
 * beside the data it governs, and the one documented seam stays pinned —
 * the record is never rewritten, the contract is explicit instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestApp, createTestAgent } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { CHAIN_CHECKPOINTS, GENESIS_HASH, computeChainHash } from '../crypto/index.js';

describe('chain routes', () => {
  let db: SQLiteAdapter;
  let agentId: string;

  beforeEach(async () => {
    db = setupTestDb();
    agentId = (await createTestAgent(db, { status: 'active', capabilities: ['research'] })).agentId;
    await db.run('DELETE FROM chain'); // registration may have seeded entries; start clean
  });

  async function seedEntry(sequence: number, previousHash: string): Promise<string> {
    const pk = new Uint8Array(32).fill(sequence);
    const profileHash = 'p'.repeat(64);
    const timestamp = `2026-10-01T00:00:0${sequence}.000Z`;
    const entryHash = computeChainHash(previousHash, pk, '', profileHash, timestamp);
    await db.run(
      `INSERT INTO chain (sequence, entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp, entry_type)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, 'registration')`,
      sequence, entryHash, previousHash, agentId, pk, profileHash, timestamp,
    );
    return entryHash;
  }

  it('pins the documented seam exactly', () => {
    expect(CHAIN_CHECKPOINTS).toHaveLength(1);
    const cp = CHAIN_CHECKPOINTS[0];
    expect(cp.sequence).toBe(2);
    expect(cp.entry_hash).toBe('1900d053ff9cd2a0dcd0402b22fd745d866505a52b5599ed4caea2291fb1880d');
    expect(cp.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cp.reason).toContain('Agent18');
  });

  it('serves checkpoints and the verification contract on /latest and the range listing', async () => {
    const app = createTestApp(db);

    // Empty chain still states the contract.
    const empty = (await (await app.request('/v1/chain/latest')).json()) as Record<string, unknown>;
    expect(empty.entry_hash).toBe(GENESIS_HASH);
    expect(empty.checkpoints).toEqual(CHAIN_CHECKPOINTS);
    expect(String(empty.verification)).toContain('checkpoint');

    // Seed a 3-entry chain with a deliberate seam at 2 (previous_hash that
    // matches nothing), mirroring the production shape the checkpoint covers.
    const h1 = await seedEntry(1, GENESIS_HASH);
    const h2 = await seedEntry(2, 'f'.repeat(64));
    const h3 = await seedEntry(3, h2);
    expect(h1).not.toBe(h2);

    const latest = (await (await app.request('/v1/chain/latest')).json()) as Record<string, unknown>;
    expect(latest.sequence).toBe(3);
    expect(latest.previous_hash).toBe(h2);
    expect(latest.checkpoints).toEqual(CHAIN_CHECKPOINTS);

    const range = (await (await app.request('/v1/chain?from=1&to=3')).json()) as { entries: Array<{ sequence: number }>; checkpoints: unknown; verification: string };
    expect(range.entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(range.checkpoints).toEqual(CHAIN_CHECKPOINTS);
    expect(range.verification).toContain('previous_hash');

    const recent = (await (await app.request('/v1/chain')).json()) as { checkpoints: unknown };
    expect(recent.checkpoints).toEqual(CHAIN_CHECKPOINTS);

    // Single-entry reads stay pure row data.
    const one = (await (await app.request('/v1/chain/3')).json()) as Record<string, unknown>;
    expect(one.entry_hash).toBe(h3);
    expect(one.checkpoints).toBeUndefined();
  });
});
