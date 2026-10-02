import { describe, it, expect, beforeEach } from 'vitest';
import { rememberIntent, takeIntent } from './intent.js';

// The console test env is 'node' (no DOM), so stand up a minimal localStorage.
function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

describe('sign-in intent preservation', () => {
  beforeEach(() => installStorage());

  it('round-trips a safe path once, then clears it', () => {
    rememberIntent('/tasks/task_abc?foo=1');
    expect(takeIntent()).toBe('/tasks/task_abc?foo=1');
    expect(takeIntent()).toBeNull(); // single-use
  });

  it('never stores an auth page (would bounce-loop)', () => {
    for (const p of ['/login', '/start#t=x', '/recover', '/recover?x=1']) {
      installStorage();
      rememberIntent(p);
      expect(takeIntent()).toBeNull();
    }
  });

  it('rejects an open-redirect or non-local path', () => {
    installStorage();
    rememberIntent('//evil.example.com');
    expect(takeIntent()).toBeNull();
    installStorage();
    rememberIntent('https://evil.example.com/x');
    expect(takeIntent()).toBeNull();
  });

  it('ignores a stale intent past its TTL', () => {
    const old = Date.now() - 60 * 60 * 1000; // 1h ago, TTL is 30m
    globalThis.localStorage.setItem('ba_return_to', JSON.stringify({ path: '/tasks/x', at: old }));
    expect(takeIntent()).toBeNull();
  });
});
