/**
 * Acquisition reporting (acquisition/report.ts) — metric definitions over
 * committed domain state:
 *
 *  - conversions derive from tasks/settlement columns, so cron/auto-accept
 *    settlements attribute to the (possibly disconnected) worker
 *  - payment states are counted separately: refunds, testnet settlements and
 *    failed settles never enter settled worker USDC (PAID_WHERE)
 *  - buyer and worker attribution stay separate; human buyers are their own
 *    bucket; USDC is atomic-int math formatted at the edge
 *  - cohort vs activity views have different denominators; unknown is its own
 *    row; immature retention cohorts are flagged; internal traffic is
 *    excluded by default from env lists only
 *  - the bearer admin endpoint enforces ADMIN_SECRET and serves CSV
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { setNodeAdapter } from '../index.js';
import { setupTestDb, createTestApp, createTestAgent } from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { ControlStore } from '../control/store.js';
import { sha256, bytesToHex } from '../crypto/index.js';
import { cohortReport, activityReport, type ReportFilters } from './report.js';
import { acquisitionRetentionSweep, runAcquisitionRetention, RETENTION_MAX_ATTEMPTS } from './capture.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
/** The real control-plane owners schema (0023) — never a hand-written stand-in. */
const OWNERS_SQL = readFileSync(join(MIGRATIONS_DIR, '0023_owner_accounts.sql'), 'utf-8');

const NOW = new Date('2026-10-02T12:00:00.000Z');
const DAYS = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAYS).toISOString();
const TX = `0x${'ab'.repeat(32)}`;

let taskSeq = 0;

