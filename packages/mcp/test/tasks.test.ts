/**
 * Task marketplace MCP tests (Tasks P0 spec §8 "MCP stdio", §11).
 *
 * Both halves drive the REAL stdio server (src/index.ts via tsx) through the
 * MCP SDK client, like board-and-messaging.test.ts:
 *
 *  1. Against the api workspace's Hono app served over HTTP — the unpaid
 *     lifecycle end to end (create → claim → deliver → revision → re-deliver →
 *     dispute → cancel; create → claim → deliver → accept), and the bounty path
 *     with a fake facilitator injected through the api's own
 *     setPaymentProviderForTests: creation stores atomic units, claim needs a
 *     wallet, and accept without a signature yields the x402 402 handshake
 *     (which never calls the facilitator — it only has to exist).
 *
 *  2. Against a recording stub API (node:http, canned responses) — the wire
 *     contract of each tool that the real app cannot pin deterministically:
 *     exact path, exact JSON body, the PAYMENT-SIGNATURE header (present on
 *     accept, absent on create), and the 400/402/403/409/503 → readable
 *     isError mapping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { etc } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

etc.sha512Sync = (...m: Parameters<typeof sha512>) => sha512(...m);

import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  bytesToHex,
  setPaymentProviderForTests,
} from './api-harness.js';
import type { SQLiteAdapter, TestKeypair, Facilitator } from './api-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

interface TextResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function spawnMcpClient(kp: TestKeypair, apiUrl: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [require_.resolve('tsx/cli'), join(__dirname, '..', 'src', 'index.ts')],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined)
      ) as Record<string, string>),
      BASEDAGENTS_API_URL: apiUrl,
      BASEDAGENTS_AGENT_ID: kp.agentId,
      BASEDAGENTS_PRIVATE_KEY_HEX: bytesToHex(kp.privateKey),
      BASEDAGENTS_PUBLIC_KEY_B58: kp.publicKeyB58,
    },
  });
  const client = new Client({ name: 'mcp-tasks-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<TextResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as TextResult;
}

function text(res: TextResult): string {
  return res.content.map((c) => c.text).join('\n');
}

function extract(res: TextResult, re: RegExp): string {
  const m = text(res).match(re);
  expect(m, `expected ${re} in:\n${text(res)}`).not.toBeNull();
  return m![1];
}

/** The JSON fenced block a tool embeds (the 402 PaymentRequired, requirements). */
function jsonBlock(res: TextResult): Record<string, unknown> {
  const m = text(res).match(/```json\n([\s\S]*?)\n```/);
  expect(m, `expected a json block in:\n${text(res)}`).not.toBeNull();
  return JSON.parse(m![1]) as Record<string, unknown>;
}

const TASK_ID = /\*\*Task ID:\*\* `(task_[0-9A-Za-z]+)`/;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Real API
// ═══════════════════════════════════════════════════════════════════════════

/** Exists so bounty tasks can be created; these tests never reach verify/settle. */
const fakeFacilitator: Facilitator = {
  verify: async () => { throw new Error('the facilitator must not be reached by these tests'); },
  settle: async () => { throw new Error('the facilitator must not be reached by these tests'); },
  supported: async () => ({}),
};

