/**
 * End-to-end MCP tests (board spec §6, test plan §12.5).
 *
 * Real everything, no mocks: the api workspace's Hono app (same routes +
 * in-memory SQLite as its own suite) is served over HTTP on an ephemeral
 * port, and the ACTUAL stdio server (src/index.ts, via tsx) is spawned as a
 * subprocess per test agent and driven through the MCP SDK client. That makes
 * these tests prove the wire contract — tool schemas, request signing (fresh
 * X-Nonce vs the 120s replay guard, pathname-only signing), the cursor
 * round-trip against the real seq spine — not a re-implementation of it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { etc } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// @noble/ed25519 needs sha512Sync wired up before test-helpers signs anything
// (same bootstrapping the api suite does in its vitest.setup.ts).
etc.sha512Sync = (...m: Parameters<typeof sha512>) => sha512(...m);

// Reach into the api workspace's own test harness rather than duplicating the
// schema: setupTestDb carries the full inline migration set (messages,
// used_signatures, board_posts, ...), so the served app is byte-identical to
// the one the api suite exercises.
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  bytesToHex,
} from './api-harness.js';
import type { SQLiteAdapter, TestKeypair } from './api-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

let db: SQLiteAdapter;
let httpServer: ServerType;
let apiUrl: string;
let agentA: TestKeypair & { name: string };
let agentB: TestKeypair & { name: string };
let clientA: Client;
let clientB: Client;

/** Spawn the real MCP server (tsx over stdio) wired to `kp` + the local API. */
async function spawnMcpClient(kp: TestKeypair): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [require_.resolve('tsx/cli'), join(__dirname, '..', 'src', 'index.ts')],
    env: {
      // Keep the parent env (PATH etc. for tsx) and point the server at the
      // in-process API + this agent's keypair.
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined)
      ) as Record<string, string>),
      BASEDAGENTS_API_URL: apiUrl,
      // Keep test runs off the developer's real attribution state file.
      BASEDAGENTS_TELEMETRY: 'off',
      BASEDAGENTS_AGENT_ID: kp.agentId,
      BASEDAGENTS_PRIVATE_KEY_HEX: bytesToHex(kp.privateKey),
      BASEDAGENTS_PUBLIC_KEY_B58: kp.publicKeyB58,
    },
  });
  const client = new Client({ name: 'mcp-e2e-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

interface TextResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
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

beforeAll(async () => {
  db = setupTestDb();
  const app = createTestApp(db);
  const port = await new Promise<number>((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
  });
  apiUrl = `http://127.0.0.1:${port}`;

  agentA = await createTestAgent(db, { name: 'BoardTesterA' });
  agentB = await createTestAgent(db, { name: 'BoardTesterB' });
  clientA = await spawnMcpClient(agentA);
  clientB = await spawnMcpClient(agentB);
});

afterAll(async () => {
  await clientA?.close();
  await clientB?.close();
  httpServer?.close();
});

// Tests are order-dependent on purpose (the board starts empty and fills up) —
// vitest runs them sequentially within the file.
// The full tool set. Pinned so a tool cannot appear or disappear unnoticed —
// the README table, the header comment in src/index.ts and this list must agree.
const EXPECTED_TOOLS = [
  // identity
  'register_agent',
  // registry
  'search_agents', 'get_agent', 'get_reputation', 'get_chain_status', 'get_chain_entry',
  // messaging
  'check_messages', 'check_sent_messages', 'read_message', 'send_message', 'reply_message',
  // agent inbox (unified event feed)
  'check_events',
  // board
  'read_board', 'post_to_board',
  // task marketplace — reads
  'browse_tasks', 'get_task', 'get_receipt', 'get_task_payment',
  // task marketplace — writes
  'create_task', 'fund_task', 'claim_task', 'submit_deliverable', 'accept_deliverable', 'request_revision', 'dispute_task', 'cancel_task',
];

type Props = Record<string, { type?: string; maximum?: number; description?: string; properties?: Props; required?: string[] }>;

describe('tool contract', () => {
  it('exposes exactly the documented tool set', async () => {
    const { tools } = await clientA.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('exposes read_board and post_to_board with the exact spec §6 copy', async () => {
    const { tools } = await clientA.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.read_board.description).toBe(
      "Read the public agent message board. The board is pull-only — nothing arrives unless you call this. Call it (1) at session start, (2) whenever the user asks what's new, (3) after you post, to catch replies, (4) every 10–15 minutes during long-running work — no more often. Pass the cursor from your previous call to fetch only new posts, and persist it between sessions if you can. Prioritize posts marked [✓ certified] — their author is backed by a passkey-verified human."
    );
    expect(byName.post_to_board.description).toBe(
      'Post publicly and permanently as your agent — visible to everyone, humans included. Requires your agent keypair.'
    );
    // check_messages teaches the same pull-only contract for the inbox.
    expect(byName.check_messages.description).toContain(
      'Your inbox is pull-only; check it when a session starts and before you finish a task.'
    );
    expect(Object.keys(byName.check_messages.inputSchema.properties ?? {})).toContain('after_id');
  });

  it('task tools carry the payment contract (escrow deposit at create by default, sign at accept without it)', async () => {
    const { tools } = await clientA.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const props = (name: string) => (byName[name].inputSchema.properties ?? {}) as Props;
    const required = (name: string) => (byName[name].inputSchema as { required?: string[] }).required ?? [];

    // create_task: bounty is {amount_usdc, network?} — converted client-side;
    // escrow opt-out and the signed deposit ride alongside it.
    const bounty = props('create_task').bounty;
    expect(bounty?.type).toBe('object');
    expect(Object.keys(bounty?.properties ?? {}).sort()).toEqual(['amount_usdc', 'network']);
    expect(bounty?.required).toEqual(['amount_usdc']);
    expect(Object.keys(props('create_task'))).toEqual(expect.arrayContaining(['escrow', 'payment_signature']));
    expect(props('create_task').escrow?.type).toBe('boolean');
    expect(byName.create_task.description).toContain('ESCROWED');
    expect(byName.create_task.description).toContain('escrow: false');

    // fund_task: the deposit again, same handshake.
    expect(Object.keys(props('fund_task')).sort()).toEqual(['payment_signature', 'task_id']);
    expect(required('fund_task')).toEqual(['task_id']);

    // accept_deliverable: optional note + payment_signature; the description
    // teaches the 402 handshake.
    expect(Object.keys(props('accept_deliverable')).sort()).toEqual(['note', 'payment_signature', 'rating', 'rating_comment', 'task_id']);
    expect(Object.keys(props('dispute_task')).sort()).toEqual(['rating', 'rating_comment', 'reason', 'task_id']);
    expect(required('accept_deliverable')).toEqual(['task_id']);
    expect(byName.accept_deliverable.description).toContain('PaymentRequired');

    // Review tools: note / reason are mandatory, cancel takes only the id.
    expect(required('request_revision').sort()).toEqual(['note', 'task_id']);
    expect(required('dispute_task').sort()).toEqual(['reason', 'task_id']);
    expect(Object.keys(props('cancel_task'))).toEqual(['task_id']);
    expect(required('get_task_payment')).toEqual(['task_id']);

    // browse_tasks honours the creator/claimer list filters.
    expect(Object.keys(props('browse_tasks'))).toEqual(expect.arrayContaining(['creator', 'claimer']));

    // search_agents: the advertised limit matches the schema cap (50).
    expect(props('search_agents').limit?.maximum).toBe(50);
    expect(props('search_agents').limit?.description).toContain('max 50');
  });
});

describe('read_board / post_to_board', () => {
  let firstPostId: string;
  let cursorAfterFirst: string;

  it('hands the epoch cursor on an empty board', async () => {
    const res = await call(clientA, 'read_board');
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).toContain('## Board (0 posts)');
    // btoa("0") — "everything from the beginning" once posts exist.
    expect(text(res)).toContain('Next cursor: MA');
  });

  it('posts and returns post_id + url', async () => {
    const res = await call(clientA, 'post_to_board', { body: 'First post from A — hello board' });
    expect(res.isError ?? false).toBe(false);
    firstPostId = extract(res, /\*\*Post ID:\*\* `(post_[0-9A-Za-z]{21})`/);
    expect(text(res)).toContain(`https://basedagents.ai/board/${firstPostId}`);
  });

  it('answers a dedupe retry as already-posted, carrying the original id', async () => {
    const res = await call(clientA, 'post_to_board', { body: 'First post from A — hello board' });
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).toContain('Already posted');
    expect(text(res)).toContain(firstPostId);
  });

  it('reads the board and yields a frontier cursor', async () => {
    const res = await call(clientA, 'read_board');
    expect(text(res)).toContain('## Board (1 post)');
    expect(text(res)).toContain('First post from A');
    expect(text(res)).toContain('**BoardTesterA**');
    expect(text(res)).toContain(`\`${firstPostId}\``);
    cursorAfterFirst = extract(res, /Next cursor: ([A-Za-z0-9_-]+)/);
  });

  it('cursor round-trip: fetches only posts newer than the cursor', async () => {
    await call(clientB, 'post_to_board', { body: 'Second post, from B' });

    const res = await call(clientA, 'read_board', { cursor: cursorAfterFirst });
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).toContain('Second post, from B');
    // Strictly-after: the already-seen post must NOT be re-delivered.
    expect(text(res)).not.toContain('First post from A');

    const nextCursor = extract(res, /Next cursor: ([A-Za-z0-9_-]+)/);
    expect(nextCursor).not.toBe(cursorAfterFirst);

    // Caught up: an empty page keeps the cursor stable so pollers never lose
    // their place.
    const empty = await call(clientA, 'read_board', { cursor: nextCursor });
    expect(text(empty)).toContain('## Board (0 posts)');
    expect(text(empty)).toContain(`Next cursor: ${nextCursor}`);
  });

  it('epoch cursor MA replays the whole board oldest-first', async () => {
    const res = await call(clientA, 'read_board', { cursor: 'MA' });
    const body = text(res);
    expect(body).toContain('First post from A');
    expect(body).toContain('Second post, from B');
    expect(body.indexOf('First post from A')).toBeLessThan(body.indexOf('Second post, from B'));
  });

  it('threads replies and filters by thread', async () => {
    const reply = await call(clientB, 'post_to_board', {
      body: 'A reply from B',
      reply_to_post_id: firstPostId,
    });
    expect(reply.isError ?? false).toBe(false);

    const res = await call(clientA, 'read_board', { thread: firstPostId });
    expect(text(res)).toContain('## Board (2 posts)');
    expect(text(res)).toContain('First post from A');
    expect(text(res)).toContain('A reply from B');
    expect(text(res)).toContain(`reply to \`${firstPostId}\``);
    // The unrelated root stays out of the thread view.
    expect(text(res)).not.toContain('Second post, from B');
  });

  it('certified_only passes through (nobody is certified on an OSS-shaped DB)', async () => {
    const res = await call(clientA, 'read_board', { certified_only: true });
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).toContain('## Board (0 posts)');
  });

  it('author filter passes through', async () => {
    const res = await call(clientA, 'read_board', { author: agentB.agentId });
    expect(text(res)).toContain('## Board (2 posts)');
    expect(text(res)).not.toContain('First post from A');
  });

  it('bootstrap read with more history points at the web, not a dead-end cursor (regression)', async () => {
    // No cursor + limit 1 with >1 post on the board: the printed cursor is the
    // forward-polling FRONTIER. It must NOT be advertised as "call again with
    // the cursor below" — that cursor fetches nothing (older posts are below
    // it, unreachable forward). It should point at the web archive instead.
    const res = await call(clientA, 'read_board', { limit: 1 });
    const body = text(res);
    expect(body).toContain('## Board (1 post)');
    expect(body).not.toContain('call read_board again with the cursor below');
    expect(body).toContain('older history is on the web');
    // A frontier cursor is still handed back for forward polling.
    expect(body).toMatch(/Next cursor: [A-Za-z0-9_-]+/);
  });
});

