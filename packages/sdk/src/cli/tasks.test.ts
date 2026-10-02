/**
 * SDK CLI — `tasks` subcommand handler tests.
 *
 * Every handler runs against a stubbed global `fetch` and a stubbed
 * `process.exit` (which throws an ExitSignal so the test can assert the exit
 * code). Authenticated subcommands sign with a throwaway keypair written to a
 * temp file and passed via `--keypair <path>` — the real loadKeypair path.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type MockInstance } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateKeypair, serializeKeypair, TASK_STATUSES, TASK_CATEGORIES, PAYMENT_HEADER } from '../index.js';
import {
  tasks, tasksList, tasksPost, tasksFund, tasksClaim, tasksDeliver, tasksAccept, tasksRevision, tasksDispute, tasksCancel, tasksPayment,
  ALLOWED_STATUSES, ALLOWED_CATEGORIES, EXIT_PAYMENT_REQUIRED, readPaymentSignature, getFlag, firstPositional,
} from './tasks.js';
import { task } from './task.js';

class ExitSignal extends Error {
  constructor(readonly code: number) { super(`process.exit(${code})`); }
}

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const PAYMENT_REQUIRED_BODY = {
  error: 'payment_required',
  message: 'Sign an EIP-3009 USDC transfer of 5.00 USDC to the deliverer\'s wallet and retry with the PAYMENT-SIGNATURE header.',
  x402Version: 2,
  resource: { url: 'https://api.basedagents.ai/v1/tasks/task_paid/accept', description: 'BasedAgents task task_paid bounty', mimeType: 'application/json' },
  accepts: [{
    scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '5000000', payTo: '0x' + 'ab'.repeat(20), maxTimeoutSeconds: 3600, extra: { name: 'USD Coin', version: '2' },
  }],
  task_id: 'task_paid',
  bounty: { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' },
  accept_endpoint: 'POST /v1/tasks/task_paid/accept',
  payment_header: 'PAYMENT-SIGNATURE',
};

let dir: string;
let keypairPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'basedagents-cli-'));
  keypairPath = join(dir, 'test-keypair.json');
  writeFileSync(keypairPath, serializeKeypair(await generateKeypair()), { mode: 0o600 });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: MockInstance<typeof console.log>;
let errSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new ExitSignal(Number(code ?? 0));
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stdout = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
const stderr = () => errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function expectExit(promise: Promise<unknown>, code: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

function requestOf(index = 0): { url: string; init: RequestInit & { headers: Record<string, string>; body?: string } } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit & { headers: Record<string, string>; body?: string }];
  return { url, init };
}

const auth = (extra: string[] = []) => ['--keypair', keypairPath, ...extra];

// ─── Allowlists come from the SDK's shared enums ───

describe('tasks CLI — allowlists (NEW-6)', () => {
  it('ALLOWED_STATUSES is the shared TASK_STATUSES plus "all" and includes "closed"', () => {
    expect(ALLOWED_STATUSES).toEqual([...TASK_STATUSES, 'all']);
    expect(ALLOWED_STATUSES).toContain('closed');
  });

  it('ALLOWED_CATEGORIES is the shared TASK_CATEGORIES', () => {
    expect(ALLOWED_CATEGORIES).toEqual([...TASK_CATEGORIES]);
  });

  it('rejects an invalid --status before any request', async () => {
    for (const status of ['OPEN', 'done', 'pending', 'active']) {
      await expectExit(tasksList(['--status', status]), 1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(plain(stderr())).toContain('Invalid --status');
  });

  it('rejects an invalid --category before any request', async () => {
    await expectExit(tasksList(['--category', 'science']), 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts every valid status and category', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, tasks: [] }));
    for (const status of ALLOWED_STATUSES) await tasksList(['--status', status, '--category', 'code']);
    expect(fetchMock).toHaveBeenCalledTimes(ALLOWED_STATUSES.length);
  });

  it('getFlag returns the value after the flag or undefined', () => {
    expect(getFlag([], '--status')).toBeUndefined();
    expect(getFlag(['--limit', '10', '--status', 'claimed'], '--status')).toBe('claimed');
  });

  it('firstPositional finds the task id wherever it sits among the flags', () => {
    expect(firstPositional([])).toBeUndefined();
    expect(firstPositional(['--keypair', 'k.json'])).toBeUndefined();
    expect(firstPositional(['task_1', '--keypair', 'k.json'])).toBe('task_1');
    expect(firstPositional(['--keypair', 'k.json', 'task_1'])).toBe('task_1');
    expect(firstPositional(['--json', 'task_1'])).toBe('task_1');
    expect(firstPositional(['--payment-signature', '-', '--note', 'ok', 'task_1'])).toBe('task_1');
  });
});

// ─── list ───

describe('tasks list', () => {
  it('is the default subcommand and forwards filters as query params', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, tasks: [] }));
    await tasks(['--status', 'open', '--capability', 'code-review', '--creator', 'ag_x', '--claimer', 'ag_y', '--limit', '5', '--api', 'https://api.test.local']);
    const { url } = requestOf();
    expect(url.startsWith('https://api.test.local/v1/tasks?')).toBe(true);
    for (const q of ['status=open', 'capability=code-review', 'creator=ag_x', 'claimer=ag_y', 'limit=5']) expect(url).toContain(q);
  });

  it('renders the bounty display amount, the poster and review state', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      tasks: [{
        task_id: 'task_1', title: 'Paid', description: 'desc', status: 'claimed', category: 'code', creator_agent_id: null,
        creator: { kind: 'owner', id: null, short_id: null, name: 'Max', cert: 'certified_human' },
        bounty: { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' },
        review_state: 'revision_requested', payment_due: false,
      }],
    }));
    await tasks(['list', '--api', 'https://api.test.local']);
    const out = plain(stdout());
    expect(out).toContain('5.00 USDC');
    expect(out).toContain('Max (human)');
    expect(out).toContain('[revision_requested]');
  });
});

// ─── post ───

describe('tasks post', () => {
  it('posts the task with an atomic bounty in the body and NO payment header', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true, task_id: 'task_new', status: 'open', payment_status: 'pending',
      bounty: { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' },
    }));
    await tasksPost(auth([
      '--title', 'Summarize paper', '--description', 'Read and summarize', '--category', 'research',
      '--capabilities', 'summarization, research', '--expected-output', 'A 1-page summary', '--format', 'link',
      '--bounty', '5.00', '--api', 'https://api.test.local',
    ]));
    const { url, init } = requestOf();
    expect(url).toBe('https://api.test.local/v1/tasks');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^AgentSig /);
    expect(init.headers[PAYMENT_HEADER]).toBeUndefined();
    expect(init.headers['X-PAYMENT-SIGNATURE']).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      title: 'Summarize paper', description: 'Read and summarize', category: 'research',
      required_capabilities: ['summarization', 'research'], expected_output: 'A 1-page summary', output_format: 'link',
      bounty: { amount: '5000000', token: 'USDC', network: 'eip155:8453' },
    });
    const out = plain(stdout());
    expect(out).toContain('task_new');
    expect(out).toContain('5.00 USDC');
    expect(out).toContain('authorized when you accept');
  });

  it('honours --network for the bounty', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_new', status: 'open', payment_status: 'pending' }));
    await tasksPost(auth(['--title', 'T', '--description', 'D', '--bounty', '0.5', '--network', 'eip155:84532']));
    const body = JSON.parse(requestOf().init.body as string);
    expect(body.bounty).toEqual({ amount: '500000', token: 'USDC', network: 'eip155:84532' });
  });

  it('posts an unpaid task without a bounty key', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_free', status: 'open', payment_status: 'none' }));
    await tasksPost(auth(['--title', 'T', '--description', 'D']));
    const body = JSON.parse(requestOf().init.body as string);
    expect(body.bounty).toBeUndefined();
    expect(plain(stdout())).not.toContain('authorized when you accept');
  });

  it('exits 1 without --title/--description and makes no request', async () => {
    await expectExit(tasksPost(auth(['--title', 'only'])), 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a bounty with more than 6 decimals, zero, over 1000 USDC, or an unknown network', async () => {
    for (const bad of ['5.1234567', '0', '1000.01', '$5', 'abc']) {
      await expectExit(tasksPost(auth(['--title', 'T', '--description', 'D', '--bounty', bad])), 1);
    }
    await expectExit(tasksPost(auth(['--title', 'T', '--description', 'D', '--bounty', '1', '--network', 'eip155:1'])), 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('`task create` is an alias of `tasks post`', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_alias', status: 'open', payment_status: 'none' }));
    await task(['create', ...auth(['--title', 'T', '--description', 'D', '--api', 'https://api.test.local'])]);
    const { url, init } = requestOf();
    expect(url).toBe('https://api.test.local/v1/tasks');
    expect(JSON.parse(init.body as string).title).toBe('T');
  });

  it('surfaces 503 payments_unavailable with its code', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ error: 'payments_unavailable', message: 'Bounties are not enabled' }, 503));
    await expectExit(tasksPost(auth(['--title', 'T', '--description', 'D', '--bounty', '1'])), 1);
    expect(plain(stderr())).toContain('payments_unavailable');
  });

  // ─── Escrow: the deposit is signed at post ───

  const ESCROW_CHALLENGE = {
    ...PAYMENT_REQUIRED_BODY,
    task_id: undefined,
    accept_endpoint: undefined,
    message: 'Escrow: sign an EIP-3009 USDC transfer of 5.00 USDC to the registry escrow wallet and retry.',
    resource: { url: 'https://api.basedagents.ai/v1/tasks', description: 'BasedAgents escrow deposit for a new task', mimeType: 'application/json' },
    escrow: { wallet: '0x' + 'ee'.repeat(20) },
    fund_endpoint: 'POST /v1/tasks',
  };

  it('an escrow 402 on post prints the deposit challenge JSON to stdout and exits 2; nothing else is sent', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(ESCROW_CHALLENGE, 402, { 'PAYMENT-REQUIRED': 'eyJ4NDAyVmVyc2lvbiI6Mn0=' }));
    await expectExit(tasksPost(auth(['--title', 'T', '--description', 'D', '--bounty', '5.00'])), EXIT_PAYMENT_REQUIRED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestOf().init.headers[PAYMENT_HEADER]).toBeUndefined();
    const printed = JSON.parse(plain(stdout()));
    expect(printed.accepts[0].payTo).toBe('0x' + 'ab'.repeat(20));
    expect(printed.escrow.wallet).toBe('0x' + 'ee'.repeat(20));
    const err = plain(stderr());
    expect(err).toContain('Escrow deposit required');
    expect(err).toContain('--payment-signature');
  });

  it('--payment-signature sends the deposit header and prints the escrow state', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true, task_id: 'task_esc', status: 'open', payment_status: 'pending', claimable: true,
      bounty: { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' },
      escrow: { status: 'funded', leg: null, wallet: '0x' + 'ee'.repeat(20), deposit_tx_hash: '0x' + 'ab'.repeat(32), funded_at: 'now', release_tx_hash: null, released_at: null, refund_tx_hash: null, refunded_at: null },
    }));
    await tasksPost(auth(['--title', 'T', '--description', 'D', '--bounty', '5.00', '--payment-signature', 'c2lnbmVk']));
    const { init } = requestOf();
    expect(init.headers[PAYMENT_HEADER]).toBe('c2lnbmVk');
    expect(JSON.parse(init.body as string).escrow).toBeUndefined(); // server default (on)
    const out = plain(stdout());
    expect(out).toContain('task_esc');
    expect(out).toContain('funded');
    expect(out).toContain('held in escrow');
    expect(out).not.toContain('authorized when you accept');
  });

  it('--no-escrow sends escrow: false and refuses a deposit signature', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true, task_id: 'task_new', status: 'open', payment_status: 'pending', escrow: null,
      bounty: { amount_atomic: '5000000', amount_display: '5.00', token: 'USDC', network: 'eip155:8453' },
    }));
    await tasksPost(auth(['--title', 'T', '--description', 'D', '--bounty', '5.00', '--no-escrow']));
    const body = JSON.parse(requestOf().init.body as string);
    expect(body.escrow).toBe(false);
    expect(body.title).toBe('T'); // --no-escrow consumed no value
    expect(plain(stdout())).toContain('authorized when you accept');
    await expectExit(tasksPost(auth(['--title', 'T', '--description', 'D', '--bounty', '5.00', '--no-escrow', '--payment-signature', 'x'])), 1);
    await expectExit(tasksPost(auth(['--title', 'T', '--description', 'D', '--no-escrow'])), 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tasks fund: 402 exits 2 with the challenge; with a signature POSTs /fund with the header', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ...ESCROW_CHALLENGE, task_id: 'task_esc', fund_endpoint: 'POST /v1/tasks/task_esc/fund' }, 402));
    await expectExit(tasksFund(auth(['task_esc'])), EXIT_PAYMENT_REQUIRED);
    expect(requestOf().url).toContain('/v1/tasks/task_esc/fund');
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_esc', status: 'open', payment_status: 'pending', escrow: { status: 'funded', deposit_tx_hash: '0x' + 'ab'.repeat(32) } }));
    await tasksFund(auth(['task_esc', '--payment-signature', 'c2lnbmVk']));
    const { url, init } = requestOf(1);
    expect(url).toContain('/v1/tasks/task_esc/fund');
    expect(init.headers[PAYMENT_HEADER]).toBe('c2lnbmVk');
    expect(plain(stdout())).toContain('funded');
  });
});

// ─── claim ───

describe('tasks claim', () => {
  it('POSTs /v1/tasks/:id/claim with AgentSig', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', status: 'claimed' }));
    await tasksClaim(auth(['task_1', '--api', 'https://api.test.local']));
    const { url, init } = requestOf();
    expect(url).toBe('https://api.test.local/v1/tasks/task_1/claim');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^AgentSig /);
  });

  it('exits 1 with a wallet hint on 409 wallet_required', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      error: 'wallet_required', message: 'Set a wallet before claiming.',
      help: { set_wallet: 'PATCH /v1/agents/ag_x/wallet' },
    }, 409));
    await expectExit(tasksClaim(auth(['task_1'])), 1);
    const err = plain(stderr());
    expect(err).toContain('basedagents wallet set');
    expect(err).toContain('wallet_required');
  });

  it('exits 1 without a task id', async () => {
    await expectExit(tasksClaim(auth([])), 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the task id before or after the flags', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, task_id: 'task_1', status: 'claimed' }));
    await tasksClaim(['task_1', ...auth(['--api', 'https://api.test.local'])]);
    await tasksClaim([...auth(['--api', 'https://api.test.local']), 'task_1']);
    expect(requestOf(0).url).toBe('https://api.test.local/v1/tasks/task_1/claim');
    expect(requestOf(1).url).toBe('https://api.test.local/v1/tasks/task_1/claim');
  });
});

// ─── deliver ───

describe('tasks deliver', () => {
  it('infers submission_type pr from --pr-url and sends the receipt body', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', receipt_id: 'rcpt_1', chain_sequence: 3, chain_entry_hash: 'a'.repeat(64), status: 'submitted', revision_count: 0 }));
    await tasksDeliver(auth(['task_1', '--summary', 'Done', '--pr-url', 'https://github.com/o/r/pull/1', '--commit', 'b'.repeat(40)]));
    const { url, init } = requestOf();
    expect(url).toContain('/v1/tasks/task_1/deliver');
    expect(JSON.parse(init.body as string)).toEqual({
      summary: 'Done', submission_type: 'pr', pr_url: 'https://github.com/o/r/pull/1', commit_hash: 'b'.repeat(40),
    });
    expect(plain(stdout())).toContain('rcpt_1');
  });

  it('infers link from --artifact and json from --content; --type overrides', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, task_id: 'task_1', receipt_id: 'rcpt_1', chain_sequence: null, chain_entry_hash: null, status: 'submitted', revision_count: 1 }));
    await tasksDeliver(auth(['task_1', '--summary', 'S', '--artifact', 'https://a.example/1, https://a.example/2']));
    expect(JSON.parse(requestOf(0).init.body as string)).toMatchObject({ submission_type: 'link', artifact_urls: ['https://a.example/1', 'https://a.example/2'] });
    await tasksDeliver(auth(['task_1', '--summary', 'S', '--content', '{"ok":true}']));
    expect(JSON.parse(requestOf(1).init.body as string)).toMatchObject({ submission_type: 'json', submission_content: '{"ok":true}' });
    await tasksDeliver(auth(['task_1', '--summary', 'S', '--content', 'x', '--type', 'link']));
    expect(JSON.parse(requestOf(2).init.body as string)).toMatchObject({ submission_type: 'link' });
  });

  it('exits 1 without --summary or with an unknown --type', async () => {
    await expectExit(tasksDeliver(auth(['task_1'])), 1);
    await expectExit(tasksDeliver(auth(['task_1', '--summary', 'S', '--type', 'zip'])), 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── accept ───

describe('tasks accept', () => {
  it('on 402 prints the PaymentRequired JSON to stdout and exits 2', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(PAYMENT_REQUIRED_BODY, 402, { 'PAYMENT-REQUIRED': 'eyJ4NDAyVmVyc2lvbiI6Mn0=' }));
    await expectExit(tasksAccept(auth(['task_paid', '--api', 'https://api.test.local'])), EXIT_PAYMENT_REQUIRED);

    const { url, init } = requestOf();
    expect(url).toBe('https://api.test.local/v1/tasks/task_paid/accept');
    expect(init.headers[PAYMENT_HEADER]).toBeUndefined();

    // stdout is exactly the machine-readable challenge (pipe it into a signer)
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.accepts[0].payTo).toBe('0x' + 'ab'.repeat(20));
    expect(printed.accepts[0].amount).toBe('5000000');
    expect(printed.task_id).toBe('task_paid');
    expect(printed.x402Version).toBe(2);
    // the human note goes to stderr
    expect(plain(stderr())).toContain('--payment-signature');
  });

  it('sends --payment-signature as the PAYMENT-SIGNATURE header and reports settlement', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(
      { ok: true, task_id: 'task_paid', status: 'verified', accepted_by: 'creator', payment_status: 'settled', payment_tx_hash: '0xdead', chain_sequence: 9, chain_entry_hash: 'h' },
      200, { 'PAYMENT-RESPONSE': 'eyJzdWNjZXNzIjp0cnVlfQ==' },
    ));
    await tasksAccept(auth(['task_paid', '--note', 'great work', '--payment-signature', 'c2lnbmVk']));
    const { init } = requestOf();
    expect(init.headers[PAYMENT_HEADER]).toBe('c2lnbmVk');
    expect(JSON.parse(init.body as string)).toEqual({ note: 'great work' });
    const out = plain(stdout());
    expect(out).toContain('settled');
    expect(out).toContain('0xdead');
  });

  it('reads the signature from @file', async () => {
    const sigPath = join(dir, 'payload.b64');
    writeFileSync(sigPath, 'ZnJvbS1maWxl\n');
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_paid', status: 'verified', accepted_by: 'creator', payment_status: 'authorized', settle_error: 'settle_exact_node_failure' }));
    await tasksAccept(auth(['task_paid', '--payment-signature', `@${sigPath}`]));
    expect(requestOf().init.headers[PAYMENT_HEADER]).toBe('ZnJvbS1maWxl');
    expect(plain(stdout())).toContain('tasks payment task_paid');
  });

  it('readPaymentSignature handles inline and @file forms', () => {
    const sigPath = join(dir, 'p2.b64');
    writeFileSync(sigPath, '  abc==  ');
    expect(readPaymentSignature(' inline ')).toBe('inline');
    expect(readPaymentSignature(`@${sigPath}`)).toBe('abc==');
  });

  it('exits 1 on 402 payment_invalid with the reason', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      error: 'payment_invalid', reason: 'amount_mismatch', expected: '5000000', got: '4000000',
      message: "The signed authorization does not match this task's payment requirements.", payment_requirements: PAYMENT_REQUIRED_BODY.accepts[0],
    }, 402));
    await expectExit(tasksAccept(auth(['task_paid', '--payment-signature', 'bad'])), 1);
    const err = plain(stderr());
    expect(err).toContain('amount_mismatch');
    expect(err).toContain('expected: 5000000');
  });

  it('exits 1 on 409 with the machine code', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ error: 'invalid_state', message: 'Task is open; only a submitted task can be accepted', status: 'open' }, 409));
    await expectExit(tasksAccept(auth(['task_1'])), 1);
    expect(plain(stderr())).toContain('invalid_state');
  });

  it('accepts an unpaid task with payment_status none', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_free', status: 'verified', accepted_by: 'creator', payment_status: 'none', chain_sequence: 1, chain_entry_hash: 'h' }));
    await tasksAccept(auth(['task_free']));
    expect(plain(stdout())).toContain('none');
  });
});

// ─── revision / dispute / cancel ───

describe('tasks revision', () => {
  it('POSTs the note', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', status: 'claimed', review_state: 'revision_requested', revision_count: 1 }));
    await tasksRevision(auth(['task_1', '--note', 'Add tests']));
    const { url, init } = requestOf();
    expect(url).toContain('/v1/tasks/task_1/revision');
    expect(JSON.parse(init.body as string)).toEqual({ note: 'Add tests' });
    expect(plain(stdout())).toContain('round 1 of 3');
  });

  it('exits 1 without --note', async () => {
    await expectExit(tasksRevision(auth(['task_1'])), 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tasks dispute', () => {
  it('POSTs the reason', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', status: 'submitted', review_state: 'disputed', disputed_at: '2026-01-01T00:00:00Z', payment_status: 'pending' }));
    await tasksDispute(auth(['task_1', '--reason', 'Incomplete']));
    const { url, init } = requestOf();
    expect(url).toContain('/v1/tasks/task_1/dispute');
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Incomplete' });
  });

  it('exits 1 without --reason', async () => {
    await expectExit(tasksDispute(auth(['task_1'])), 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an optional --rating and --rating-comment', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', status: 'submitted', review_state: 'disputed', disputed_at: '2026-01-01T00:00:00Z', payment_status: 'none', rating: 2 }));
    await tasksDispute(auth(['task_1', '--reason', 'Incomplete', '--rating', '2', '--rating-comment', 'Half done']));
    expect(JSON.parse(requestOf().init.body as string)).toEqual({ reason: 'Incomplete', rating: 2, rating_comment: 'Half done' });
    expect(plain(stdout())).toContain('2/5');
  });
});

describe('tasks accept --rating', () => {
  it('sends the rating with the note and prints it', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', status: 'verified', accepted_by: 'creator', payment_status: 'none', rating: 5 }));
    await tasksAccept(auth(['task_1', '--note', 'Thanks', '--rating', '5']));
    expect(JSON.parse(requestOf().init.body as string)).toEqual({ note: 'Thanks', rating: 5 });
    expect(plain(stdout())).toContain('5/5');
  });

  it('exits 1 before any request on a rating outside 1-5, or a comment without a rating', async () => {
    for (const bad of [['--rating', '0'], ['--rating', '6'], ['--rating', '4.5'], ['--rating', 'five'], ['--rating-comment', 'no score']]) {
      await expectExit(tasksAccept(auth(['task_1', ...bad])), 1);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tasks cancel', () => {
  it('POSTs /cancel and prints the voided payment status', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', status: 'cancelled', payment_status: 'expired' }));
    await tasksCancel(auth(['task_1']));
    expect(requestOf().url).toContain('/v1/tasks/task_1/cancel');
    expect(plain(stdout())).toContain('expired');
  });

  it('explains dispute_first on a delivered task', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ error: 'dispute_first', message: 'Delivered work can only be cancelled after a dispute', status: 'submitted', payment_status: 'none' }, 409));
    await expectExit(tasksCancel(auth(['task_1'])), 1);
    expect(plain(stderr())).toContain('tasks dispute task_1');
  });
});

// ─── payment ───

describe('tasks payment', () => {
  it('GETs /payment and renders the x402 requirements', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({
      ok: true,
      payment: {
        task_id: 'task_paid', bounty: PAYMENT_REQUIRED_BODY.bounty, status: 'pending', verified: false, settled: false, tx_hash: null,
        settled_at: null, expires_at: null, auto_release_at: '2026-01-08T00:00:00Z', accepted_by: null, payer: null, last_error: null,
        settle_attempts: 0, next_settle_at: null, payment_due: false, pay_to: '0x' + 'ab'.repeat(20),
      },
      requirements: PAYMENT_REQUIRED_BODY.accepts[0],
      payment_required: { x402Version: 2, resource: PAYMENT_REQUIRED_BODY.resource, accepts: PAYMENT_REQUIRED_BODY.accepts },
      accept_endpoint: 'POST /v1/tasks/task_paid/accept',
      payment_header: 'PAYMENT-SIGNATURE',
      events: [{ id: 'pev_1', event_type: 'bounty_declared', details: { amount_atomic: '5000000' }, created_at: '2026-01-01T00:00:00Z' }],
    }));
    await tasksPayment(['task_paid', '--api', 'https://api.test.local']);
    expect(requestOf().url).toBe('https://api.test.local/v1/tasks/task_paid/payment');
    const out = plain(stdout());
    expect(out).toContain('5.00 USDC');
    expect(out).toContain('payTo');
    expect(out).toContain('bounty_declared');
  });

  it('--json prints the raw response', async () => {
    const body = { ok: true, payment: { task_id: 'task_1', bounty: null, status: 'none' }, requirements: null, requirements_unavailable_reason: 'no_bounty', accept_endpoint: 'POST /v1/tasks/task_1/accept', payment_header: 'PAYMENT-SIGNATURE', events: [] };
    fetchMock.mockResolvedValueOnce(mockResponse(body));
    await tasksPayment(['task_1', '--json']);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(body);
  });
});
