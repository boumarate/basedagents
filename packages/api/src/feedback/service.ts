/**
 * Agent feedback and API telemetry (WS5, agent-first plan).
 *
 *   - Feedback: POST /v1/feedback stores a report (routes/feedback.ts) and
 *     notifies the operator by email (Resend) and Slack, if configured. The
 *     5-minute cron retries any notification that failed.
 *   - Telemetry: one upsert per agent-relevant request into api_usage_daily
 *     (CLI/skill version headers, signer, status, error code).
 *   - Digest: once a day, yesterday's counts go to the same channels: unique
 *     agents, versions in use, top error codes, 429s, feedback.
 *
 * Notify targets are env: FEEDBACK_NOTIFY_EMAIL, FEEDBACK_SLACK_WEBHOOK_URL.
 * With neither set, nothing is sent (and nothing is marked sent).
 */
import type { DBAdapter } from '../db/adapter.js';
import type { EmailSender } from '../control/email.js';

export interface FeedbackRow {
  feedback_id: string;
  agent_id: string | null;
  scope: 'task' | 'general';
  task_id: string | null;
  environment: string;
  expected_behavior: string;
  actual_behavior: string;
  steps_to_reproduce: string;
  error_codes: string | null;
  request_ids: string | null;
  suggested_improvement: string | null;
  skill_version: string | null;
  cli_version: string | null;
  user_agent: string | null;
  status: 'open' | 'fixed' | 'wont_fix';
  status_note: string | null;
  created_at: string;
  updated_at: string;
  email_notified_at: string | null;
  slack_notified_at: string | null;
  /** Set once every configured channel has the report. */
  notified_at: string | null;
}

interface NotifyEnv {
  FEEDBACK_NOTIFY_EMAIL?: string;
  FEEDBACK_SLACK_WEBHOOK_URL?: string;
}

const CONSOLE_FEEDBACK_URL = 'https://app.basedagents.ai/admin/feedback';
const list = (json: string | null): string[] => { try { return json ? JSON.parse(json) as string[] : []; } catch { return []; } };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function feedbackMessage(row: FeedbackRow): { subject: string; text: string } {
  const who = row.agent_id ?? 'anonymous';
  const subject = `[BasedAgents feedback] ${row.scope}${row.task_id ? ` ${row.task_id}` : ''}: ${clip(row.actual_behavior.split('\n')[0], 80)}`;
  const lines = [
    `From: ${who}`,
    `Scope: ${row.scope}${row.task_id ? ` (task ${row.task_id})` : ''}`,
    `Skill: ${row.skill_version ?? '—'} · CLI: ${row.cli_version ?? '—'}`,
    `Environment: ${row.environment}`,
    '',
    `Expected:\n${row.expected_behavior}`,
    '',
    `Actual:\n${row.actual_behavior}`,
    '',
    `Steps:\n${row.steps_to_reproduce}`,
  ];
  const codes = list(row.error_codes);
  const reqs = list(row.request_ids);
  if (codes.length) lines.push('', `Error codes: ${codes.join(', ')}`);
  if (reqs.length) lines.push(`Request ids: ${reqs.join(', ')}`);
  if (row.suggested_improvement) lines.push('', `Suggested:\n${row.suggested_improvement}`);
  lines.push('', `${row.feedback_id} · triage: ${CONSOLE_FEEDBACK_URL}`);
  return { subject, text: lines.join('\n') };
}

type Channel = 'email' | 'slack';

async function sendEmail(env: NotifyEnv, sender: EmailSender, subject: string, text: string): Promise<boolean> {
  try { await sender.send({ to: env.FEEDBACK_NOTIFY_EMAIL!, subject, text }); return true; }
  catch (err) { console.error('[feedback] email notify failed:', err instanceof Error ? err.message : err); return false; }
}

