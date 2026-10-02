/**
 * WS5 through the real Worker app: POST /v1/feedback (anonymous + signed,
 * limits, idempotency, redaction, notification), request ids + telemetry,
 * the daily digest, and the operator's triage routes.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { setNodeAdapter } from '../index.js';
import { setupTestDb, createTestAgent, signRequest, type TestKeypair } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { ControlStore } from '../control/store.js';
import { sha256, bytesToHex } from '../crypto/index.js';
import { buildDigest, formatDigest, runDailyDigest, retryFeedbackNotifications, recordUsage, cleanVersion, MAX_VERSIONS_PER_DAY, DIGEST_MAX_ATTEMPTS, type FeedbackRow } from '../feedback/service.js';
import { reserveIdempotent, completeIdempotent } from '../lib/idempotency.js';
import { FEEDBACK_LIMITS } from './feedback.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const BASE = 'https://api.basedagents.ai';
const ADMIN = 'ow_admin1';

let db: SQLiteAdapter;
let agent: TestKeypair & { name: string };
let pending: Promise<unknown>[];
let env: Record<string, string>;
let fetchSpy: ReturnType<typeof vi.fn>;
let logSpy: MockInstance<typeof console.log>;

const ctx = () => ({ waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} });
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env as never, ctx() as never);
  await Promise.all(pending.splice(0));
  return res;
}

const report = (over: Record<string, unknown> = {}) => ({
  scope: 'general',
  environment: 'node 22, linux, behind a proxy',
  expectedBehavior: 'tasks list --min-usdc 1 returns only paid tasks',
  actualBehavior: 'it returned a free task',
  stepsToReproduce: 'npx basedagents@latest tasks list --min-usdc 1 --json',
  skillVersion: '1.0.0',
  ...over,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  call('/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers }, body: JSON.stringify(body) });

async function signedPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const text = JSON.stringify(body);
  const auth = await signRequest(agent, 'POST', '/v1/feedback', text);
  return call('/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth, ...headers }, body: text });
}

beforeEach(async () => {
  db = setupTestDb();
  for (const f of ['0023_owner_accounts.sql', '0025_owner_recovery.sql', '0027_authority_ladder.sql']) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  setNodeAdapter(db);
  agent = await createTestAgent(db, { name: 'Reporter' });
  pending = [];
  env = { ADMIN_OWNER_IDS: ADMIN, FEEDBACK_NOTIFY_EMAIL: 'ops@example.com', FEEDBACK_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/T0/B0/x' };
  fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const rowOf = (id: string) => db.get<FeedbackRow>('SELECT * FROM feedback WHERE feedback_id = ?', id);

describe('POST /v1/feedback', () => {
  it('accepts an anonymous report, stores it, and notifies email + Slack', async () => {
    const res = await post(report());
    expect(res.status).toBe(201);
    const body = await res.json() as { feedback_id: string; anonymous: boolean; status: string };
    expect(body).toMatchObject({ anonymous: true, status: 'open' });
    const row = (await rowOf(body.feedback_id))!;
    expect(row.agent_id).toBeNull();
    expect(row.skill_version).toBe('1.0.0');
    expect(row.notified_at).toBeTruthy();
    const email = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[email:log-only] to=ops@example.com'));
    expect(email).toContain('[BasedAgents feedback] general');
    const slack = fetchSpy.mock.calls.find(([u]) => String(u).startsWith('https://hooks.slack.test'));
    expect(JSON.parse(String((slack![1] as RequestInit).body)).text).toContain('it returned a free task');
  });

  it('records the signing agent', async () => {
    const res = await signedPost(report({ scope: 'task', taskId: 'task_abc', errorCodes: ['conflict'], requestIds: ['req-1'] }));
    expect(res.status).toBe(201);
    const { feedback_id, anonymous } = await res.json() as { feedback_id: string; anonymous: boolean };
    expect(anonymous).toBe(false);
    const row = (await rowOf(feedback_id))!;
    expect(row).toMatchObject({ agent_id: agent.agentId, scope: 'task', task_id: 'task_abc', error_codes: '["conflict"]', request_ids: '["req-1"]' });
  });

  it('rejects a bad signature instead of silently going anonymous', async () => {
    const res = await post(report(), { Authorization: 'AgentSig nope:nope', 'X-Timestamp': '1', 'X-Nonce': 'n' });
    expect(res.status).toBe(401);
  });

  it('validates the body: task scope needs taskId, unknown fields are refused', async () => {
    expect((await post(report({ scope: 'task' }))).status).toBe(400);
    expect((await post(report({ extra: 1 }))).status).toBe(400);
    expect((await post({ scope: 'general' })).status).toBe(400);
  });

  it('redacts secrets before storing', async () => {
    const key = 'ab'.repeat(32);
    const res = await post(report({ actualBehavior: `failed with privateKey: "${key}" and Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123` }));
    const row = (await rowOf(((await res.json()) as { feedback_id: string }).feedback_id))!;
    expect(row.actual_behavior).not.toContain(key);
    expect(row.actual_behavior).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(row.actual_behavior).toContain('[REDACTED]');
  });

  it(`limits anonymous reports to ${FEEDBACK_LIMITS.anonymousPerHour} an hour per IP, with Retry-After`, async () => {
    for (let i = 0; i < FEEDBACK_LIMITS.anonymousPerHour; i++) expect((await post(report())).status).toBe(201);
    const res = await post(report());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    // A signed report from the same IP still goes through.
    expect((await signedPost(report())).status).toBe(201);
  });

  it('Idempotency-Key: a retry returns the first response; a different body is 422', async () => {
    const first = await post(report(), { 'Idempotency-Key': 'retry-key-0001' });
    const again = await post(report(), { 'Idempotency-Key': 'retry-key-0001' });
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback'))!.n).toBe(1);
    expect((await post(report({ actualBehavior: 'different' }), { 'Idempotency-Key': 'retry-key-0001' })).status).toBe(422);
    expect((await post(report(), { 'Idempotency-Key': 'bad key!' })).status).toBe(400);
  });

  it('a replay is served even after the limit is reached, and costs nothing', async () => {
    const first = await post(report(), { 'Idempotency-Key': 'filed-once-0001' });
    for (let i = 1; i < FEEDBACK_LIMITS.anonymousPerHour; i++) await post(report({ actualBehavior: `other ${i}` }));
    expect((await post(report({ actualBehavior: 'one too many' }))).status).toBe(429);
    const replay = await post(report(), { 'Idempotency-Key': 'filed-once-0001' });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
  });

  it('concurrent requests with one key reserve it once: the second waits (409), then replays', async () => {
    const body = JSON.stringify(report());
    const now = new Date().toISOString();
    expect((await reserveIdempotent(db, 'anon:x', 'race-key-0001', body, now)).kind).toBe('reserved');
    expect((await reserveIdempotent(db, 'anon:x', 'race-key-0001', body, now)).kind).toBe('in_progress');
    await completeIdempotent(db, 'anon:x', 'race-key-0001', 201, { feedback_id: 'fb_first' });
    expect(await reserveIdempotent(db, 'anon:x', 'race-key-0001', body, now)).toEqual({ kind: 'replay', status: 201, body: { feedback_id: 'fb_first' } });
    // Over HTTP: two at once file one report.
    const [a, b] = await Promise.all([post(report(), { 'Idempotency-Key': 'race-key-0002' }), post(report(), { 'Idempotency-Key': 'race-key-0002' })]);
    expect([a.status, b.status].sort()).toEqual(a.status === b.status ? [201, 201] : [201, 409]);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback'))!.n).toBe(1);
  });

  it('a write that fails releases the key, so the retry files the report', async () => {
    const spy = vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1 hiccup'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await post(report(), { 'Idempotency-Key': 'flaky-key-0001' });
    expect(failed.status).toBe(500);
    spy.mockRestore();
    errSpy.mockRestore();
    const retry = await post(report(), { 'Idempotency-Key': 'flaky-key-0001' });
    expect(retry.status).toBe(201);
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM feedback'))!.n).toBe(1);
    const again = await post(report(), { 'Idempotency-Key': 'flaky-key-0001' });
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
  });

  it('identifier fields must be identifiers (they are relayed as-is)', async () => {
    expect((await post(report({ scope: 'task', taskId: 'task 1 my token is abc' }))).status).toBe(400);
    expect((await post(report({ errorCodes: ['conflict', 'Bearer xyz'] }))).status).toBe(400);
    expect((await post(report({ requestIds: ['a b'] }))).status).toBe(400);
  });

  it('a channel that failed is retried alone; the one that worked is not re-sent', async () => {
    fetchSpy.mockResolvedValue(new Response('down', { status: 500 })); // Slack down, email (log sender) fine
    const res = await post(report());
    const id = ((await res.json()) as { feedback_id: string }).feedback_id;
    let row = (await rowOf(id))!;
    expect(row.email_notified_at).toBeTruthy();
    expect(row.slack_notified_at).toBeNull();
    expect(row.notified_at).toBeNull();
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
    const sender = { send: vi.fn() };
    const later = new Date(Date.now() + 120_000).toISOString();
    expect(await retryFeedbackNotifications(db, env, sender, later)).toBe(1);
    expect(sender.send).not.toHaveBeenCalled();
    row = (await rowOf(id))!;
    expect(row.slack_notified_at).toBe(later);
    expect(row.notified_at).toBe(later);
  });

  it('stores silently when no notification channel is configured', async () => {
    env = { ADMIN_OWNER_IDS: ADMIN };
    const res = await post(report());
    const row = (await rowOf(((await res.json()) as { feedback_id: string }).feedback_id))!;
    expect(row.notified_at).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the cron retries a notification that failed', async () => {
    fetchSpy.mockResolvedValue(new Response('down', { status: 500 }));
    env = { FEEDBACK_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' };
    const res = await post(report());
    const id = ((await res.json()) as { feedback_id: string }).feedback_id;
    expect((await rowOf(id))!.notified_at).toBeNull();
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
    const later = new Date(Date.now() + 120_000).toISOString();
    const sender = { send: vi.fn() };
    expect(await retryFeedbackNotifications(db, env, sender, later)).toBe(1);
    expect((await rowOf(id))!.notified_at).toBe(later);
  });
});

describe('request ids + telemetry', () => {
  it('every response carries X-Request-Id; signed traffic and errors are counted per day', async () => {
    const res = await call('/v1/health', { headers: { 'X-BasedAgents-Cli-Version': '0.9.0', 'X-BasedAgents-Skill-Version': '1.1.0' } });
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    // Unsigned: version headers are anyone's to spoof, so they aren't recorded; a 200 isn't counted at all.
    await call('/v1/tasks/task_missing', { headers: { 'X-BasedAgents-Cli-Version': '6.6.6' } });
    // Signed: counted with its versions.
    const path = `/v1/agents/${agent.agentId}/events`;
    const auth = await signRequest(agent, 'GET', path, '');
    expect((await call(path, { headers: { ...auth, 'X-BasedAgents-Cli-Version': '0.9.0', 'X-BasedAgents-Skill-Version': '1.1.0' } })).status).toBe(200);
    const rows = await db.all<{ agent_id: string; cli_version: string; skill_version: string; status: number; error_code: string; count: number }>('SELECT agent_id, cli_version, skill_version, status, error_code, count FROM api_usage_daily ORDER BY status');
    expect(rows).toEqual([
      { agent_id: agent.agentId, cli_version: '0.9.0', skill_version: '1.1.0', status: 200, error_code: '', count: 1 },
      { agent_id: '', cli_version: '', skill_version: '', status: 404, error_code: 'not_found', count: 1 },
    ]);
  });
});

describe('version values are bounded', () => {
  it('stores semver-shaped values, "other" for anything else, and caps distinct values per day', async () => {
    expect(cleanVersion('0.9.0')).toBe('0.9.0');
    expect(cleanVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(cleanVersion("x'; drop table")).toBe('other');
    expect(cleanVersion('')).toBe('');
    for (let i = 0; i < MAX_VERSIONS_PER_DAY + 5; i++) {
      await recordUsage(db, { day: '2026-09-23', agentId: '', cliVersion: `0.0.${i}`, skillVersion: '', status: 200, errorCode: '' });
    }
    await recordUsage(db, { day: '2026-09-23', agentId: '', cliVersion: '0.0.1', skillVersion: '', status: 200, errorCode: '' });
    const rows = await db.all<{ cli_version: string; count: number }>(`SELECT cli_version, count FROM api_usage_daily WHERE day = '2026-09-23'`);
    expect(rows.length).toBe(MAX_VERSIONS_PER_DAY + 1);
    expect(rows.find((r) => r.cli_version === 'other')!.count).toBe(5);
    expect(rows.find((r) => r.cli_version === '0.0.1')!.count).toBe(2);
  });
});

describe('daily digest', () => {
  const DAY = '2026-09-23';
  beforeEach(async () => {
    const rec = (agentId: string, cli: string, skill: string, status: number, code = '', times = 1) =>
      Promise.all(Array.from({ length: times }, () => recordUsage(db, { day: DAY, agentId, cliVersion: cli, skillVersion: skill, status, errorCode: code })));
    await rec('ag_a', '0.8.0', '1.0.0', 200, '', 5);
    await rec('ag_b', '0.9.0', '1.1.0', 200, '', 2);
    await rec('ag_b', '0.9.0', '1.1.0', 409, 'conflict', 3);
    await rec('', '', '', 429, 'rate_limited', 4);
    await rec('ag_a', '0.8.0', '1.0.0', 200, '', 1).then(() => recordUsage(db, { day: '2026-09-22', agentId: 'ag_old', cliVersion: '0.7.0', skillVersion: '', status: 200, errorCode: '' }));
    const fb = (id: string, created: string, status = 'open') => db.run(
      `INSERT INTO feedback (feedback_id, scope, environment, expected_behavior, actual_behavior, steps_to_reproduce, status, created_at, updated_at) VALUES (?, 'general', 'e', 'x', 'y', 'z', ?, ?, ?)`, id, status, created, created);
    await fb('fb_1', `${DAY}T10:00:00.000Z`);
    await fb('fb_2', `${DAY}T23:59:00.000Z`, 'fixed');
    await fb('fb_3', '2026-09-24T00:00:01.000Z');
  });

  it('counts agents, versions, errors, 429s and feedback for the day', async () => {
    const d = await buildDigest(db, DAY);
    expect(d).toMatchObject({ day: DAY, uniqueAgents: 2, requests: 15, rateLimited: 4, feedback: { received: 2, open: 2 } });
    expect(d.byCli).toEqual([{ version: '0.8.0', requests: 6, agents: 1 }, { version: '0.9.0', requests: 5, agents: 1 }]);
    expect(d.bySkill).toEqual([{ version: '1.0.0', requests: 6, agents: 1 }, { version: '1.1.0', requests: 5, agents: 1 }]);
    expect(d.topErrors).toEqual([{ status: 429, code: 'rate_limited', count: 4 }, { status: 409, code: 'conflict', count: 3 }]);
    const { subject, text } = formatDigest(d);
    expect(subject).toBe('[BasedAgents digest] 2026-09-23: 2 agents, 2 feedback, 4 × 429');
    expect(text).toContain('0.9.0: 5 requests, 1 agents');
  });

  it('sends once a day after 07:00 UTC', async () => {
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const envNotify = { FEEDBACK_NOTIFY_EMAIL: 'ops@example.com' };
    expect(await runDailyDigest(db, envNotify, sender, new Date('2026-09-24T06:59:00Z'))).toBe('not_yet');
    expect(await runDailyDigest(db, envNotify, sender, new Date('2026-09-24T07:00:00Z'))).toBe('sent');
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send.mock.calls[0][0].subject).toContain('2026-09-23');
    expect(await runDailyDigest(db, envNotify, sender, new Date('2026-09-24T07:05:00Z'))).toBe('already_sent');
    expect(await runDailyDigest(db, {}, sender, new Date('2026-09-25T08:00:00Z'))).toBe('no_channel');
  });

  it('a digest that failed is retried every 30 minutes, then given up', async () => {
    const sender = { send: vi.fn().mockRejectedValue(new Error('resend down')) };
    const envNotify = { FEEDBACK_NOTIFY_EMAIL: 'ops@example.com' };
    const at = (min: number) => new Date(Date.parse('2026-09-24T07:00:00Z') + min * 60_000);
    expect(await runDailyDigest(db, envNotify, sender, at(0))).toBe('failed');
    expect(await runDailyDigest(db, envNotify, sender, at(10))).toBe('failed'); // too soon: not attempted
    expect(sender.send).toHaveBeenCalledTimes(1);
    sender.send.mockResolvedValue(undefined);
    expect(await runDailyDigest(db, envNotify, sender, at(31))).toBe('sent');
    expect(await runDailyDigest(db, envNotify, sender, at(70))).toBe('already_sent');

    const failing = { send: vi.fn().mockRejectedValue(new Error('down')) };
    const day2 = (min: number) => new Date(Date.parse('2026-09-25T07:00:00Z') + min * 60_000);
    for (let i = 0; i < DIGEST_MAX_ATTEMPTS; i++) expect(await runDailyDigest(db, envNotify, failing, day2(i * 31))).toBe('failed');
    expect(await runDailyDigest(db, envNotify, failing, day2(DIGEST_MAX_ATTEMPTS * 31))).toBe('gave_up');
    expect(failing.send).toHaveBeenCalledTimes(DIGEST_MAX_ATTEMPTS);
  });
});

describe('operator triage (/v1/owner/admin/feedback)', () => {
  async function session(ownerId: string): Promise<string> {
    await db.run(`INSERT INTO owners (id, status, display_name) VALUES (?, 'active', 'x')`, ownerId);
    const token = `tok_${ownerId}`;
    await new ControlStore(db).createSession({ ownerId, tokenHash: bytesToHex(sha256(new TextEncoder().encode(token))), method: 'email', ttlSeconds: 3600 });
    return `ba_owner_session=${token}`;
  }

  it('lists and updates feedback for an admin; 404 for anyone else; /me says who is admin', async () => {
    const id = ((await (await post(report())).json()) as { feedback_id: string }).feedback_id;
    const admin = await session(ADMIN);
    const other = await session('ow_someone');

    const list = await call('/v1/owner/admin/feedback?status=open', { headers: { Cookie: admin } });
    expect(list.status).toBe(200);
    const body = await list.json() as { feedback: Array<{ feedback_id: string; error_codes: string[] }>; counts: Record<string, number> };
    expect(body.feedback.map((f) => f.feedback_id)).toEqual([id]);
    expect(body.counts).toEqual({ open: 1, fixed: 0, wont_fix: 0 });

    expect((await call('/v1/owner/admin/feedback', { headers: { Cookie: other } })).status).toBe(404);
    expect((await call('/v1/owner/admin/feedback')).status).toBe(401);

    const upd = await call(`/v1/owner/admin/feedback/${id}`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'fixed', note: 'min_usdc shipped' }) });
    expect(upd.status).toBe(200);
    expect(((await upd.json()) as { feedback: { status: string; status_note: string } }).feedback).toMatchObject({ status: 'fixed', status_note: 'min_usdc shipped' });
    expect((await call(`/v1/owner/admin/feedback/fb_nope`, { method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'fixed' }) })).status).toBe(404);

    // Pagination survives timestamp ties.
    const tie = '2026-09-20T00:00:00.000Z';
    for (const fid of ['fb_t1', 'fb_t2', 'fb_t3']) {
      await db.run(`INSERT INTO feedback (feedback_id, scope, environment, expected_behavior, actual_behavior, steps_to_reproduce, status, created_at, updated_at) VALUES (?, 'general', 'e', 'x', 'y', 'z', 'wont_fix', ?, ?)`, fid, tie, tie);
    }
    const p1 = await (await call('/v1/owner/admin/feedback?status=wont_fix&limit=2', { headers: { Cookie: admin } })).json() as { feedback: Array<{ feedback_id: string }>; next_before: string };
    const p2 = await (await call(`/v1/owner/admin/feedback?status=wont_fix&limit=2&before=${encodeURIComponent(p1.next_before)}`, { headers: { Cookie: admin } })).json() as { feedback: Array<{ feedback_id: string }> };
    expect([...p1.feedback, ...p2.feedback].map((f) => f.feedback_id)).toEqual(['fb_t3', 'fb_t2', 'fb_t1']);

    const meAdmin = await (await call('/v1/owner/me', { headers: { Cookie: admin } })).json() as { is_admin: boolean };
    const meOther = await (await call('/v1/owner/me', { headers: { Cookie: other } })).json() as { is_admin: boolean };
    expect(meAdmin.is_admin).toBe(true);
    expect(meOther.is_admin).toBe(false);
  });
});
