/**
 * Authority-ladder tests: the email rung (magic links), the /start browser
 * door and the /start/buyer signup — the flows a human takes into the
 * marketplace console. Passkey registration, login and the action ceremony
 * are covered in routes.test.ts; recovery in recovery.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { AppEnv } from '../types/index.js';
import { sha256, bytesToHex } from '../crypto/index.js';
import { ControlStore } from './store.js';
import type { EmailMessage } from './email.js';
import ownerRoutes from './routes.js';
import ladderRoutes from './ladder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
// The control-plane chain as prod carries it: the keyring files are applied
// and then retired by 0048, so the harness sees exactly the surviving schema.
const SQL = [
  '0023_owner_accounts.sql',
  '0024_keyring_approvals.sql',
  '0025_owner_recovery.sql',
  '0026_owner_billing.sql',
  '0027_authority_ladder.sql',
  '0032_daemon_kill_confirm.sql',
  '0048_retire_keyring.sql',
].map((f) => readFileSync(join(MIGRATIONS, f), 'utf-8'));

const te = new TextEncoder();

let rawDb: Database.Database;
let db: SQLiteAdapter;
let app: Hono<AppEnv>;
let store: ControlStore;
let sentEmails: EmailMessage[];

function buildApp(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', db);
    (c.set as (k: string, v: unknown) => void)('emailSender', {
      send: async (m: EmailMessage) => { sentEmails.push(m); },
    });
    await next();
  });
  a.route('/v1/owner', ownerRoutes);
  a.route('/v1/owner', ladderRoutes);
  return a;
}

beforeEach(() => {
  rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  // Real-shape agents table (delegations reference it).
  rawDb.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    public_key BLOB NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    protocols TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE used_signatures (
    signature_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );`);
  for (const sql of SQL) rawDb.exec(sql);
  db = new SQLiteAdapter(rawDb);
  store = new ControlStore(db);
  sentEmails = [];
  app = buildApp();
});

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie) headers.Cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function get(path: string, cookie?: string): Promise<Response> {
  return app.request(path, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} });
}

function sessionCookie(res: Response): string {
  const m = /ba_owner_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no session cookie');
  return `ba_owner_session=${m[1]}`;
}

function lastMagicToken(): string {
  const last = sentEmails[sentEmails.length - 1];
  const m = /#t=([A-Za-z0-9_-]+)/.exec(last?.text ?? '');
  if (!m) throw new Error('no magic token in last email');
  return m[1];
}

/** /start email → magic link → /start/buyer: a returning account for the login tests. */
async function buyerFlow(email: string): Promise<string> {
  sentEmails = [];
  expect((await post('/v1/owner/start/email', { email })).status).toBe(200);
  const finish = await post('/v1/owner/start/finish', { token: lastMagicToken() });
  const body = (await finish.json()) as { start_code?: string };
  const res = await post('/v1/owner/start/buyer', { start_code: body.start_code! });
  expect(res.status).toBe(200);
  return ((await res.json()) as { owner_id: string }).owner_id;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('email login (the look rung, returning users)', () => {
  it('logs in via magic link; unknown emails answer uniformly and send nothing', async () => {
    await buyerFlow('returning@example.com');
    sentEmails = [];

    expect((await post('/v1/owner/login/email', { email: 'returning@example.com' })).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    const finish = await post('/v1/owner/login/email/finish', { token: lastMagicToken() });
    expect(finish.status).toBe(200);
    const me = (await (await get('/v1/owner/me', sessionCookie(finish))).json()) as Record<string, unknown>;
    expect(me.session_method).toBe('email');

    sentEmails = [];
    expect((await post('/v1/owner/login/email', { email: 'nobody@example.com' })).status).toBe(200);
    expect(sentEmails).toHaveLength(0);
  });
});

describe('the /start browser door (Get started)', () => {
  it('returning account: magic link → look session', async () => {
    await buyerFlow('back@example.com');
    sentEmails = [];

    expect((await post('/v1/owner/start/email', { email: 'back@example.com' })).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    const finish = await post('/v1/owner/start/finish', { token: lastMagicToken() });
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ has_account: true });
    const me = (await (await get('/v1/owner/me', sessionCookie(finish))).json()) as Record<string, unknown>;
    expect(me.session_method).toBe('email');
  });

  it('first-time visitor: email is sent, finish yields no account + no session, just a start code', async () => {
    sentEmails = [];
    // Unlike /login/email, /start emails ANY address (the finish page is useful
    // either way) — but a brand-new address gets no session, just a start code
    // that carries the verified email into /start/buyer.
    expect((await post('/v1/owner/start/email', { email: 'brand-new@example.com' })).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    const finish = await post('/v1/owner/start/finish', { token: lastMagicToken() });
    expect(finish.status).toBe(200);
    const body = (await finish.json()) as Record<string, unknown>;
    expect(body.has_account).toBe(false);
    expect(body.start_code).toMatch(/^st_/);
    expect(finish.headers.get('set-cookie')).toBeNull();
  });
});

describe('the /start/buyer door (hire without an agent)', () => {
  const codeHash = (code: string) => bytesToHex(sha256(te.encode(code)));
  async function startCodeFor(email: string): Promise<string> {
    sentEmails = [];
    expect((await post('/v1/owner/start/email', { email })).status).toBe(200);
    const finish = await post('/v1/owner/start/finish', { token: lastMagicToken() });
    const body = (await finish.json()) as { start_code?: string };
    return body.start_code!;
  }

  it('creates a buyer owner from the start code and mints a session', async () => {
    const code = await startCodeFor('buyer@example.com');
    const res = await post('/v1/owner/start/buyer', { start_code: code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { owner_id: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.owner_id).toMatch(/^ow_/);
    expect(res.headers.get('set-cookie')).toMatch(/ba_owner_session=/);

    const owner = await store.getOwnerByEmail('buyer@example.com');
    expect(owner?.id).toBe(body.owner_id);
    expect(owner?.email_verified).toBe(1);
  });

  it('is idempotent: a start code for an email that already has an account signs into it', async () => {
    const email = 'existing@example.com';
    const existing = await store.createOwner({ ownerId: 'ow_existingbuyer', email });
    // Mint a start code directly (the front door returns has_account:true for a
    // known email, so a code only reaches this path via a create race).
    const code = 'st_reuse_owner';
    await store.createMagicLinkToken({ tokenHash: codeHash(code), purpose: 'start_code', email, ttlSeconds: 3600 });
    const res = await post('/v1/owner/start/buyer', { start_code: code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { owner_id: string; created: boolean };
    expect(body.owner_id).toBe(existing.id);
    expect(body.created).toBe(false);
  });

  it('rejects a bogus or reused start code → 401', async () => {
    expect((await post('/v1/owner/start/buyer', { start_code: 'st_bogus' })).status).toBe(401);
    const code = await startCodeFor('once@example.com');
    expect((await post('/v1/owner/start/buyer', { start_code: code })).status).toBe(200);
    // single-use
    expect((await post('/v1/owner/start/buyer', { start_code: code })).status).toBe(401);
  });
});