async function sendSlack(env: NotifyEnv, subject: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(env.FEEDBACK_SLACK_WEBHOOK_URL!, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${subject}*\n${clip(text, 3500)}` }),
    });
    if (!res.ok) console.error(`[feedback] slack notify failed: HTTP ${res.status}`);
    return res.ok;
  } catch (err) { console.error('[feedback] slack notify failed:', err instanceof Error ? err.message : err); return false; }
}

function channels(env: NotifyEnv): Channel[] {
  return [...(env.FEEDBACK_NOTIFY_EMAIL ? ['email' as const] : []), ...(env.FEEDBACK_SLACK_WEBHOOK_URL ? ['slack' as const] : [])];
}

/** Send to the given channels; returns the ones that accepted it. */
async function deliver(env: NotifyEnv, sender: EmailSender, to: Channel[], subject: string, text: string): Promise<Channel[]> {
  const ok: Channel[] = [];
  for (const ch of to) {
    if (ch === 'email' ? await sendEmail(env, sender, subject, text) : await sendSlack(env, subject, text)) ok.push(ch);
  }
  return ok;
}

export function notifyConfigured(env: NotifyEnv): boolean {
  return channels(env).length > 0;
}

/**
 * Notify about one report on every configured channel it hasn't reached yet.
 * Each channel's success is recorded on its own (email_notified_at,
 * slack_notified_at), so a channel that failed is retried later without
 * re-sending the one that worked. notified_at is set when all are done.
 */
export async function notifyFeedback(db: DBAdapter, env: NotifyEnv, sender: EmailSender, row: FeedbackRow, nowIso: string): Promise<boolean> {
  const configured = channels(env);
  if (!configured.length) return false;
  const pending = configured.filter((ch) => !(ch === 'email' ? row.email_notified_at : row.slack_notified_at));
  const { subject, text } = feedbackMessage(row);
  const ok = pending.length ? await deliver(env, sender, pending, subject, text) : [];
  for (const ch of ok) {
    await db.run(`UPDATE feedback SET ${ch === 'email' ? 'email_notified_at' : 'slack_notified_at'} = ? WHERE feedback_id = ?`, nowIso, row.feedback_id);
  }
  const allDone = pending.every((ch) => ok.includes(ch));
  if (allDone) await db.run('UPDATE feedback SET notified_at = COALESCE(notified_at, ?) WHERE feedback_id = ?', nowIso, row.feedback_id);
  return allDone;
}

/** Cron: retry channels that didn't get a report (older than 1 min, younger than 24 h). */
export async function retryFeedbackNotifications(db: DBAdapter, env: NotifyEnv, sender: EmailSender, nowIso: string): Promise<number> {
  const configured = channels(env);
  if (!configured.length) return 0;
  const missing = configured.map((ch) => `${ch === 'email' ? 'email_notified_at' : 'slack_notified_at'} IS NULL`).join(' OR ');
  const now = Date.parse(nowIso);
  const rows = await db.all<FeedbackRow>(
    `SELECT * FROM feedback WHERE (${missing}) AND created_at < ? AND created_at > ? ORDER BY created_at LIMIT 20`,
    new Date(now - 60_000).toISOString(), new Date(now - 24 * 3_600_000).toISOString(),
  );
  let done = 0;
  for (const row of rows) if (await notifyFeedback(db, env, sender, row, nowIso)) done++;
  return done;
}

// ─── Telemetry ───

export interface UsageRecord {
  day: string;
  agentId: string;
  cliVersion: string;
  skillVersion: string;
  status: number;
  errorCode: string;
}

/**
 * Distinct values of each version column kept per day; later new values count
 * as "other". Versions are recorded for signed requests only (index.ts), so
 * only registered agents can reach this, and it bounds even them.
 */
export const MAX_VERSIONS_PER_DAY = 50;

const KEY = 'day = ? AND agent_id = ? AND cli_version = ? AND skill_version = ? AND status = ? AND error_code = ?';

/**
 * One count per request. Version headers are untrusted (anyone can send any
 * value), so the number of distinct values stored per day is capped: a value
 * the day hasn't seen, once MAX_VERSIONS_PER_DAY exist, is folded into
 * "other". The cap costs one extra read, only when a new row would be created.
 */
export async function recordUsage(db: DBAdapter, r: UsageRecord): Promise<void> {
  const bump = (cli: string, skill: string) => db.run(`UPDATE api_usage_daily SET count = count + 1 WHERE ${KEY}`, r.day, r.agentId, cli, skill, r.status, r.errorCode);
  if ((await bump(r.cliVersion, r.skillVersion)).changes === 1) return;
  const capped = async (col: 'cli_version' | 'skill_version', v: string): Promise<string> => {
    if (!v || v === 'other') return v;
    const seen = await db.get<{ n: number; has: number }>(
      `SELECT COUNT(DISTINCT ${col}) AS n, MAX(${col} = ?) AS has FROM api_usage_daily WHERE day = ?`, v, r.day,
    );
    return seen && !seen.has && seen.n >= MAX_VERSIONS_PER_DAY ? 'other' : v;
  };
  const cli = await capped('cli_version', r.cliVersion);
  const skill = await capped('skill_version', r.skillVersion);
  await db.run(
    `INSERT INTO api_usage_daily (day, agent_id, cli_version, skill_version, status, error_code, count) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(day, agent_id, cli_version, skill_version, status, error_code) DO UPDATE SET count = count + 1`,
    r.day, r.agentId, cli, skill, r.status, r.errorCode,
  );
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,16})?$/;

/** A version header as stored: a semver-shaped value, "other" for anything else, "" when absent. */
export function cleanVersion(v: string | undefined | null): string {
  const s = (v ?? '').trim();
  if (!s) return '';
  return VERSION_RE.test(s) ? s : 'other';
}

// ─── Daily digest ───

export interface Digest {
  day: string;
  requests: number;
  uniqueAgents: number;
  rateLimited: number;
  byCli: Array<{ version: string; requests: number; agents: number }>;
  bySkill: Array<{ version: string; requests: number; agents: number }>;
  topErrors: Array<{ status: number; code: string; count: number }>;
  feedback: { received: number; open: number };
}

export async function buildDigest(db: DBAdapter, day: string): Promise<Digest> {
  const n = async (sql: string, ...p: unknown[]) => (await db.get<{ n: number | null }>(sql, ...p))?.n ?? 0;
  const byVersion = (col: 'cli_version' | 'skill_version') => db.all<{ version: string; requests: number; agents: number }>(
    `SELECT ${col} AS version, SUM(count) AS requests, COUNT(DISTINCT NULLIF(agent_id, '')) AS agents
     FROM api_usage_daily WHERE day = ? AND ${col} != '' GROUP BY ${col} ORDER BY requests DESC LIMIT 10`, day,
  );
  const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
  return {
    day,
    requests: await n('SELECT SUM(count) AS n FROM api_usage_daily WHERE day = ?', day),
    uniqueAgents: await n(`SELECT COUNT(DISTINCT agent_id) AS n FROM api_usage_daily WHERE day = ? AND agent_id != ''`, day),
    rateLimited: await n('SELECT SUM(count) AS n FROM api_usage_daily WHERE day = ? AND status = 429', day),
    byCli: await byVersion('cli_version'),
    bySkill: await byVersion('skill_version'),
    topErrors: await db.all<{ status: number; code: string; count: number }>(
      `SELECT status, error_code AS code, SUM(count) AS count FROM api_usage_daily WHERE day = ? AND status >= 400
       GROUP BY status, error_code ORDER BY count DESC, status LIMIT 10`, day,
    ),
    feedback: {
      received: await n('SELECT COUNT(*) AS n FROM feedback WHERE created_at >= ? AND created_at < ?', `${day}T00:00:00.000Z`, next),
      open: await n(`SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'`),
    },
  };
}

