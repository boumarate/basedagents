/**
 * Migration 0049_acquisition.sql against a POPULATED database, applied the
 * way src/node.ts does (schema.sql + the full chain before 0049, one
 * transaction per file, foreign_keys ON): existing agents, tasks and chain
 * rows are untouched, the new tables arrive empty (no history is invented —
 * pre-existing agents read as unknown), and the inlined copy in
 * test-helpers.ts matches the file's tables and columns.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationFilesBefore } from '../db/migration-list.js';
import { setupTestDb } from '../test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
const FILE_0049 = '0049_acquisition.sql';

const NEW_TABLES = [
  'mcp_installations',
  'acquisition_touches',
  'installation_agent_links',
  'agent_acquisition',
  'acquisition_ids',
  'mcp_tool_outcomes',
  'installation_usage_daily',
];

function apply(db: Database.Database, files: string[]): void {
  for (const f of files) db.transaction(() => db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')))();
}

function populatedDbBefore0049(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  apply(db, migrationFilesBefore(MIGRATIONS_DIR, '0049'));
  db.prepare(
    `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, registered_at, status)
     VALUES ('ag_veteran', ?, 'Veteran', 'pre-existing', '[]', '[]', '2026-01-01T00:00:00.000Z', 'active')`,
  ).run(Buffer.from('v'.repeat(32)));
  db.prepare(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, status, created_at, bounty_amount, payment_status)
     VALUES ('task_old', 'ag_veteran', 'agent', 'Old', 'pre-existing', 'open', '2026-01-02T00:00:00.000Z', '5000000', 'pending')`,
  ).run();
  return db;
}

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name).sort();

describe('migration 0049 on a populated database', () => {
  it('applies without touching existing agents, tasks or chain, and creates empty tables', () => {
    const db = populatedDbBefore0049();
    const before = {
      agent: db.prepare('SELECT * FROM agents WHERE id = ?').get('ag_veteran'),
      task: db.prepare('SELECT * FROM tasks WHERE task_id = ?').get('task_old'),
      chain: db.prepare('SELECT COUNT(*) AS n FROM chain').get(),
    };
    apply(db, [FILE_0049]);
    expect(db.prepare('SELECT * FROM agents WHERE id = ?').get('ag_veteran')).toEqual(before.agent);
    expect(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get('task_old')).toEqual(before.task);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chain').get()).toEqual(before.chain);
    for (const t of NEW_TABLES) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    }
    // The pre-existing agent has no acquisition row: it reads as unknown, never as new.
    expect(db.prepare('SELECT * FROM agent_acquisition WHERE agent_id = ?').get('ag_veteran')).toBeUndefined();
  });

  it('is idempotent (re-applying is a no-op, as IF NOT EXISTS promises)', () => {
    const db = populatedDbBefore0049();
    apply(db, [FILE_0049]);
    expect(() => apply(db, [FILE_0049])).not.toThrow();
  });

  it('matches the inlined copy in test-helpers.ts table for table, column for column', () => {
    const fromFile = populatedDbBefore0049();
    apply(fromFile, [FILE_0049]);
    const harness = (setupTestDb() as unknown as { db: Database.Database }).db;
    for (const t of NEW_TABLES) {
      expect(columns(harness, t), t).toEqual(columns(fromFile, t));
    }
  });
});
