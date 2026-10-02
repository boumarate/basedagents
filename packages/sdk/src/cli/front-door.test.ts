/**
 * The CLI one-liners the skill relies on (WS1): `id`, non-interactive
 * `register`, `tasks list --min-usdc`, `tasks submit --file`, `tasks watch`,
 * the command registry, and the rule that no command ever prints the private
 * key. Same harness as tasks.test.ts: stubbed fetch, process.exit throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type MockInstance } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateKeypair, serializeKeypair, publicKeyToAgentId, containsSecret, redactSecrets, REDACTED, type AgentKeypair } from '../index.js';
import { tasksList, tasksSubmit, tasksWatch, tasks, inferSubmission, watchDelayMs, nextActionHint, watchIsDone } from './tasks.js';
import { id } from './id.js';
import { register } from './register.js';
import { wallet } from './wallet.js';
import { CLI_COMMANDS, findCommand } from './commands.js';
import { HELP } from './index.js';

class ExitSignal extends Error {
  constructor(readonly code: number) { super(`process.exit(${code})`); }
}

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let dir: string;
let keypairPath: string;
let kp: AgentKeypair;
let agentId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ba-front-door-'));
  kp = await generateKeypair();
  agentId = publicKeyToAgentId(kp.publicKey);
  keypairPath = join(dir, 'agent-keypair.json');
  writeFileSync(keypairPath, serializeKeypair(kp));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: MockInstance<typeof console.log>;
let errSpy: MockInstance<typeof console.error>;
let stderrWrite: MockInstance<typeof process.stderr.write>;
let stdoutWrite: MockInstance<typeof process.stdout.write>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => { throw new ExitSignal(Number(code ?? 0)); }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

/** Every byte any command printed in this test — scanned for the private key after each test. */
const allOutput = () => [logSpy, errSpy, stderrWrite, stdoutWrite].flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');

