/**
 * Agent Testing — test-mode walkthrough with screenshots (spec §22.7).
 *
 * Boots the API IN-PROCESS (harness app: scripted Stripe double, fake
 * facilitator, software passkeys, recording email) on :3900, drives the full
 * §20.6 journey through real HTTP routes, then serves the built console
 * (dist-shots, VITE_API_URL=http://localhost:3900) and the public web dist,
 * and captures authenticated screenshots of the implemented pages.
 *
 * Everything is a labeled test fixture. No external service is contacted.
 *
 *   cd packages/console && VITE_API_URL=http://localhost:3900 npx vite build --outDir dist-shots
 *   cd packages/api && npx tsx scripts/testing-screenshots.ts
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { etc } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

etc.sha512Sync = (...m: Parameters<typeof sha512>) => sha512(...m);

import {
  makeHarness, setupOperator, operatorSign, paidOrder, registerWorkerAgent, workerRequest,
  buildWorkerResult, sha256hexStr, type Harness, type Worker,
} from '../src/control/agent-testing/test-harness.js';
import { TestingStore } from '../src/control/agent-testing/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const OUT = join(ROOT, 'docs', 'screenshots', 'testing');
const API_PORT = 3900;
const CONSOLE_PORT = 4900;
const WEB_PORT = 5900;

function staticServer(root: string, port: number, spaFallback: boolean): http.Server {
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml',
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    let file = join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = join(file, 'index.html');
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const asHtml = `${file}.html`;
      file = existsSync(asHtml) ? asHtml : spaFallback ? join(root, 'index.html') : file;
    }
    if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  server.listen(port);
  return server;
}

const GROUPS = [
  { group: 'grp-alpha', envs: [{ client: 'claude-code', transport: 'mcp' }] },
  { group: 'grp-beta', envs: [{ client: 'openhands', transport: 'http' }] },
  { group: 'grp-gamma', envs: [{ client: 'aider', transport: 'http' }] },
];

async function seedWorkers(h: Harness, op: { cookie: string }): Promise<Worker[]> {
  const platform = await registerWorkerAgent(h, 'BasedAgents Testing');
  h.env.TESTING_PLATFORM_AGENT_ID = platform.agentId;
  const workers: Worker[] = [];
  for (const g of GROUPS) {
    const w = await registerWorkerAgent(h);
    workers.push(w);
    await h.post(`/v1/owner/admin/testing/workers/${w.agentId}/eligibility`, {
      operator_group_id: g.group, group_confidence: 'operator_reviewed',
      capabilities: ['agent-compatibility-testing'], environments: g.envs,
      evidence_refs: ['fixture'], provenance: 'operator_reviewed', status: 'approved', expires_at: null, notes: '',
    }, op.cookie);
  }
  return workers;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const h = makeHarness();
  const store = new TestingStore(h.db);

  // Wrap the harness app with CORS for the local console origin.
  const outer = new Hono();
  outer.use('*', cors({
    origin: (o) => (o === `http://localhost:${CONSOLE_PORT}` || o === `http://localhost:${WEB_PORT}` ? o : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Timestamp', 'X-Nonce', 'Idempotency-Key'],
  }));
  outer.route('/', h.app);
  const apiServer = serve({
    fetch: (req) => outer.fetch(req as never, h.env),
    port: API_PORT, hostname: '127.0.0.1',
  });

  const consoleServer = staticServer(join(ROOT, 'packages/console/dist-shots'), CONSOLE_PORT, true);
  const webServer = staticServer(join(ROOT, 'packages/web/dist'), WEB_PORT, true);

  // ── drive the full journey ──
  const op = await setupOperator(h);
  const workers = await seedWorkers(h, op);
  const { buyer, orderId, requestId } = await paidOrder(h, op);
  const runs = (await store.listRuns(orderId)).filter((r) => r.kind === 'external');
  const quote = (await store.getQuote((await store.getOrder(orderId))!.quote_id))!;
  const runIds = runs.map((r) => r.id).sort();
  const pub = await operatorSign(h, op, 'testing.publish_tasks', {
    order_id: orderId, run_ids: runIds, scope_hash: quote.scope_hash,
    bounty_usdc_atomic: quote.worker_bounty_usdc_atomic,
    total_commitment_usdc_atomic: String(BigInt(quote.worker_bounty_usdc_atomic) * 3n),
    worker_cap_usdc_atomic: quote.worker_cap_usdc_atomic,
  });
  await h.post(`/v1/owner/admin/testing/orders/${orderId}/publish-tasks`, { run_ids: runIds, ...pub }, op.cookie);
  await h.runJobs();

  const outcomes: Array<'product_success' | 'product_failure'> = ['product_success', 'product_failure', 'product_success'];
  for (let i = 0; i < runs.length; i++) {
    const attempt = (await store.getActiveAttempt(runs[i].id))!;
    await workerRequest(h, workers[i], 'POST', `/v1/tasks/${attempt.task_id}/claim`, {});
    const brief = ((await (await workerRequest(h, workers[i], 'GET', `/v1/testing/assignments/${attempt.task_id}/brief`)).json()) as { brief: Parameters<typeof buildWorkerResult>[0] }).brief;
    const result = buildWorkerResult(brief, outcomes[i] === 'product_failure' ? { outcome: 'product_failure', failureStage: 'tool_schema discovery' } : {});
    await workerRequest(h, workers[i], 'POST', `/v1/tasks/${attempt.task_id}/deliver`, {
      summary: 'testing result attached', submission_type: 'json', submission_content: JSON.stringify(result),
    });
  }
  await h.runJobs();

  // Review externals 1+3 fully; leave slot 2 (the product failure) awaiting
  // review so the admin screenshots show live review UI.
  const baseline = (await store.listRuns(orderId)).find((r) => r.kind === 'baseline')!;
  const baseSig = await operatorSign(h, op, 'testing.review_run', {
    run_id: baseline.id, run_version: baseline.version, evidence: 'valid', outcome: 'product_success',
    marketplace_action: 'none', note_hash: sha256hexStr('internal baseline completed'),
  });
  await h.post(`/v1/owner/admin/testing/runs/${baseline.id}/review`, {
    expected_version: baseline.version, evidence: 'valid', outcome: 'product_success',
    environment_demonstrated: null, slot_satisfied: true, marketplace_action: 'none',
    note: 'internal baseline completed', ...baseSig,
  }, op.cookie);
  for (const i of [0, 2]) {
    const run = (await store.getRun(runs[i].id))!;
    const note = 'workflow completed; evidence valid';
    const sig = await operatorSign(h, op, 'testing.review_run', {
      run_id: run.id, run_version: run.version, evidence: 'valid', outcome: 'product_success',
      marketplace_action: 'accept', note_hash: sha256hexStr(note),
    });
    await h.post(`/v1/owner/admin/testing/runs/${run.id}/review`, {
      expected_version: run.version, evidence: 'valid', outcome: 'product_success',
      environment_demonstrated: true, slot_satisfied: true, operator_group_id: GROUPS[i].group,
      marketplace_action: 'accept', note, ...sig,
    }, op.cookie);
  }
  await h.runJobs();

  // ── screenshots ──
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined });
  const shoot = async (cookieHeader: string | null, url: string, file: string, fullPage = true) => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    if (cookieHeader) {
      const token = cookieHeader.split('=')[1];
      await context.addCookies([{ name: 'ba_owner_session', value: token, domain: 'localhost', path: '/', sameSite: 'Lax' }]);
    }
    const page = await context.newPage();
    // Public web pages fetch the production API for the catalog — reroute to local.
    await page.route('https://api.basedagents.ai/**', async (route) => {
      const target = route.request().url().replace('https://api.basedagents.ai', `http://127.0.0.1:${API_PORT}`);
      const res = await fetch(target);
      route.fulfill({ status: res.status, body: await res.text(), headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, file), fullPage });
    await context.close();
    console.log(`  ✓ ${file}`);
  };

  console.log('capturing screenshots →', OUT);
  const C = `http://localhost:${CONSOLE_PORT}`;
  const W = `http://localhost:${WEB_PORT}`;
  await shoot(null, `${W}/testing`, 'web-testing.png');
  await shoot(null, `${W}/testing/sample`, 'web-testing-sample.png');
  await shoot(buyer.cookie, `${C}/testing`, 'console-audits.png');
  await shoot(buyer.cookie, `${C}/testing/new`, 'console-intake.png');
  await shoot(buyer.cookie, `${C}/testing/requests/${requestId}`, 'console-request-quote.png');
  await shoot(buyer.cookie, `${C}/testing/orders/${orderId}`, 'console-order.png');
  await shoot(op.cookie, `${C}/testing/admin`, 'console-admin-queue.png');
  await shoot(op.cookie, `${C}/testing/admin/orders/${orderId}`, 'console-admin-order.png');

  // Publish the report via the API, then capture the customer report view.
  const remaining = (await store.getRun(runs[1].id))!;
  const failNote = 'reproducible discovery failure; evidence valid';
  const failSig = await operatorSign(h, op, 'testing.review_run', {
    run_id: remaining.id, run_version: remaining.version, evidence: 'valid', outcome: 'product_failure',
    marketplace_action: 'accept', note_hash: sha256hexStr(failNote),
  });
  await h.post(`/v1/owner/admin/testing/runs/${remaining.id}/review`, {
    expected_version: remaining.version, evidence: 'valid', outcome: 'product_failure',
    environment_demonstrated: true, slot_satisfied: true, operator_group_id: GROUPS[1].group,
    marketplace_action: 'accept', note: failNote, ...failSig,
  }, op.cookie);
  await h.runJobs();
  const draftRes = await h.post(`/v1/owner/admin/testing/orders/${orderId}/report-draft`, {}, op.cookie);
  const draft = ((await draftRes.json()) as { report: { id: string } }).report;
  const row = (await store.getReport(draft.id))!;
  const pubSig = await operatorSign(h, op, 'testing.publish_report', {
    report_id: row.id, order_id: orderId, report_version: row.version, source_hash: row.source_hash,
  });
  await h.post(`/v1/owner/admin/testing/reports/${row.id}/publish`, { source_hash: row.source_hash, ...pubSig }, op.cookie);
  await shoot(buyer.cookie, `${C}/testing/reports/${row.id}`, 'console-report.png');

  await browser.close();
  apiServer.close();
  consoleServer.close();
  webServer.close();
  h.teardown();
  console.log('done.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