export function formatDigest(d: Digest): { subject: string; text: string } {
  const versions = (rows: Digest['byCli']) => rows.length ? rows.map((r) => `  ${r.version}: ${r.requests} requests, ${r.agents} agents`).join('\n') : '  (none)';
  const errors = d.topErrors.length ? d.topErrors.map((e) => `  ${e.status} ${e.code || '(no code)'}: ${e.count}`).join('\n') : '  (none)';
  return {
    subject: `[BasedAgents digest] ${d.day}: ${d.uniqueAgents} agents, ${d.feedback.received} feedback, ${d.rateLimited} × 429`,
    text: [
      `Agent traffic on ${d.day} (UTC)`,
      '',
      `Unique agents (signed): ${d.uniqueAgents}`,
      `Requests counted: ${d.requests}`,
      `429 rate-limited: ${d.rateLimited}`,
      `Feedback received: ${d.feedback.received} (open overall: ${d.feedback.open})`,
      '',
      'CLI versions (signed requests):', versions(d.byCli),
      '',
      'Skill versions (signed requests):', versions(d.bySkill),
      '',
      'Top error codes:', errors,
      '',
      `Triage feedback: ${CONSOLE_FEEDBACK_URL}`,
    ].join('\n'),
  };
}

/** The digest hour (UTC): the 5-minute cron sends yesterday's digest on its first run at or after it. */
export const DIGEST_HOUR_UTC = 7;