afterEach(() => {
  expect(containsSecret(allOutput(), kp.privateKey), 'a command printed the private key').toBe(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stdout = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
// A command either calls process.exit (thrown as ExitSignal here) or returns and
// leaves process.exitCode set; null when it did neither. exitCode is always reset
// so it can't leak into the test runner's own exit status.
const exits = async (p: Promise<unknown>) => {
  process.exitCode = undefined;
  try {
    await p;
    return process.exitCode === undefined ? null : Number(process.exitCode);
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    throw e;
  } finally {
    process.exitCode = undefined;
  }
};

describe('basedagents id', () => {
  it('prints the registered identity as JSON, never the private key', async () => {
    fetchMock.mockResolvedValue(mockResponse({ agent_id: agentId, name: 'Scout', status: 'active', wallet_address: null, reputation_score: 0.5 }));
    expect(await exits(id(['--keypair', keypairPath, '--json']))).toBe(0);
    const out = JSON.parse(stdout());
    expect(out).toMatchObject({ registered: true, agent_id: agentId, name: 'Scout', status: 'active', keypair_path: keypairPath });
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/v1/agents/${agentId}`);
  });

  it('returns with exitCode after the lookup instead of calling process.exit (Windows libuv assertion)', async () => {
    fetchMock.mockResolvedValue(mockResponse({ agent_id: agentId, name: 'Scout', status: 'active' }));
    expect(await exits(id(['--keypair', keypairPath, '--json']))).toBe(0);
    expect(await exits(id(['--keypair', keypairPath]))).toBe(0);
    fetchMock.mockResolvedValue(mockResponse({ error: 'not_found', message: 'Agent not found' }, 404));
    expect(await exits(id(['--keypair', keypairPath, '--json']))).toBe(2);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('exits 2 when the key is not registered on this API', async () => {
    fetchMock.mockResolvedValue(mockResponse({ error: 'not_found' }, 404));
    expect(await exits(id(['--keypair', keypairPath, '--json']))).toBe(2);
    expect(JSON.parse(stdout())).toMatchObject({ registered: false, error: 'not_registered' });
  });

  it('with several local keypairs: JSON stdout stays clean and the path is the key it used', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ba-home-'));
    const keys = join(home, '.basedagents', 'keys');
    mkdirSync(keys, { recursive: true });
    const other = await generateKeypair();
    writeFileSync(join(keys, 'zeta-keypair.json'), serializeKeypair(kp));
    writeFileSync(join(keys, 'alpha-keypair.json'), serializeKeypair(other));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      fetchMock.mockResolvedValue(mockResponse({ agent_id: agentId, name: 'Scout', status: 'active' }));
      expect(await exits(id(['--json']))).toBe(0);
      const out = JSON.parse(stdout());
      expect(out.agent_id).toBe(agentId);
      expect(out.keypair_path).toBe(join(keys, 'zeta-keypair.json'));
      expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('Multiple keypairs');
    } finally {
      process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits 1 with no local keypair', async () => {
    expect(await exits(id(['--keypair', join(dir, 'missing.json'), '--json']))).toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({ registered: false, error: 'no_keypair' });
  });
});

describe('basedagents register (non-interactive)', () => {
  it('--name/--description/--capabilities --dry-run --json prints the profile and registers nothing', async () => {
    await register(['--name', 'Scout', '--description', 'Finds things', '--capabilities', 'research, code', '--dry-run', '--json']);
    expect(JSON.parse(stdout())).toEqual({ dry_run: true, profile: { name: 'Scout', description: 'Finds things', capabilities: ['research', 'code'], protocols: ['https'] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a profile without a capability', async () => {
    expect(await exits(register(['--name', 'Scout', '--description', 'x', '--dry-run']))).toBe(1);
  });
});

describe('tasks list --min-usdc', () => {
  it('passes min_usdc to the API', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, tasks: [] }));
    await tasksList(['--status', 'open', '--min-usdc', '1.00', '--json']);
    expect(String(fetchMock.mock.calls[0][0])).toContain('min_usdc=1.00');
  });

  it('rejects a malformed amount before any request', async () => {
    expect(await exits(tasksList(['--min-usdc', '1.2345678']))).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tasks submit --file', () => {
  it('infers the submission type from the file', () => {
    expect(inferSubmission('{"a":1}')).toMatchObject({ type: 'json', isJson: true });
    expect(inferSubmission('https://a.example/x\nhttps://b.example/y\n')).toEqual({ type: 'link', artifacts: ['https://a.example/x', 'https://b.example/y'], isJson: false });
    expect(inferSubmission('# Report\nplain text')).toMatchObject({ type: 'json', content: '# Report\nplain text', isJson: false });
  });

  it('delivers a JSON file with a signed POST /deliver', async () => {
    const file = join(dir, 'result.json');
    writeFileSync(file, '{"vendors":12}');
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, task: { task_id: 'task_1', output_format: 'json' } }))
      .mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', receipt_id: 'rcpt_1', status: 'submitted', revision_count: 0, chain_sequence: 1, chain_entry_hash: 'ab' }));
    await tasksSubmit(['task_1', '--file', file, '--note', 'Pricing table', '--keypair', keypairPath, '--json']);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toContain('/v1/tasks/task_1/deliver');
    expect(init.headers.Authorization).toMatch(/^AgentSig /);
    expect(JSON.parse(String(init.body))).toEqual({ summary: 'Pricing table', submission_type: 'json', submission_content: '{"vendors":12}' });
    expect(JSON.parse(stdout())).toMatchObject({ receipt_id: 'rcpt_1', submission_type: 'json', file: 'result.json' });
  });

  it('refuses a non-JSON file for a JSON task unless --force', async () => {
    const file = join(dir, 'report.md');
    writeFileSync(file, '# Report\nplain text');
    fetchMock.mockResolvedValue(mockResponse({ ok: true, task: { task_id: 'task_1', output_format: 'json' } }));
    expect(await exits(tasksSubmit(['task_1', '--file', file, '--keypair', keypairPath]))).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET: nothing delivered
    expect(errSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/not valid JSON.*--force/s);

    fetchMock.mockReset()
      .mockResolvedValueOnce(mockResponse({ ok: true, task: { task_id: 'task_1', output_format: 'json' } }))
      .mockResolvedValueOnce(mockResponse({ ok: true, task_id: 'task_1', receipt_id: 'rcpt_2', status: 'submitted', revision_count: 0, chain_sequence: 2, chain_entry_hash: 'cd' }));
    await tasksSubmit(['task_1', '--file', file, '--force', '--keypair', keypairPath, '--json']);
    expect(String(fetchMock.mock.calls[1][0])).toContain('/deliver');
  });

  it('requires --file', async () => {
    expect(await exits(tasksSubmit(['task_1', '--keypair', keypairPath]))).toBe(1);
  });
});

describe('tasks watch', () => {
  it('polls 10–15 s for the first 2 minutes, then 60 s while active, then 180 s idle (±15%)', () => {
    const lo = () => 0; const hi = () => 0.9999;
    expect(watchDelayMs(0, 0, lo)).toBeGreaterThanOrEqual(8_500);
    expect(watchDelayMs(0, 0, hi)).toBeLessThanOrEqual(17_250);
    expect(watchDelayMs(5 * 60_000, 60_000, lo)).toBe(51_000);
    expect(watchDelayMs(5 * 60_000, 60_000, hi)).toBeLessThanOrEqual(69_000);
    expect(watchDelayMs(60 * 60_000, 45 * 60_000, lo)).toBe(153_000);
  });

  it('names the next action for each state', () => {
    expect(nextActionHint({ status: 'open' })).toBe('claimable');
    expect(nextActionHint({ status: 'claimed', review_note: 'fix it' } as never)).toMatch(/revise/);
    expect(nextActionHint({ status: 'submitted', auto_release_at: '2026-10-01T00:00:00Z' } as never)).toMatch(/auto-accepts at 2026-10-01/);
    expect(nextActionHint({ status: 'verified', payment_status: 'settled' } as never)).toBe('paid');
  });

  it('--once --json prints the state as one JSON line', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, task: { task_id: 'task_1', status: 'submitted', payment_status: 'none', revision_count: 0 }, receipts_count: 1 }, 200, { ETag: 'W/"1"' }));
    expect(await exits(tasksWatch(['task_1', '--once', '--json']))).toBe(0);
    const line = JSON.parse(stdout());
    expect(line).toMatchObject({ event: 'state', task_id: 'task_1', status: 'submitted' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers['X-BasedAgents-Cli-Version']).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is done only when the payout is final', () => {
    expect(watchIsDone({ status: 'verified', payment_status: 'none' })).toBe(true);
    expect(watchIsDone({ status: 'verified', payment_status: 'settled' })).toBe(true);
    expect(watchIsDone({ status: 'verified', payment_status: 'settling' })).toBe(false);
    expect(watchIsDone({ status: 'verified', payment_status: 'failed' })).toBe(false);
    expect(watchIsDone({ status: 'cancelled', payment_status: 'refunded' })).toBe(true);
    expect(watchIsDone({ status: 'submitted' })).toBe(false);
  });

  it('keeps watching an accepted bounty until the transfer settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 20_000 });
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, task: { task_id: 'task_1', status: 'verified', payment_status: 'settling' } }))
      .mockResolvedValueOnce(mockResponse({ ok: true, task: { task_id: 'task_1', status: 'verified', payment_status: 'settled', payment_tx_hash: '0xab' } }));
    expect(await exits(tasksWatch(['task_1', '--json']))).toBe(0);
    vi.useRealTimers();
    const lines = stdout().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(['state', 'state', 'done']);
    expect(lines[0].next_action).toBe('accepted; payout settling');
    expect(lines.at(-1)).toMatchObject({ reason: 'terminal', payment_status: 'settled' });
  });

  it('stops with "done" on a terminal state', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, task: { task_id: 'task_1', status: 'verified', payment_status: 'settled' } }));
    expect(await exits(tasksWatch(['task_1', '--json']))).toBe(0);
    const lines = stdout().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ event: 'done', reason: 'terminal', status: 'verified' });
  });
});

describe('command registry', () => {
  it('every tasks subcommand and flag in the registry appears in `tasks --help`', async () => {
    await exits(tasks(['--help']));
    const help = stdout();
    for (const c of CLI_COMMANDS.filter((x) => x.command === 'tasks')) {
      expect(help, `tasks ${c.sub}`).toContain(c.sub!);
      for (const f of c.flags) expect(help, `tasks ${c.sub} ${f}`).toContain(f);
    }
  });

  it('id and wallet flags appear in their help', async () => {
    await exits(id(['--help']));
    for (const f of findCommand('id')!.flags) expect(stdout()).toContain(f);
    logSpy.mockClear();
    await exits(wallet(['--help']));
    for (const f of findCommand('wallet', 'set')!.flags) expect(stdout()).toContain(f);
  });

  it('every top-level command appears in the main help', () => {
    for (const c of new Set(CLI_COMMANDS.map((x) => x.command))) expect(HELP).toContain(`  ${c}`);
    for (const f of ['--name', '--description', '--capabilities']) expect(HELP).toContain(f);
  });

  it('findCommand treats bare `tasks` as `tasks list`', () => {
    expect(findCommand('tasks')?.sub).toBe('list');
    expect(findCommand('tasks', 'submit')?.flags).toContain('--file');
    expect(findCommand('nope')).toBeUndefined();
  });
});

describe('redactSecrets / containsSecret', () => {
  it('redacts PEM blocks and labeled keys, keeps transaction hashes', () => {
    const tx = '0x' + 'ab'.repeat(32);
    const text = `{"privateKey":"${'cd'.repeat(32)}"} PRIVATE_KEY=0x${'ef'.repeat(32)} tx ${tx}\n-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----`;
    const out = redactSecrets(text);
    expect(out).not.toContain('cd'.repeat(32));
    expect(out).not.toContain('ef'.repeat(32));
    expect(out).not.toContain('BEGIN EC PRIVATE KEY');
    expect(out).toContain(tx);
    expect(out).toContain(REDACTED);
  });

  it('finds a key in hex, 0x-hex or base64', () => {
    const hex = Buffer.from(kp.privateKey).toString('hex');
    expect(containsSecret(`key: ${hex}`, kp.privateKey)).toBe(true);
    expect(containsSecret(`0x${hex.toUpperCase()}`, kp.privateKey)).toBe(true);
    expect(containsSecret(Buffer.from(kp.privateKey).toString('base64'), kp.privateKey)).toBe(true);
    expect(containsSecret('nothing here', kp.privateKey)).toBe(false);
  });
});
