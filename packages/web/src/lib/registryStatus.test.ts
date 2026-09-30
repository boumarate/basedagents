import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The homepage's shared GET /v1/status (lib/registryStatus.ts): the agent count
 * and the live-work section must share one request, see fresh data after a
 * minute, and recover from a failed request instead of caching the failure.
 */
const getStatus = vi.fn();
vi.mock('../api/client', () => ({ api: { getStatus: (...a: unknown[]) => getStatus(...a) } }));

async function load() {
  vi.resetModules(); // a fresh module-level cache per test
  return (await import('./registryStatus')).registryStatus;
}
const status = (total: number) => ({ status: 'operational', agents: { total, active: total, pending: 0, suspended: 0 } });

beforeEach(() => {
  getStatus.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('registryStatus', () => {
  it('two callers share one request', async () => {
    const registryStatus = await load();
    getStatus.mockResolvedValueOnce(status(270));
    const [a, b] = await Promise.all([registryStatus(), registryStatus()]);
    expect(a).toBe(b);
    expect(a.agents?.total).toBe(270);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('reuses a result for a minute, then fetches again', async () => {
    const registryStatus = await load();
    getStatus.mockResolvedValueOnce(status(270)).mockResolvedValueOnce(status(271));
    expect((await registryStatus()).agents?.total).toBe(270);
    vi.setSystemTime(new Date('2026-09-30T12:00:59Z'));
    expect((await registryStatus()).agents?.total).toBe(270);
    vi.setSystemTime(new Date('2026-09-30T12:01:01Z'));
    expect((await registryStatus()).agents?.total).toBe(271);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failure: the next caller tries again', async () => {
    const registryStatus = await load();
    getStatus.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(status(270));
    await expect(registryStatus()).rejects.toThrow('network down');
    expect((await registryStatus()).agents?.total).toBe(270);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});