describe('messaging fixes', () => {
  let firstMsgId: string;

  it('send_message renders the real message_id (regression: data.id was undefined)', async () => {
    const res = await call(clientB, 'send_message', {
      to_agent_id: agentA.agentId,
      type: 'message',
      subject: 'Board launch',
      body: 'Have you seen the new board?',
    });
    expect(res.isError ?? false).toBe(false);
    firstMsgId = extract(res, /\*\*ID:\*\* `(msg_[0-9A-Za-z]+)`/);
    expect(text(res)).not.toContain('undefined');
  });

  it('check_messages counts the page itself (regression: phantom pagination.total)', async () => {
    const res = await call(clientA, 'check_messages');
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).toContain('## Inbox (1 message)');
    expect(text(res)).toContain('Board launch');
    expect(text(res)).not.toContain('undefined');
  });

  it('check_messages after_id returns only newer messages, oldest first', async () => {
    await call(clientB, 'send_message', {
      to_agent_id: agentA.agentId,
      type: 'message',
      subject: 'Second thoughts',
      body: 'Follow-up.',
    });

    const res = await call(clientA, 'check_messages', { after_id: firstMsgId });
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).toContain('Second thoughts');
    expect(text(res)).not.toContain('Board launch');
    const nextId = extract(res, /pass after_id: `(msg_[0-9A-Za-z]+)`/);

    const empty = await call(clientA, 'check_messages', { after_id: nextId });
    expect(text(empty)).toContain('No new messages since your last check');
  });

  it('reply_message without a subject succeeds and the server derives Re:', async () => {
    const res = await call(clientA, 'reply_message', {
      message_id: firstMsgId,
      body: 'Yes — replying from the MCP tool with no subject.',
    });
    expect(res.isError ?? false).toBe(false);
    const replyId = extract(res, /\*\*Reply ID:\*\* `(msg_[0-9A-Za-z]+)`/);
    expect(text(res)).not.toContain('undefined');

    const row = await db.get<{ subject: string }>(
      'SELECT subject FROM messages WHERE id = ?', replyId
    );
    expect(row?.subject).toBe('Re: Board launch');
  });

  it('read_message renders the message body (regression: formatted the {ok,message} envelope)', async () => {
    // GET /v1/messages/:id answers {ok, message:{…}}; formatting the envelope
    // instead of .message printed every field as "undefined".
    const res = await call(clientA, 'read_message', { message_id: firstMsgId });
    expect(res.isError ?? false).toBe(false);
    const body = text(res);
    expect(body).not.toContain('undefined');
    expect(body).toContain('Have you seen the new board?'); // the actual body
    expect(body).toContain(firstMsgId);
  });

  it('identical rapid polls survive the 120s replay guard (fresh X-Nonce per request)', async () => {
    // The guard 401s a byte-identical signature; without a nonce, two
    // identical GETs signed in the same epoch second collide. Force that
    // exact condition: keep polling until two calls START in the same second,
    // and require every one of them to succeed.
    let sawSameSecond = false;
    let lastSecond = -1;
    for (let i = 0; i < 30 && !sawSameSecond; i++) {
      const sec = Math.floor(Date.now() / 1000);
      if (sec === lastSecond) sawSameSecond = true;
      lastSecond = sec;
      const res = await call(clientA, 'check_messages', { limit: 5 });
      expect(res.isError ?? false, text(res)).toBe(false);
    }
    expect(sawSameSecond).toBe(true);
  });
});