describe('task marketplace against the real API', () => {
  let db: SQLiteAdapter;
  let httpServer: ServerType;
  let apiUrl: string;
  let creator: TestKeypair & { name: string };
  let worker: TestKeypair & { name: string };
  let clientA: Client; // creator
  let clientB: Client; // deliverer

  beforeAll(async () => {
    db = setupTestDb();
    const app = createTestApp(db);
    const port = await new Promise<number>((resolve) => {
      httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
    });
    apiUrl = `http://127.0.0.1:${port}`;
    creator = await createTestAgent(db, { name: 'TaskCreatorA' });
    worker = await createTestAgent(db, { name: 'TaskWorkerB' });
    clientA = await spawnMcpClient(creator, apiUrl);
    clientB = await spawnMcpClient(worker, apiUrl);
  });

  afterAll(async () => {
    setPaymentProviderForTests(undefined);
    await clientA?.close();
    await clientB?.close();
    httpServer?.close();
  });

  describe('unpaid lifecycle: revision → re-delivery → dispute → cancel', () => {
    let taskId: string;

    it('create_task without a bounty is open with payment_status none', async () => {
      const res = await call(clientA, 'create_task', {
        title: 'Write the parser',
        description: 'A tokenizer for the config language.',
        category: 'code',
        required_capabilities: ['code-generation'],
      });
      expect(res.isError ?? false, text(res)).toBe(false);
      taskId = extract(res, TASK_ID);
      expect(text(res)).toContain('**Status:** open');
      expect(text(res)).toContain('**Payment status:** none');
      expect(text(res)).not.toContain('Bounty');
    });

    it('browse_tasks and get_task show the creator, the (missing) bounty and the review state', async () => {
      const list = await call(clientB, 'browse_tasks');
      expect(text(list)).toContain(`(\`${taskId}\`) — open | code | by **TaskCreatorA** (\`${creator.agentId}\`) | no bounty | needs: code-generation`);

      const detail = await call(clientB, 'get_task', { task_id: taskId });
      const body = text(detail);
      expect(body).toContain(`**Creator:** **TaskCreatorA** (\`${creator.agentId}\`)`);
      expect(body).not.toContain('[✓ certified]'); // nobody is certified on an OSS-shaped DB
      expect(body).toContain('**Bounty:** none  |  **Payment:** none');
      expect(body).toContain('**Revisions:** 0/3');
      expect(body).not.toContain('### Payment'); // no bounty → no payment record
      expect(body).not.toContain('undefined');
    });

    it('claiming your own task is refused with the readable 400 mapping', async () => {
      const res = await call(clientA, 'claim_task', { task_id: taskId });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('**Rejected (bad_request)** — could not claim the task.');
      expect(text(res)).toContain('Cannot claim your own task');
    });

    it('the deliverer claims and delivers', async () => {
      const claim = await call(clientB, 'claim_task', { task_id: taskId });
      expect(claim.isError ?? false, text(claim)).toBe(false);
      expect(text(claim)).toContain('**Status:** claimed');

      const deliver = await call(clientB, 'submit_deliverable', {
        task_id: taskId,
        summary: 'v1 of the parser',
        submission_type: 'link',
        submission_content: 'https://example.com/parser/v1',
      });
      expect(deliver.isError ?? false, text(deliver)).toBe(false);
      expect(text(deliver)).toContain('**Status:** submitted');
      expect(text(deliver)).not.toContain('Revision rounds so far');
    });

    it('only the creator may request changes (403 mapping)', async () => {
      const res = await call(clientB, 'request_revision', { task_id: taskId, note: 'nope' });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('**Not allowed (forbidden)** — could not request changes.');
      expect(text(res)).toContain('Only the task creator can request changes');
    });

    it('request_revision sends the task back as claimed (revision_requested) and counts the round', async () => {
      const res = await call(clientA, 'request_revision', { task_id: taskId, note: 'Please add tests.' });
      expect(res.isError ?? false, text(res)).toBe(false);
      expect(text(res)).toContain('Changes requested');
      expect(text(res)).toContain('**Status:** claimed (revision_requested)');
      expect(text(res)).toContain('**Revision rounds used:** 1/3');

      const list = await call(clientB, 'browse_tasks', { status: 'claimed', claimer: worker.agentId });
      expect(text(list)).toContain(`(\`${taskId}\`) — claimed (revision_requested) | code |`);
      expect(text(list)).toContain('| revisions: 1 |');

      const detail = await call(clientB, 'get_task', { task_id: taskId });
      expect(text(detail)).toContain('**Status:** claimed (revision_requested)');
      expect(text(detail)).toContain('**Review note:** Please add tests.');
      expect(text(detail)).toContain('**Revisions:** 1/3');
    });

    it('re-delivery writes a second receipt; get_task shows the latest of 2', async () => {
      const deliver = await call(clientB, 'submit_deliverable', {
        task_id: taskId,
        summary: 'v2 of the parser, with tests',
        submission_type: 'link',
        submission_content: 'https://example.com/parser/v2',
      });
      expect(deliver.isError ?? false, text(deliver)).toBe(false);
      expect(text(deliver)).toContain('**Revision rounds so far:** 1/3');

      const detail = await call(clientA, 'get_task', { task_id: taskId });
      const body = text(detail);
      expect(body).toContain('### Submission');
      expect(body).toContain('**Summary:** v2 of the parser, with tests');
      expect(body).toContain('### Delivery receipt (latest of 2)');
      expect(body).toContain('**Content:** https://example.com/parser/v2');
      expect(body).toMatch(/\*\*Sequence:\*\* #\d+/);
    });

    it('cancel before dispute is refused with dispute_first (409 mapping, row state included)', async () => {
      const res = await call(clientA, 'cancel_task', { task_id: taskId });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('**Conflict (dispute_first)** — could not cancel the task.');
      expect(text(res)).toContain('- status: submitted');
      expect(text(res)).toContain('- payment_status: none');
    });

    it('dispute_task freezes the task as submitted (disputed); a second dispute is a 409', async () => {
      const res = await call(clientA, 'dispute_task', { task_id: taskId, reason: 'Tests are failing.' });
      expect(res.isError ?? false, text(res)).toBe(false);
      expect(text(res)).toContain('Deliverable disputed');
      expect(text(res)).toContain('**Status:** submitted (disputed)');
      expect(text(res)).toContain('**Payment status:** none');

      const again = await call(clientA, 'dispute_task', { task_id: taskId, reason: 'still' });
      expect(again.isError).toBe(true);
      expect(text(again)).toContain('**Conflict (already_disputed)**');
    });

    it('cancel_task after the dispute succeeds', async () => {
      const res = await call(clientA, 'cancel_task', { task_id: taskId });
      expect(res.isError ?? false, text(res)).toBe(false);
      expect(text(res)).toContain('Task cancelled.');
      expect(text(res)).toContain('**Status:** cancelled');
      expect(text(res)).toContain('**Payment status:** none');
    });

    it('get_task_payment on an unpaid task explains there is nothing to pay', async () => {
      const res = await call(clientB, 'get_task_payment', { task_id: taskId });
      expect(res.isError ?? false, text(res)).toBe(false);
      expect(text(res)).toContain('**Bounty:** none  |  **Status:** none');
      expect(text(res)).toContain('this task has no bounty');
    });
  });

  describe('unpaid lifecycle: accept', () => {
    let taskId: string;

    it('create → claim → deliver', async () => {
      const created = await call(clientA, 'create_task', { title: 'Summarize the RFC', description: 'Two paragraphs.', category: 'research' });
      taskId = extract(created, TASK_ID);
      expect((await call(clientB, 'claim_task', { task_id: taskId })).isError ?? false).toBe(false);
      const delivered = await call(clientB, 'submit_deliverable', { task_id: taskId, summary: 'done', submission_type: 'json', submission_content: '{"summary":"..."}' });
      expect(delivered.isError ?? false, text(delivered)).toBe(false);
    });

    it('the deliverer cannot accept their own work (403 mapping)', async () => {
      const res = await call(clientB, 'accept_deliverable', { task_id: taskId });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('**Not allowed (forbidden)** — could not accept the deliverable.');
    });

    it('accept_deliverable on an unpaid task accepts immediately, anchored to the chain', async () => {
      const res = await call(clientA, 'accept_deliverable', { task_id: taskId, note: 'Great summary.' });
      expect(res.isError ?? false, text(res)).toBe(false);
      const body = text(res);
      expect(body).toContain('Deliverable accepted.');
      expect(body).toContain('**Status:** verified');
      expect(body).toContain('**Accepted by:** creator');
      expect(body).toContain('**Payment status:** none');
      expect(body).toMatch(/\*\*Chain entry:\*\* #\d+ `[0-9a-f]{64}`/);

      // Idempotent re-accept.
      const again = await call(clientA, 'accept_deliverable', { task_id: taskId });
      expect(again.isError ?? false, text(again)).toBe(false);
      expect(text(again)).toContain('**Status:** verified');

      const detail = await call(clientB, 'get_task', { task_id: taskId });
      expect(text(detail)).toContain('**Revisions:** 0/3  |  **Accepted by:** creator');
      expect(text(detail)).toContain('**Review note:** Great summary.');
    });

    it('get_reputation reports the task-derived counts for the deliverer', async () => {
      // One accepted delivery (above) and one disputed-then-cancelled (first block).
      const res = await call(clientA, 'get_reputation', { agent_id: worker.agentId });
      expect(res.isError ?? false, text(res)).toBe(false);
      expect(text(res)).toContain('**Tasks:** accepted 1 / failed 1');
      expect(text(res)).toMatch(/\| Tasks {9}\| \d+% \|/);
    });
  });

  describe('bounty task with payments enabled (fake facilitator)', () => {
    const wallet = '0x' + 'ab'.repeat(20);
    let taskId: string;

    beforeAll(() => setPaymentProviderForTests(fakeFacilitator));

    it('create_task with bounty {amount_usdc} stores atomic units and payment_status pending', async () => {
      const res = await call(clientA, 'create_task', {
        title: 'Paid: audit the contract',
        description: 'Report findings.',
        category: 'code',
        bounty: { amount_usdc: '5.00', network: 'eip155:84532' },
      });
      expect(res.isError ?? false, text(res)).toBe(false);
      taskId = extract(res, TASK_ID);
      expect(text(res)).toContain('**Payment status:** pending');
      expect(text(res)).toContain('**Bounty:** 5.00 USDC on eip155:84532');
      expect(text(res)).toContain('Nothing has been charged');

      const row = await db.get<{ bounty_amount: string; bounty_token: string; bounty_network: string; payment_status: string }>(
        'SELECT bounty_amount, bounty_token, bounty_network, payment_status FROM tasks WHERE task_id = ?', taskId,
      );
      expect(row).toEqual({ bounty_amount: '5000000', bounty_token: 'USDC', bounty_network: 'eip155:84532', payment_status: 'pending' });
    });

    it('a malformed bounty amount is rejected locally — no task is created', async () => {
      const before = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks'))!.n;
      const res = await call(clientA, 'create_task', { title: 'x', description: 'y', bounty: { amount_usdc: '0.1234567' } });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('**Invalid bounty**');
      expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks'))!.n).toBe(before);
    });

    it('claiming a bounty task without a wallet is refused (409 wallet_required, with the help block)', async () => {
      const res = await call(clientB, 'claim_task', { task_id: taskId });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('**Conflict (wallet_required)** — could not claim the task.');
      expect(text(res)).toContain(`Help: {"set_wallet":"PATCH /v1/agents/${worker.agentId}/wallet"`);
    });

    it('with a wallet the claim succeeds and the list shows the bounty + payment state', async () => {
      await db.run('UPDATE agents SET wallet_address = ?, wallet_network = ? WHERE id = ?', wallet, 'eip155:84532', worker.agentId);
      const claim = await call(clientB, 'claim_task', { task_id: taskId });
      expect(claim.isError ?? false, text(claim)).toBe(false);

      const list = await call(clientB, 'browse_tasks', { status: 'claimed', creator: creator.agentId });
      expect(text(list)).toContain(`(\`${taskId}\`) — claimed | code | by **TaskCreatorA** (\`${creator.agentId}\`) | 5.00 USDC · payment pending`);

      const delivered = await call(clientB, 'submit_deliverable', { task_id: taskId, summary: 'audit report', submission_type: 'link', submission_content: 'https://example.com/audit' });
      expect(delivered.isError ?? false, text(delivered)).toBe(false);
    });

    it('accept_deliverable without a signature returns the real 402 PaymentRequired as text (not an error)', async () => {
      const res = await call(clientA, 'accept_deliverable', { task_id: taskId });
      expect(res.isError ?? false, text(res)).toBe(false);
      expect(text(res)).toContain('**Payment required** — nothing was accepted yet.');
      expect(text(res)).toContain('bounty of 5.00 USDC');
      expect(text(res)).toContain(`PAYMENT-SIGNATURE header to POST /v1/tasks/${taskId}/accept`);

      const pr = jsonBlock(res);
      expect(pr.error).toBe('payment_required');
      expect(pr.x402Version).toBe(2);
      expect(pr.task_id).toBe(taskId);
      expect(pr.payment_header).toBe('PAYMENT-SIGNATURE');
      const accepts = pr.accepts as Array<Record<string, unknown>>;
      expect(accepts).toHaveLength(1);
      expect(accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:84532', amount: '5000000', payTo: wallet, maxTimeoutSeconds: 3600 });
      expect((pr.resource as { url: string }).url).toContain(`/v1/tasks/${taskId}/accept`);

      // Nothing moved.
      const row = await db.get<{ status: string; payment_status: string }>('SELECT status, payment_status FROM tasks WHERE task_id = ?', taskId);
      expect(row).toEqual({ status: 'submitted', payment_status: 'pending' });
    });

    it('a signature the API cannot decode maps to Rejected (payment_malformed) with the detail', async () => {
      const res = await call(clientA, 'accept_deliverable', { task_id: taskId, payment_signature: 'this is not an x402 payload' });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('**Rejected (payment_malformed)** — could not accept the deliverable.');
      expect(text(res)).toMatch(/- detail: .+/);
    });

    it('get_task_payment renders the record, the x402 requirements and the audit trail', async () => {
      const res = await call(clientB, 'get_task_payment', { task_id: taskId });
      expect(res.isError ?? false, text(res)).toBe(false);
      const body = text(res);
      expect(body).toContain('**Bounty:** 5.00 USDC on eip155:84532  |  **Status:** pending');
      expect(body).toContain(`**Pay to:** \`${wallet}\``);
      expect(body).toContain('### x402 requirements');
      expect(body).toContain('`accept_deliverable`');
      expect(body).toMatch(/### Events\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC {2}bounty_declared {2}\{"amount_atomic":"5000000"/);
      const pr = jsonBlock(res);
      expect((pr.accepts as Array<Record<string, unknown>>)[0].amount).toBe('5000000');

      const detail = await call(clientB, 'get_task', { task_id: taskId });
      expect(text(detail)).toContain('**Bounty:** 5.00 USDC on eip155:84532  |  **Payment:** pending');
      expect(text(detail)).toContain('### Payment');
      expect(text(detail)).toMatch(/\*\*Auto-accepts at:\*\* \d{4}-.+ \(7-day review window\)/);
    });

    it('with payments disabled the paid paths answer Unavailable (503 mapping)', async () => {
      setPaymentProviderForTests(null);
      const accept = await call(clientA, 'accept_deliverable', { task_id: taskId });
      expect(accept.isError).toBe(true);
      expect(text(accept)).toContain('**Unavailable (payments_unavailable)** — could not accept the deliverable.');

      const create = await call(clientA, 'create_task', { title: 'p', description: 'q', bounty: { amount_usdc: '1' } });
      expect(create.isError).toBe(true);
      expect(text(create)).toContain('**Unavailable (payments_unavailable)** — could not create the task.');
      expect(text(create)).toContain('Bounties are not enabled on this registry yet');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Recording stub API — the exact wire contract
// ═══════════════════════════════════════════════════════════════════════════

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

class StubApi {
  readonly requests: Recorded[] = [];
  private canned = new Map<string, { status: number; body: unknown }>();
  private server: Server | null = null;
  url = '';

  respond(method: string, path: string, status: number, body: unknown): void {
    this.canned.set(`${method} ${path}`, { status, body });
  }

  last(): Recorded {
    return this.requests[this.requests.length - 1];
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf-8'); });
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://stub').pathname;
      let body: unknown = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      this.requests.push({ method: req.method ?? '', path, headers: req.headers, body });
      const hit = this.canned.get(`${req.method} ${path}`);
      res.writeHead(hit?.status ?? 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hit?.body ?? { error: 'not_found', message: `no canned response for ${req.method} ${path}` }));
    });
  }
}

const BOUNTY = { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:84532' };
const PAYMENT_REQUIRED = {
  error: 'payment_required',
  message: "Sign an EIP-3009 USDC transfer of 5.00 USDC to the deliverer's wallet and retry with the PAYMENT-SIGNATURE header.",
  x402Version: 2,
  resource: { url: 'https://api.basedagents.ai/v1/tasks/task_stub/accept', description: 'BasedAgents task task_stub bounty', mimeType: 'application/json' },
  accepts: [{
    scheme: 'exact', network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '5000000',
    payTo: '0x' + 'cd'.repeat(20), maxTimeoutSeconds: 3600, extra: { name: 'USDC', version: '2' },
  }],
  task_id: 'task_stub',
  bounty: BOUNTY,
  accept_endpoint: 'POST /v1/tasks/task_stub/accept',
  payment_header: 'PAYMENT-SIGNATURE',
};

describe('task tools — wire contract against a recording stub API', () => {
  const stub = new StubApi();
  let kp: TestKeypair;
  let client: Client;

  beforeAll(async () => {
    await stub.start();
    // Only the keypair is needed (the stub does not verify signatures).
    kp = await createTestAgent(setupTestDb(), { name: 'StubAgent' });
    client = await spawnMcpClient(kp, stub.url);
  });

  afterAll(async () => {
    await client?.close();
    await stub.stop();
  });

  it('create_task with a bounty sends the atomic amount, token and network — and no payment header', async () => {
    stub.respond('POST', '/v1/tasks', 200, { ok: true, task_id: 'task_stub', status: 'open', payment_status: 'pending', bounty: BOUNTY });
    const res = await call(client, 'create_task', {
      title: 'Paid task', description: 'desc', category: 'data', expected_output: 'a CSV', output_format: 'link',
      bounty: { amount_usdc: '5.00', network: 'eip155:84532' },
    });
    expect(res.isError ?? false, text(res)).toBe(false);

    const req = stub.last();
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/tasks');
    expect(req.body).toEqual({
      title: 'Paid task', description: 'desc', category: 'data', expected_output: 'a CSV', output_format: 'link',
      bounty: { amount: '5000000', token: 'USDC', network: 'eip155:84532' },
    });
    expect(req.headers['payment-signature']).toBeUndefined();
    expect(req.headers['x-payment-signature']).toBeUndefined();
    expect(String(req.headers.authorization)).toMatch(/^AgentSig /);
    expect(req.headers['x-nonce']).toBeTruthy();
    expect(text(res)).toContain('**Payment status:** pending');
    expect(text(res)).toContain('**Bounty:** 5.00 USDC on eip155:84532');
  });

  it('create_task without a network defaults the bounty to Base mainnet; fractional amounts convert exactly', async () => {
    stub.respond('POST', '/v1/tasks', 200, { ok: true, task_id: 'task_stub', status: 'open', payment_status: 'pending' });
    const res = await call(client, 'create_task', { title: 't', description: 'd', bounty: { amount_usdc: '0.5' } });
    expect(res.isError ?? false, text(res)).toBe(false);
    expect((stub.last().body as { bounty: unknown }).bounty).toEqual({ amount: '500000', token: 'USDC', network: 'eip155:8453' });
  });

  it('create_task without a bounty sends no bounty key at all', async () => {
    stub.respond('POST', '/v1/tasks', 200, { ok: true, task_id: 'task_stub', status: 'open', payment_status: 'none' });
    await call(client, 'create_task', { title: 't', description: 'd' });
    expect(stub.last().body).toEqual({ title: 't', description: 'd' });
  });

  it('create_task rejects an over-limit bounty locally (nothing is sent)', async () => {
    const before = stub.requests.length;
    const res = await call(client, 'create_task', { title: 't', description: 'd', bounty: { amount_usdc: '1000.01' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('exceeds the 1000 USDC maximum');
    expect(stub.requests.length).toBe(before);
  });

  it('accept_deliverable on a 402 payment_required returns the PaymentRequired JSON as text', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/accept', 402, PAYMENT_REQUIRED);
    const res = await call(client, 'accept_deliverable', { task_id: 'task_stub' });
    expect(res.isError ?? false).toBe(false);

    const req = stub.last();
    expect(req.path).toBe('/v1/tasks/task_stub/accept');
    expect(req.body).toEqual({});
    expect(req.headers['payment-signature']).toBeUndefined();

    expect(text(res)).toContain('**Payment required** — nothing was accepted yet.');
    expect(text(res)).toContain('call `accept_deliverable` again with it as `payment_signature`');
    expect(jsonBlock(res)).toEqual(PAYMENT_REQUIRED); // verbatim, so any x402 signer can consume it
  });

  it('accept_deliverable with payment_signature sends it as the PAYMENT-SIGNATURE header, plus the note', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/accept', 200, {
      ok: true, task_id: 'task_stub', status: 'verified', accepted_by: 'creator', payment_status: 'settled',
      payment_tx_hash: '0xfeed', chain_sequence: 42, chain_entry_hash: 'ab'.repeat(32),
    });
    const res = await call(client, 'accept_deliverable', { task_id: 'task_stub', note: 'ship it', payment_signature: 'eyJ4NDAyVmVyc2lvbiI6Mn0' });
    expect(res.isError ?? false, text(res)).toBe(false);

    const req = stub.last();
    expect(req.headers['payment-signature']).toBe('eyJ4NDAyVmVyc2lvbiI6Mn0');
    expect(req.body).toEqual({ note: 'ship it' });
    // The auth headers are still the signed ones — the extra header never shadows them.
    expect(String(req.headers.authorization)).toMatch(/^AgentSig /);

    const body = text(res);
    expect(body).toContain('Deliverable accepted.');
    expect(body).toContain('**Payment status:** settled');
    expect(body).toContain('**Tx hash:** `0xfeed`');
    expect(body).toContain(`**Chain entry:** #42 \`${'ab'.repeat(32)}\``);
    expect(body).toContain('The bounty has been paid');
  });

  it('accept_deliverable surfaces a settle failure and the retry hint', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/accept', 200, {
      ok: true, task_id: 'task_stub', status: 'verified', accepted_by: 'creator', payment_status: 'failed',
      settle_error: 'facilitator: rate_limited', chain_sequence: null, chain_entry_hash: null,
    });
    const res = await call(client, 'accept_deliverable', { task_id: 'task_stub', payment_signature: 'sig' });
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).toContain('**Payment status:** failed');
    expect(text(res)).toContain('**Settle error:** facilitator: rate_limited');
    expect(text(res)).not.toContain('Chain entry');
    expect(text(res)).toContain('retried automatically');
  });

  it('accept_deliverable maps 402 payment_invalid (precheck) to an error with reason/expected/got', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/accept', 402, {
      error: 'payment_invalid', reason: 'amount_mismatch', expected: '5000000', got: '4000000',
      message: "The signed authorization does not match this task's payment requirements.",
    });
    const res = await call(client, 'accept_deliverable', { task_id: 'task_stub', payment_signature: 'sig' });
    expect(res.isError).toBe(true);
    const body = text(res);
    expect(body).toContain('**Payment problem (payment_invalid)** — could not accept the deliverable.');
    expect(body).toContain('- reason: amount_mismatch');
    expect(body).toContain('- expected: 5000000');
    expect(body).toContain('- got: 4000000');
  });

  it('accept_deliverable maps 409 settlement_in_progress and 503 facilitator_unavailable', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/accept', 409, { error: 'settlement_in_progress', message: 'A previous authorization for this task is still being settled.', payment_status: 'settling' });
    const conflict = await call(client, 'accept_deliverable', { task_id: 'task_stub', payment_signature: 'sig' });
    expect(conflict.isError).toBe(true);
    expect(text(conflict)).toContain('**Conflict (settlement_in_progress)**');
    expect(text(conflict)).toContain('- payment_status: settling');

    stub.respond('POST', '/v1/tasks/task_stub/accept', 503, { error: 'facilitator_unavailable', cause: 'network', message: 'The payment facilitator is unavailable; retry shortly.' });
    const down = await call(client, 'accept_deliverable', { task_id: 'task_stub', payment_signature: 'sig' });
    expect(down.isError).toBe(true);
    expect(text(down)).toContain('**Unavailable (facilitator_unavailable)**');
    expect(text(down)).toContain('- cause: network');
  });

  it('request_revision posts {note} to /revision and renders the round count', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/revision', 200, { ok: true, task_id: 'task_stub', status: 'claimed', review_state: 'revision_requested', revision_count: 2 });
    const res = await call(client, 'request_revision', { task_id: 'task_stub', note: 'Fix the edge cases.' });
    expect(res.isError ?? false, text(res)).toBe(false);
    expect(stub.last().path).toBe('/v1/tasks/task_stub/revision');
    expect(stub.last().body).toEqual({ note: 'Fix the edge cases.' });
    expect(text(res)).toContain('**Status:** claimed (revision_requested)');
    expect(text(res)).toContain('**Revision rounds used:** 2/3');
  });

  it('request_revision maps 409 max_revisions and 409 invalid_state', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/revision', 409, { error: 'max_revisions', message: 'This task already had 3 revision rounds; accept, dispute or cancel it.' });
    const capped = await call(client, 'request_revision', { task_id: 'task_stub', note: 'again' });
    expect(capped.isError).toBe(true);
    expect(text(capped)).toContain('**Conflict (max_revisions)** — could not request changes.');
    expect(text(capped)).toContain('accept, dispute or cancel it');

    stub.respond('POST', '/v1/tasks/task_stub/revision', 409, { error: 'invalid_state', message: 'Only a submitted task can be sent back for changes', status: 'claimed' });
    const state = await call(client, 'request_revision', { task_id: 'task_stub', note: 'again' });
    expect(text(state)).toContain('**Conflict (invalid_state)**');
    expect(text(state)).toContain('- status: claimed');
  });

  it('dispute_task posts {reason} to /dispute', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/dispute', 200, { ok: true, task_id: 'task_stub', status: 'submitted', review_state: 'disputed', disputed_at: '2026-09-08T10:00:00.000Z', payment_status: 'pending' });
    const res = await call(client, 'dispute_task', { task_id: 'task_stub', reason: 'Not what was asked.' });
    expect(res.isError ?? false, text(res)).toBe(false);
    expect(stub.last().path).toBe('/v1/tasks/task_stub/dispute');
    expect(stub.last().body).toEqual({ reason: 'Not what was asked.' });
    expect(text(res)).toContain('**Status:** submitted (disputed)');
    expect(text(res)).toContain('**Disputed at:** 2026-09-08T10:00:00.000Z');
    expect(text(res)).toContain('**Payment status:** pending');
  });

  it('accept_deliverable and dispute_task send an optional rating (D11); a comment without a rating is refused locally', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/accept', 200, { ok: true, task_id: 'task_stub', status: 'verified', accepted_by: 'creator', payment_status: 'none', rating: 5 });
    const ok = await call(client, 'accept_deliverable', { task_id: 'task_stub', rating: 5, rating_comment: 'Exact' });
    expect(stub.last().body).toEqual({ rating: 5, rating_comment: 'Exact' });
    expect(text(ok)).toContain('**Rating:** 5/5');

    stub.respond('POST', '/v1/tasks/task_stub/dispute', 200, { ok: true, task_id: 'task_stub', status: 'submitted', review_state: 'disputed', disputed_at: 'x', payment_status: 'none', rating: 2 });
    const disputed = await call(client, 'dispute_task', { task_id: 'task_stub', reason: 'Half done', rating: 2 });
    expect(stub.last().body).toEqual({ reason: 'Half done', rating: 2 });
    expect(text(disputed)).toContain('**Rating:** 2/5');

    const before = stub.requests.length;
    const refused = await call(client, 'accept_deliverable', { task_id: 'task_stub', rating_comment: 'no score' });
    expect(text(refused)).toContain('rating_comment needs a rating');
    expect(stub.requests.length).toBe(before);
    const outOfRange = await call(client, 'accept_deliverable', { task_id: 'task_stub', rating: 6 });
    expect(outOfRange.isError).toBe(true);
    expect(stub.requests.length).toBe(before);
  });

  it('cancel_task posts to /cancel and maps the refusal matrix', async () => {
    stub.respond('POST', '/v1/tasks/task_stub/cancel', 409, { error: 'payment_in_flight', message: 'A payment is authorized or settling for this task; it cannot be cancelled', status: 'verified', payment_status: 'authorized' });
    const refused = await call(client, 'cancel_task', { task_id: 'task_stub' });
    expect(refused.isError).toBe(true);
    expect(stub.last().path).toBe('/v1/tasks/task_stub/cancel');
    expect(text(refused)).toContain('**Conflict (payment_in_flight)** — could not cancel the task.');
    expect(text(refused)).toContain('- payment_status: authorized');

    stub.respond('POST', '/v1/tasks/task_stub/cancel', 200, { ok: true, task_id: 'task_stub', status: 'cancelled', payment_status: 'expired' });
    const ok = await call(client, 'cancel_task', { task_id: 'task_stub' });
    expect(ok.isError ?? false).toBe(false);
    expect(text(ok)).toContain('**Status:** cancelled');
    expect(text(ok)).toContain('**Payment status:** expired'); // a never-paid bounty is voided
  });

  it('get_task_payment reads /payment unsigned and renders requirements, unavailable reasons and events', async () => {
    const payment = {
      task_id: 'task_stub', bounty: BOUNTY, status: 'pending', verified: false, settled: false, tx_hash: null, settled_at: null,
      expires_at: null, auto_release_at: null, accepted_by: null, payer: null, last_error: null, settle_attempts: 0, next_settle_at: null,
      payment_due: false, pay_to: '0x' + 'cd'.repeat(20),
    };
    stub.respond('GET', '/v1/tasks/task_stub/payment', 200, {
      ok: true, payment, requirements: PAYMENT_REQUIRED.accepts[0], payment_required: { x402Version: 2, resource: PAYMENT_REQUIRED.resource, accepts: PAYMENT_REQUIRED.accepts },
      accept_endpoint: 'POST /v1/tasks/task_stub/accept', payment_header: 'PAYMENT-SIGNATURE',
      events: [{ id: 'pev_1', event_type: 'bounty_declared', details: { amount_atomic: '5000000' }, created_at: '2026-09-08T09:00:00.000Z' }],
    });
    const res = await call(client, 'get_task_payment', { task_id: 'task_stub' });
    expect(res.isError ?? false, text(res)).toBe(false);
    expect(stub.last().method).toBe('GET');
    expect(stub.last().headers.authorization).toBeUndefined(); // public read
    const body = text(res);
    expect(body).toContain('**Bounty:** 5.00 USDC on eip155:84532  |  **Status:** pending');
    expect(body).toContain(`**Pay to:** \`${'0x' + 'cd'.repeat(20)}\``);
    expect(body).toContain('### x402 requirements');
    expect((jsonBlock(res).accepts as unknown[])).toHaveLength(1);
    expect(body).toContain('- 2026-09-08 09:00:00 UTC  bounty_declared  {"amount_atomic":"5000000"}');

    stub.respond('GET', '/v1/tasks/task_stub/payment', 200, {
      ok: true, payment: { ...payment, pay_to: null }, requirements: null, requirements_unavailable_reason: 'payee_wallet_missing',
      accept_endpoint: 'POST /v1/tasks/task_stub/accept', payment_header: 'PAYMENT-SIGNATURE', events: [],
    });
    const missing = await call(client, 'get_task_payment', { task_id: 'task_stub' });
    expect(text(missing)).toContain('**Requirements unavailable:** the deliverer has no wallet on record');
    expect(text(missing)).not.toContain('### Events');
  });

  it('a settled payment record shows payer, tx and settlement time; payment_due is called out', async () => {
    stub.respond('GET', '/v1/tasks/task_stub/payment', 200, {
      ok: true,
      payment: {
        task_id: 'task_stub', bounty: BOUNTY, status: 'settled', verified: true, settled: true, tx_hash: '0xabc', settled_at: '2026-09-08T11:00:00.000Z',
        expires_at: '2026-09-08T12:00:00.000Z', auto_release_at: null, accepted_by: 'creator', payer: '0x' + '11'.repeat(20), last_error: null,
        settle_attempts: 1, next_settle_at: null, payment_due: false, pay_to: '0x' + 'cd'.repeat(20),
      },
      requirements: null, requirements_unavailable_reason: 'not_claimed', accept_endpoint: 'POST /v1/tasks/task_stub/accept', payment_header: 'PAYMENT-SIGNATURE', events: [],
    });
    const res = await call(client, 'get_task_payment', { task_id: 'task_stub' });
    const body = text(res);
    expect(body).toContain('**Status:** settled');
    expect(body).toContain('**Verified:** yes  |  **Settled:** yes  |  **Settle attempts:** 1');
    expect(body).toContain('**Tx hash:** `0xabc`');
    expect(body).toContain('**Settled at:** 2026-09-08T11:00:00.000Z');

    stub.respond('GET', '/v1/tasks/task_stub/payment', 200, {
      ok: true,
      payment: { task_id: 'task_stub', bounty: BOUNTY, status: 'pending', verified: false, settled: false, accepted_by: 'auto', payment_due: true, settle_attempts: 0 },
      requirements: null, requirements_unavailable_reason: 'not_claimed', accept_endpoint: 'POST /v1/tasks/task_stub/accept', payment_header: 'PAYMENT-SIGNATURE', events: [],
    });
    const due = await call(client, 'get_task_payment', { task_id: 'task_stub' });
    expect(text(due)).toContain('**Status:** pending (payment due — the work is accepted but the bounty is not yet authorized)');
  });

  it('a 404 on any task tool is a readable Not found result', async () => {
    const res = await call(client, 'get_task_payment', { task_id: 'task_missing' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('**Not found (not_found)** — could not read the payment status.');
  });

  it('a human-posted task renders the creator as a certified human without an agent id', async () => {
    stub.respond('GET', '/v1/tasks', 200, {
      ok: true,
      tasks: [{
        task_id: 'task_h', title: 'From a person', status: 'open', category: null, required_capabilities: null,
        creator: { kind: 'owner', id: null, short_id: null, name: '✓ Max', cert: 'certified_human' },
        bounty: null, payment_status: 'none', review_state: null, revision_count: 0,
      }],
    });
    const res = await call(client, 'browse_tasks', {});
    // The check-mark in the display name is stripped so it cannot forge the badge.
    expect(text(res)).toContain('- **From a person** (`task_h`) — open | uncategorized | by [✓ certified] **Max** (human) | no bounty');
  });
});
