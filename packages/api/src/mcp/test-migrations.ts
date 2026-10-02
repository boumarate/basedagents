/**
 * Shared in-memory DB builder for the src/mcp/*.test.ts suite.
 *
 * db/schema.sql (used by the general test-helpers.ts harness) does NOT contain
 * the 0023 owner tables the OAuth FKs bind to, so — exactly like
 * control/store.test.ts — the MCP tests build a dedicated DB from the raw
 * migration SQL, with foreign_keys ON so the FK/UNIQUE constraints are actually
 * exercised.
 *
 * What's stitched together and WHY:
 *   * a minimal `agents` table  — board_posts.author_agent_id FKs to it
 *     (0033) and 0033 ALTERs a name_skeleton column onto it;
 *   * 0023 owner_accounts       — owners(id), the target of every 0034 owner FK;
 *   * 0025 owner_recovery        — owners are created via ControlStore in some
 *     tests, which touches the recovery-era columns; kept for parity with the
 *     control-plane harness (owners(0023)+0025);
 *   * 0033 board                 — board_posts, so post_to_board's in-process
 *     INSERT (handler tests) has a table to write to;
 *   * 0034 oauth_mcp             — THE six OAuth tables under test.
 *
 * Any new src/mcp test imports setupMcpTestDb() rather than re-concatenating
 * migrations, so appending a future migration touches this one file.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** The raw 0034 migration SQL — the six OAuth tables + indexes. */
export const OAUTH_MCP_MIGRATION_SQL = readFileSync(
  join(MIGRATIONS_DIR, '0034_oauth_mcp.sql'),
  'utf-8'
);

/** Minimal agents table (board_posts FK target); mirrors control/store.test.ts. */
const MINIMAL_AGENTS_SQL = `CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  public_key BLOB,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  registered_at TEXT
);`;

/** The full migration concat backing the MCP tests: owners(0023)+0025+0033+0034+0048. */
export const MCP_TEST_MIGRATION_SQL =
  MINIMAL_AGENTS_SQL +
  '\n' +
  readFileSync(join(MIGRATIONS_DIR, '0023_owner_accounts.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0025_owner_recovery.sql'), 'utf-8') +
  readFileSync(join(MIGRATIONS_DIR, '0033_board.sql'), 'utf-8') +
  OAUTH_MCP_MIGRATION_SQL +
  // 0048 acquisition tables — hosted-MCP attribution writes into them.
  readFileSync(join(MIGRATIONS_DIR, '0048_acquisition.sql'), 'utf-8');

export interface McpTestDb {
  rawDb: Database.Database;
  db: SQLiteAdapter;
}

/**
 * Fresh in-memory SQLite with the MCP schema applied and foreign_keys ON.
 * Returns both the raw handle (for direct fixture INSERTs) and the adapter
 * (for the code under test).
 */
export function setupMcpTestDb(): McpTestDb {
  const rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  rawDb.exec(MCP_TEST_MIGRATION_SQL);
  return { rawDb, db: new SQLiteAdapter(rawDb) };
}
