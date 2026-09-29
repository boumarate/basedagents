/**
 * `basedagents feedback` and the CLI's version header (WS5). Stubbed fetch,
 * process.exit throws, same harness as tasks.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateKeypair, serializeKeypair, containsSecret, RegistryClient, setClientHeaders, type AgentKeypair } from '../index.js';
import { feedback } from './feedback.js';

class ExitSignal extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const ok = (body: unknown, status = 201) => ({ ok: status < 300, status, statusText: String(status), headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

let dir: string; let keypairPath: string; let kp: AgentKeypair;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ba-feedback-'));
  kp = await generateKeypair();
  keypairPath = join(dir, 'k-keypair.json');
  writeFileSync(keypairPath, serializeKeypair(kp));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[];
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(ok({ ok: true, feedback_id: 'fb_1', status: 'open', anonymous: false, created_at: 'now' }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitSignal(Number(c ?? 0)); }) as never);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { logs.push(a.join(' ')); });
});
afterEach(() => {
  expect(containsSecret(logs.join('\n'), kp.privateKey)).toBe(false);
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const REQUIRED = ['--expected', 'only paid tasks', '--actual', 'a free task came back', '--steps', 'tasks list --min-usdc 1'];

describe('basedagents feedback', () => {
  it('sends a signed report with an Idempotency-Key and the CLI version', async () => {
    await feedback([...REQUIRED, '--task', 'task_1', '--error-code', 'conflict,rate_limited', '--request-id', 'r1', '--skill-version', '1.1.0', '--keypair', keypairPath, '--json']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toMatch(/\/v1\/feedback$/);
    expect(init.headers.Authorization).toMatch(/^AgentSig /);
    expect(init.headers['Idempotency-Key']).toMatch(/^cli-/);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ scope: 'task', taskId: 'task_1', errorCodes: ['conflict', 'rate_limited'], requestIds: ['r1'], skillVersion: '1.1.0', expectedBehavior: 'only paid tasks' });
    expect(body.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.parse(logs.join('\n'))).toMatchObject({ feedback_id: 'fb_1' });
  });

  it('--anonymous sends no signature', async () => {
    await feedback([...REQUIRED, '--anonymous', '--json']);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(init.body)).scope).toBe('general');
  });

  it('retries a 5xx with the same Idempotency-Key, never a 4xx', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    fetchMock.mockResolvedValueOnce(ok({ error: 'internal_error' }, 503));
    await feedback([...REQUIRED, '--anonymous', '--json']);
    const keys = fetchMock.mock.calls.map(([, i]) => (i as { headers: Record<string, string> }).headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    vi.useRealTimers();

    fetchMock.mockReset().mockResolvedValue(ok({ error: 'bad_request', message: 'Validation failed' }, 400));
    await expect(feedback([...REQUIRED, '--anonymous', '--json'])).rejects.toMatchObject({ code: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an explicit --keypair that cannot be loaded fails instead of going anonymous', async () => {
    await expect(feedback([...REQUIRED, '--keypair', join(dir, 'missing-keypair.json'), '--json'])).rejects.toMatchObject({ code: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/Could not load the keypair/);
  });

  it('signs with the keypair BASEDAGENTS_KEYPAIR_PATH names when --keypair is not given', async () => {
    vi.stubEnv('BASEDAGENTS_KEYPAIR_PATH', keypairPath);
    await feedback([...REQUIRED, '--json']);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers.Authorization).toMatch(/^AgentSig /);
    vi.unstubAllEnvs();
  });

  it('a BASEDAGENTS_KEYPAIR_PATH that cannot be loaded fails instead of going anonymous', async () => {
    vi.stubEnv('BASEDAGENTS_KEYPAIR_PATH', join(dir, 'missing-keypair.json'));
    await expect(feedback([...REQUIRED, '--json'])).rejects.toMatchObject({ code: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/Could not load the keypair .*missing-keypair\.json/);
    vi.unstubAllEnvs();
  });

  it('requires --expected, --actual and --steps', async () => {
    await expect(feedback(['--expected', 'x'])).rejects.toMatchObject({ code: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('setClientHeaders', () => {
  it('adds the headers to every RegistryClient request', async () => {
    setClientHeaders({ 'X-BasedAgents-Cli-Version': '9.9.9' });
    fetchMock.mockResolvedValue(ok({ ok: true, tasks: [] }, 200));
    await new RegistryClient('https://api.example').getTasks();
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['X-BasedAgents-Cli-Version']).toBe('9.9.9');
  });
});
