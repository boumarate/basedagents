/**
 * Node.js entry point — local development and the Playwright E2E server.
 * Use: npx tsx src/node.ts
 *
 * Differences from the Workers deployment, all deliberate:
 *   - SQLite (better-sqlite3) instead of D1, registered via setNodeAdapter
 *     (the previous `app._nodeAdapter` injection was dead code — nothing read it);
 *   - the FULL migration chain (migrations/0001 … latest — the same files
 *     `wrangler d1 migrations apply` runs in prod) is replayed here, tracked in
 *     a _migrations table so each file runs exactly once (they contain
 *     non-idempotent ALTERs — never re-run one). Each file runs inside its own
 *     better-sqlite3 transaction, mirroring D1's implicit per-migration
 *     transaction, so a table-rebuild migration's `PRAGMA defer_foreign_keys`
 *     (0035) is effective locally too. The file list lives in
 *     db/migration-list.ts and is shared with the schema tests. Two columns no
 *     migration defines (agents.webhook_url, agents.reputation_override — prod
 *     has them by hand) are added afterwards, guarded.
 *     A dev DB created by the old gap-list runner (schema.sql + 0021 + ≥0023)
 *     is upgraded in place: 0001…0022 apply on top, and a file whose ALTER hits
 *     an already-present column is tolerated and still recorded (the rest of
 *     that file is skipped). Anything else is fatal — `rm data/registry.db`
 *     (GOTCHAS.md). E2E DBs are always fresh (`rm -rf .e2e-data`).
 *   - process.env is passed as the Hono env, so KEYRING_RP_ID /
 *     KEYRING_ORIGINS / E2E vars work exactly like Worker vars.
 *     E2E runs set: E2E=1 KEYRING_RP_ID=localhost
 *     KEYRING_ORIGINS=http://localhost:5174 KEYRING_CONSOLE_ORIGIN=http://localhost:5174
 */
import { serve } from '@hono/node-server';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import app, { setNodeAdapter } from './index.js';
import { initDatabase } from './db/index.js';
import { RUNNER_LOCAL_STATEMENTS, runnerMigrationFiles } from './db/migration-list.js';
import { SQLiteAdapter } from './db/sqlite-adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const port = parseInt(process.env['PORT'] || '3000', 10);
const dbPath = process.env['DATABASE_PATH'] || './data/registry.db';

mkdirSync(dirname(dbPath) === '.' ? './data' : dirname(dbPath), { recursive: true });

// schema.sql (≡ 0001, all IF NOT EXISTS) + WAL + foreign_keys=ON.
const sqliteDb = initDatabase(dbPath);

// Replay the migration chain exactly once per file, one transaction per file.
sqliteDb.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
const migrationsDir = join(__dirname, '..', 'migrations');
const isApplied = sqliteDb.prepare(`SELECT 1 FROM _migrations WHERE name = ?`);
const recordApplied = sqliteDb.prepare(`INSERT INTO _migrations (name) VALUES (?)`);
for (const file of runnerMigrationFiles(migrationsDir)) {
  if (isApplied.get(file)) continue;
  const sql = readFileSync(join(migrationsDir, file), 'utf-8');
  sqliteDb.transaction(() => {
    try {
      sqliteDb.exec(sql);
    } catch (e) {
      // An old gap-list dev DB already carries some column an early file adds.
      // exec stops at the failing statement; the earlier ones in the file stay
      // (a failed statement rolls back only itself). Only ADD COLUMN duplicates
      // are tolerated — everything else aborts the transaction and the boot.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('duplicate column name')) throw e;
      console.warn(`migration ${file}: ${msg} — pre-existing dev DB, recording it as applied`);
    }
    recordApplied.run(file);
  })();
  console.log(`applied migration ${file}`);
}

// Columns with no migration (see db/migration-list.ts): present on prod by hand.
for (const stmt of RUNNER_LOCAL_STATEMENTS) {
  try {
    sqliteDb.exec(stmt);
  } catch {
    // column already present
  }
}

setNodeAdapter(new SQLiteAdapter(sqliteDb));

serve({ fetch: (req) => app.fetch(req, process.env as unknown as Record<string, unknown>), port }, (info) => {
  console.log(`🔑 BasedAgents API running at http://localhost:${info.port}${process.env['E2E'] === '1' ? ' (E2E mode)' : ''}`);
});