async function insertTask(db: SQLiteAdapter, t: {
  creatorAgent?: string; creatorOwner?: string; claimedBy?: string;
  claimedAt?: string; submittedAt?: string; verifiedAt?: string;
  fundedAt?: string; settledAt?: string; bounty?: string;
  network?: string; paymentStatus?: string; escrowStatus?: string; txHash?: string;
}): Promise<string> {
  const id = `task_report${String(taskSeq++).padStart(10, '0')}`;
  await db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_owner_id, creator_kind, claimed_by_agent_id,
       title, description, status, created_at, claimed_at, submitted_at, verified_at,
       bounty_amount, bounty_token, bounty_network, payment_status, payment_tx_hash,
       settled_at, escrow, escrow_status, escrow_funded_at)
     VALUES (?, ?, ?, ?, ?, 'T', 'D', ?, ?, ?, ?, ?, ?, 'USDC', ?, ?, ?, ?, ?, ?, ?)`,
    id, t.creatorAgent ?? null, t.creatorOwner ?? null, t.creatorOwner ? 'owner' : 'agent',
    t.claimedBy ?? null,
    t.verifiedAt ? 'verified' : t.claimedAt ? 'claimed' : 'open', iso(40),
    t.claimedAt ?? null, t.submittedAt ?? null, t.verifiedAt ?? null,
    t.bounty ?? null, t.network ?? 'eip155:8453',
    t.paymentStatus ?? 'none', t.txHash ?? (t.settledAt ? TX : null),
    t.settledAt ?? null, t.fundedAt ? 1 : 0, t.escrowStatus ?? (t.fundedAt ? 'funded' : null), t.fundedAt ?? null,
  );
  return id;
}

async function insertAcquisition(
  db: SQLiteAdapter, agentId: string, source: string, registeredAt: string,
  extra: { campaign?: string; iface?: string } = {},
): Promise<void> {
  // The cohort is keyed on the agent's real registration time, so keep both in step.
  await db.run('UPDATE agents SET registered_at = ? WHERE id = ?', registeredAt, agentId);
  await db.run(
    `INSERT INTO agent_acquisition (agent_id, registered_at, source, campaign, interface, method) VALUES (?, ?, ?, ?, ?, 'config_tag')`,
    agentId, registeredAt, source, extra.campaign ?? '', extra.iface ?? '',
  );
}

const filters = (over: Partial<ReportFilters> = {}): ReportFilters => ({
  from: iso(60),
  to: NOW.toISOString(),
  includeInternal: false,
  internalIds: new Set<string>(),
  now: NOW,
  ...over,
});

describe('acquisition reports', () => {
  let db: SQLiteAdapter;

  beforeEach(async () => {
    db = setupTestDb();
    await db.exec(OWNERS_SQL);
  });

  it('attributes worker conversions and settled USDC by the worker source, buyers by the buyer source — never summed together', async () => {
    const buyer = await createTestAgent(db);   // acquired via github
    const worker = await createTestAgent(db);  // acquired via pulsemcp
    await insertAcquisition(db, buyer.agentId, 'github', iso(30));
    await insertAcquisition(db, worker.agentId, 'pulsemcp', iso(30));
    // Funded by the github buyer, delivered + PAID to the pulsemcp worker.
    // Settled by the auto-accept/settle-retry cron path — no live connection
    // from the worker — which is invisible here on purpose: the committed
    // columns are the record.
    await insertTask(db, {
      creatorAgent: buyer.agentId, claimedBy: worker.agentId,
      claimedAt: iso(20), submittedAt: iso(19), verifiedAt: iso(18),
      fundedAt: iso(21), settledAt: iso(17),
      bounty: '5000000', paymentStatus: 'settled', escrowStatus: 'released',
    });

    const report = await cohortReport(db, filters());
    const bySource = Object.fromEntries(report.agents.map((r) => [r.source, r]));
    expect(bySource.pulsemcp).toMatchObject({
      new_agents: 1,
      agents_with_first_claim: 1,
      agents_with_first_accepted_delivery: 1,
      first_paid_agents: 1,
      settled_worker_usdc_atomic: '5000000',
      settled_worker_usdc: '5.00',
      buyers_with_first_funded_task: 0,
    });
    expect(bySource.github).toMatchObject({
      new_agents: 1,
      buyers_with_first_funded_task: 1,
      repeat_funded_buyers: 0,
      first_paid_agents: 0,
      settled_worker_usdc_atomic: '0',
    });
  });

  it('counts payment states separately: refunds, testnet and failed settles are not paid outcomes', async () => {
    const worker = await createTestAgent(db);
    await insertAcquisition(db, worker.agentId, 'npm', iso(30));
    const base = { claimedBy: worker.agentId, claimedAt: iso(20), creatorOwner: 'ow_x' };
    await db.run(`INSERT INTO owners (id, email) VALUES ('ow_x', 'x@example.com')`);
    // refunded escrow
    await insertTask(db, { ...base, settledAt: iso(10), bounty: '1000000', paymentStatus: 'settled', escrowStatus: 'refunded' });
    // testnet settlement
    await insertTask(db, { ...base, settledAt: iso(10), bounty: '1000000', paymentStatus: 'settled', network: 'eip155:84532' });
    // failed settle
    await insertTask(db, { ...base, bounty: '1000000', paymentStatus: 'failed' });
    // the one real payout
    await insertTask(db, { ...base, verifiedAt: iso(9), settledAt: iso(8), bounty: '2500000', paymentStatus: 'settled' });

    const report = await cohortReport(db, filters());
    const npm = report.agents.find((r) => r.source === 'npm')!;
    expect(npm.first_paid_agents).toBe(1);
    expect(npm.settled_worker_usdc_atomic).toBe('2500000');
    expect(npm.settled_worker_usdc).toBe('2.50');
  });

  it('reports human buyers as their own bucket, never inside the source table', async () => {
    await db.run(`INSERT INTO owners (id, email, created_at) VALUES ('ow_h', 'h@example.com', ?)`, iso(20));
    await insertTask(db, { creatorOwner: 'ow_h', fundedAt: iso(15) });
    await insertTask(db, { creatorOwner: 'ow_h', fundedAt: iso(10) });
    const report = await cohortReport(db, filters());
    expect(report.human_buyers).toEqual({
      new_owners: 1,
      buyers_with_first_funded_task: 1,
      repeat_funded_buyers: 1,
      buyers_with_first_paid_at_accept: 0,
      repeat_paid_at_accept_buyers: 0,
    });
    expect(report.agents.find((r) => r.source === 'human_buyer')).toBeUndefined();
  });

  it('flags immature retention cohorts and counts 7-day returning from meaningful rollups only', async () => {
    const mature = await createTestAgent(db);
    const matureQuiet = await createTestAgent(db);
    const young = await createTestAgent(db);
    await insertAcquisition(db, mature.agentId, 'github', iso(20));
    await insertAcquisition(db, matureQuiet.agentId, 'github', iso(20));
    await insertAcquisition(db, young.agentId, 'github', iso(3)); // window incomplete
    // mature: meaningful use on day +8 → returning
    await db.run(
      `INSERT INTO installation_usage_daily (day, installation_id, agent_id, interface, kind, count) VALUES (?, '', ?, 'mcp_stdio', 'meaningful', 2)`,
      iso(12).slice(0, 10), mature.agentId,
    );
    // matureQuiet: only discovery polling in the window → NOT returning
    await db.run(
      `INSERT INTO installation_usage_daily (day, installation_id, agent_id, interface, kind, count) VALUES (?, '', ?, 'mcp_stdio', 'discovery', 50)`,
      iso(12).slice(0, 10), matureQuiet.agentId,
    );
    const report = await cohortReport(db, filters());
    const github = report.agents.find((r) => r.source === 'github')!;
    expect(github.new_agents).toBe(3);
    expect(github.mature_agents).toBe(2);
    expect(github.immature_agents).toBe(1);
    expect(github.returning_7d).toBe(1);
  });

  it('excludes internal ids by default and includes them only on request', async () => {
    const internal = await createTestAgent(db);
    const real = await createTestAgent(db);
    await insertAcquisition(db, internal.agentId, 'partner', iso(20));
    await insertAcquisition(db, real.agentId, 'partner', iso(20));
    const internalIds = new Set([internal.agentId]);
    const excluded = await cohortReport(db, filters({ internalIds }));
    expect(excluded.agents.find((r) => r.source === 'partner')!.new_agents).toBe(1);
    const included = await cohortReport(db, filters({ internalIds, includeInternal: true }));
    expect(included.agents.find((r) => r.source === 'partner')!.new_agents).toBe(2);
  });

  it('keeps cohort and activity denominators apart: old cohorts still show period activity', async () => {
    const worker = await createTestAgent(db);
    await insertAcquisition(db, worker.agentId, 'smithery', iso(200)); // acquired long before the window
    await insertTask(db, {
      creatorOwner: 'ow_a', claimedBy: worker.agentId,
      fundedAt: iso(6), claimedAt: iso(5), submittedAt: iso(4), verifiedAt: iso(3), settledAt: iso(2),
      bounty: '1000000', paymentStatus: 'settled',
    });
    await db.run(`INSERT INTO owners (id, email) VALUES ('ow_a', 'a@example.com')`);

    const cohort = await cohortReport(db, filters({ from: iso(30) }));
    expect(cohort.agents.find((r) => r.source === 'smithery')).toBeUndefined(); // not acquired in period

    const activity = await activityReport(db, filters({ from: iso(30) }));
    const workerRow = activity.rows.find((r) => r.perspective === 'worker' && r.source === 'smithery')!;
    expect(workerRow).toMatchObject({ claims: 1, deliveries: 1, acceptances: 1, settled_payouts: 1, settled_worker_usdc: '1.00' });
    const buyerRow = activity.rows.find((r) => r.perspective === 'buyer')!;
    expect(buyerRow.source).toBe('human_buyer');
  });

  it('reports attribution coverage without revising the original measure, and N/A on empty', async () => {
    const empty = await cohortReport(db, filters());
    expect(empty.coverage.coverage_at_first_pct).toBeNull();

    await db.run(
      `INSERT INTO mcp_installations (installation_id, first_observed_at, source_at_first_observation, first_known_source, first_known_source_at)
       VALUES ('11111111-2222-4333-8444-555555555551', ?, 'unknown', 'pulsemcp', ?),
              ('11111111-2222-4333-8444-555555555552', ?, 'github', 'github', ?)`,
      iso(10), iso(5), iso(10), iso(10),
    );
    const report = await cohortReport(db, filters());
    expect(report.coverage.observed_installations).toBe(2);
    expect(report.coverage.known_at_first_observation).toBe(1); // the original measure stands
    expect(report.coverage.known_ever).toBe(2);
    expect(report.coverage.coverage_at_first_pct).toBe(50);
    expect(report.coverage.coverage_ever_pct).toBe(100);
    // unknown-at-first installation reports under its later-known source row,
    // with the at-first column keeping the honest zero.
    const pulse = report.installations.find((r) => r.source === 'pulsemcp')!;
    expect(pulse.known_at_first_observation).toBe(0);
  });

  it('counts pay-at-accept buyers as their own payment mode, beside escrow funding', async () => {
    const buyer = await createTestAgent(db);
    const worker = await createTestAgent(db);
    await insertAcquisition(db, buyer.agentId, 'github', iso(30));
    await insertAcquisition(db, worker.agentId, 'npm', iso(30));
    // Two no-escrow bounties paid at acceptance (no escrow_funded_at at all).
    for (const d of [10, 5]) {
      await insertTask(db, {
        creatorAgent: buyer.agentId, claimedBy: worker.agentId,
        claimedAt: iso(d + 2), verifiedAt: iso(d), settledAt: iso(d),
        bounty: '1000000', paymentStatus: 'settled',
      });
    }
    const cohort = await cohortReport(db, filters());
    const gh = cohort.agents.find((r) => r.source === 'github')!;
    expect(gh).toMatchObject({
      buyers_with_first_funded_task: 0,
      buyers_with_first_paid_at_accept: 1,
      repeat_paid_at_accept_buyers: 1,
    });
    const activity = await activityReport(db, filters({ from: iso(20) }));
    const buyerRow = activity.rows.find((r) => r.perspective === 'buyer' && r.source === 'github')!;
    expect(buyerRow).toMatchObject({ funded_tasks: 0, paid_at_accept_tasks: 2 });
  });

  it('counts agents with no acquisition record (e.g. other creation paths) under unknown', async () => {
    const plain = await createTestAgent(db, { registeredAt: iso(5) }); // no agent_acquisition row
    const report = await cohortReport(db, filters());
    expect(report.agents.find((r) => r.source === 'unknown')!.new_agents).toBe(1);
    expect(plain.agentId).toBeTruthy();
  });

  it('applies campaign and interface filters in the activity view', async () => {
    const tagged = await createTestAgent(db);
    const other = await createTestAgent(db);
    await insertAcquisition(db, tagged.agentId, 'pulsemcp', iso(30), { campaign: 'october', iface: 'mcp_stdio' });
    await insertAcquisition(db, other.agentId, 'pulsemcp', iso(30), { campaign: 'november', iface: 'cli' });
    await db.run(`INSERT INTO owners (id, email) VALUES ('ow_f', 'f@example.com')`);
    for (const w of [tagged, other]) {
      await insertTask(db, { creatorOwner: 'ow_f', claimedBy: w.agentId, claimedAt: iso(3) });
    }
    const all = await activityReport(db, filters({ from: iso(20) }));
    expect(all.rows.find((r) => r.perspective === 'worker')!.claims).toBe(2);
    const byCampaign = await activityReport(db, filters({ from: iso(20), campaign: 'october' }));
    expect(byCampaign.rows.find((r) => r.perspective === 'worker')!.claims).toBe(1);
    const byIface = await activityReport(db, filters({ from: iso(20), iface: 'cli' }));
    expect(byIface.rows.find((r) => r.perspective === 'worker')!.claims).toBe(1);
  });

  it('excludes installations linked to internal agents unless internal traffic is included', async () => {
    const monitor = await createTestAgent(db);
    await db.run(
      `INSERT INTO mcp_installations (installation_id, first_observed_at) VALUES
         ('11111111-2222-4333-8444-000000000001', ?), ('11111111-2222-4333-8444-000000000002', ?)`,
      iso(5), iso(5),
    );
    await db.run(
      `INSERT INTO installation_agent_links (installation_id, agent_id, first_linked_at) VALUES ('11111111-2222-4333-8444-000000000001', ?, ?)`,
      monitor.agentId, iso(5),
    );
    const internalIds = new Set([monitor.agentId]);
    const excluded = await cohortReport(db, filters({ internalIds }));
    expect(excluded.coverage.observed_installations).toBe(1);
    const included = await cohortReport(db, filters({ internalIds, includeInternal: true }));
    expect(included.coverage.observed_installations).toBe(2);
  });

  it('serves the bearer admin endpoint with CSV export, fail-closed auth', async () => {
    const app = createTestApp(db, { ADMIN_SECRET: 's3cret' });
    expect((await app.request('/v1/admin/acquisition')).status).toBe(401);
    const noSecret = createTestApp(db, {});
    expect((await noSecret.request('/v1/admin/acquisition')).status).toBe(403);

    const worker = await createTestAgent(db);
    await insertAcquisition(db, worker.agentId, 'glama', iso(5));
    const auth = { Authorization: 'Bearer s3cret' };
    const json = await app.request('/v1/admin/acquisition', { headers: auth });
    expect(json.status).toBe(200);
    const body = await json.json() as { ok: boolean; agents: Array<{ source: string }> };
    expect(body.ok).toBe(true);
    expect(body.agents[0].source).toBe('glama');

    const csv = await app.request('/v1/admin/acquisition?format=csv', { headers: auth });
    expect(csv.headers.get('Content-Type')).toContain('text/csv');
    const text = await csv.text();
    expect(text.split('\n')[0]).toContain('source');
    expect(text).toContain('glama');

    expect((await app.request('/v1/admin/acquisition?view=nope', { headers: auth })).status).toBe(400);
  });

  it('retention sweep deletes raw analytics past 90d but never the attribution registry', async () => {
    const agent = await createTestAgent(db);
    await insertAcquisition(db, agent.agentId, 'github', iso(200));
    await db.run(
      `INSERT INTO mcp_installations (installation_id, first_observed_at) VALUES ('11111111-2222-4333-8444-555555555553', ?)`,
      iso(200),
    );
    await db.run(
      `INSERT INTO mcp_tool_outcomes (tool_call_id, tool_name, outcome, received_at)
       VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-000000000001', 'browse_tasks', 'ok', ?),
              ('aaaaaaaa-bbbb-4ccc-8ddd-000000000002', 'browse_tasks', 'ok', ?)`,
      iso(120), iso(5),
    );
    await db.run(
      `INSERT INTO acquisition_ids (id, source, created_at, expires_at) VALUES ('acq_old', 'npm', ?, ?)`,
      iso(200), iso(40),
    );
    const swept = await acquisitionRetentionSweep(db, NOW.toISOString());
    expect(swept).toEqual({ outcomes: 1, acquisitionIds: 1, usageDays: 0 });
    expect((await db.all('SELECT * FROM mcp_tool_outcomes')).length).toBe(1);
    expect((await db.all('SELECT * FROM agent_acquisition')).length).toBe(1);
    expect((await db.all('SELECT * FROM mcp_installations')).length).toBe(1);
  });
});

describe('acquisition retention job', () => {
  const job = (db: SQLiteAdapter) => db.get<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM job_runs WHERE job = 'acquisition_retention' AND run_key = ?`, NOW.toISOString().slice(0, 10),
  );

  it('runs once a day', async () => {
    const db = setupTestDb();
    expect(await runAcquisitionRetention(db, NOW)).toMatch(/^swept/);
    expect(await runAcquisitionRetention(db, NOW)).toBe('already_ran');
  });

  it('retries a failed run on a later tick the same day', async () => {
    const db = setupTestDb();
    await db.exec('ALTER TABLE mcp_tool_outcomes RENAME TO mcp_tool_outcomes_hidden');
    await expect(runAcquisitionRetention(db, NOW)).rejects.toThrow();
    expect(await job(db)).toMatchObject({ status: 'failed', attempts: 1 });
    await db.exec('ALTER TABLE mcp_tool_outcomes_hidden RENAME TO mcp_tool_outcomes');
    expect(await runAcquisitionRetention(db, new Date(NOW.getTime() + 300_000))).toMatch(/^swept/);
    expect(await job(db)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('re-claims a run stuck in running (worker died mid-sweep), but not a live one', async () => {
    const db = setupTestDb();
    await db.run(
      `INSERT INTO job_runs (job, run_key, status, attempts, ran_at) VALUES ('acquisition_retention', ?, 'running', 1, ?)`,
      NOW.toISOString().slice(0, 10), NOW.toISOString(),
    );
    expect(await runAcquisitionRetention(db, new Date(NOW.getTime() + 60_000))).toBe('in_progress');
    expect(await runAcquisitionRetention(db, new Date(NOW.getTime() + 20 * 60_000))).toMatch(/^swept/);
  });

  it('gives up after the attempt cap', async () => {
    const db = setupTestDb();
    await db.run(
      `INSERT INTO job_runs (job, run_key, status, attempts, ran_at) VALUES ('acquisition_retention', ?, 'failed', ?, ?)`,
      NOW.toISOString().slice(0, 10), RETENTION_MAX_ATTEMPTS, NOW.toISOString(),
    );
    expect(await runAcquisitionRetention(db, NOW)).toBe('gave_up');
  });
});

describe('acquisition reports — owners edge cases', () => {
  it('reads a missing owners table (OSS deploy without the control plane) as an empty human-buyer bucket', async () => {
    const db = setupTestDb(); // no 0023
    const report = await cohortReport(db, filters());
    expect(report.human_buyers).toEqual({
      new_owners: 0, buyers_with_first_funded_task: 0, repeat_funded_buyers: 0,
      buyers_with_first_paid_at_accept: 0, repeat_paid_at_accept_buyers: 0,
    });
  });

  it('normalizes CURRENT_TIMESTAMP-format owner rows against ISO period bounds', async () => {
    const db = setupTestDb();
    await db.exec(OWNERS_SQL);
    // Space-separated default format, inside the window by date but lexically
    // '<' the ISO 'T' bound on the same day if compared raw.
    const day = iso(0).slice(0, 10);
    await db.run(`INSERT INTO owners (id, email, created_at) VALUES ('ow_sp', 'sp@example.com', ?)`, `${day} 06:00:00`);
    const report = await cohortReport(db, filters({ from: `${day}T00:00:00.000Z` }));
    expect(report.human_buyers.new_owners).toBe(1);
  });
});

describe('console admin route (/v1/owner/admin/acquisition)', () => {
  const ADMIN = 'ow_admin_acq';
  let db: SQLiteAdapter;
  let pending: Promise<unknown>[];
  const env = { ADMIN_OWNER_IDS: ADMIN };
  const ctx = () => ({ waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} });
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await worker.fetch(new Request(`https://api.basedagents.ai${path}`, init), env as never, ctx() as never);
    await Promise.all(pending.splice(0));
    return res;
  };
  async function session(ownerId: string): Promise<string> {
    await db.run(`INSERT INTO owners (id, status, display_name) VALUES (?, 'active', 'x')`, ownerId);
    const token = `tok_${ownerId}`;
    await new ControlStore(db).createSession({ ownerId, tokenHash: bytesToHex(sha256(new TextEncoder().encode(token))), method: 'email', ttlSeconds: 3600 });
    return `ba_owner_session=${token}`;
  }

  beforeEach(async () => {
    db = setupTestDb();
    for (const f of ['0023_owner_accounts.sql', '0025_owner_recovery.sql', '0027_authority_ladder.sql']) {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
    }
    setNodeAdapter(db);
    pending = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('serves the report and CSV to an admin, 404 to other owners, 401 without a session', async () => {
    const admin = await session(ADMIN);
    const other = await session('ow_someone_else');
    const res = await call('/v1/owner/admin/acquisition?view=cohort', { headers: { Cookie: admin } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; view: string; coverage: unknown };
    expect(body).toMatchObject({ ok: true, view: 'cohort' });
    const csv = await call('/v1/owner/admin/acquisition?view=activity&format=csv', { headers: { Cookie: admin } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('Content-Type')).toContain('text/csv');
    expect((await call('/v1/owner/admin/acquisition', { headers: { Cookie: other } })).status).toBe(404);
    expect((await call('/v1/owner/admin/acquisition')).status).toBe(401);
  });
});