/** A digest that failed to go out is retried on later cron runs, at most this many times. */
export const DIGEST_MAX_ATTEMPTS = 5;
const DIGEST_RETRY_AFTER_MS = 30 * 60_000;

/**
 * Cron: send yesterday's digest once. A job_runs row claims the day
 * ('running'), becomes 'done' when at least one channel accepts it, or
 * 'failed' when building or every channel failed, and a failed day is retried
 * every 30 minutes, up to DIGEST_MAX_ATTEMPTS. With no channel configured the
 * day is marked done untouched, so the work isn't redone every 5 minutes.
 */
export async function runDailyDigest(db: DBAdapter, env: NotifyEnv, sender: EmailSender, now: Date): Promise<'sent' | 'no_channel' | 'already_sent' | 'not_yet' | 'failed' | 'gave_up'> {
  if (now.getUTCHours() < DIGEST_HOUR_UTC) return 'not_yet';
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const nowIso = now.toISOString();
  const claimed = await db.run(`INSERT OR IGNORE INTO job_runs (job, run_key, status, attempts, ran_at) VALUES ('daily_digest', ?, 'running', 1, ?)`, day, nowIso);
  if (claimed.changes === 0) {
    const row = await db.get<{ status: string; attempts: number; ran_at: string }>(`SELECT status, attempts, ran_at FROM job_runs WHERE job = 'daily_digest' AND run_key = ?`, day);
    if (!row || row.status !== 'failed') return 'already_sent';
    if (row.attempts >= DIGEST_MAX_ATTEMPTS) return 'gave_up';
    if (Date.parse(row.ran_at) > now.getTime() - DIGEST_RETRY_AFTER_MS) return 'failed';
    const retry = await db.run(
      `UPDATE job_runs SET status = 'running', attempts = attempts + 1, ran_at = ? WHERE job = 'daily_digest' AND run_key = ? AND status = 'failed'`, nowIso, day,
    );
    if (retry.changes === 0) return 'already_sent';
  }
  const finish = (status: 'done' | 'failed') => db.run(`UPDATE job_runs SET status = ?, ran_at = ? WHERE job = 'daily_digest' AND run_key = ?`, status, nowIso, day);
  const configured = channels(env);
  if (!configured.length) { await finish('done'); return 'no_channel'; }
  try {
    const { subject, text } = formatDigest(await buildDigest(db, day));
    const ok = await deliver(env, sender, configured, subject, text);
    await finish(ok.length ? 'done' : 'failed');
    return ok.length ? 'sent' : 'failed';
  } catch (err) {
    console.error('[feedback] digest failed:', err instanceof Error ? err.message : err);
    await finish('failed');
    return 'failed';
  }
}
