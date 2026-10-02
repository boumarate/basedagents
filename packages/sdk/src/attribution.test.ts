/**
 * Acquisition attribution in the SDK/CLI: env-tag validation, header
 * building, the telemetry opt-outs, and register() carrying the attribution
 * top-level (never inside the chain-hashed profile).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RegistryClient,
  attributionClientHeaders,
  attributionFromEnv,
  generateKeypair,
} from './index.js';

describe('attributionFromEnv', () => {
  it('reads valid tags and drops invalid ones silently', () => {
    expect(attributionFromEnv({
      BASEDAGENTS_ACQUISITION_SOURCE: 'pulsemcp',
      BASEDAGENTS_ACQUISITION_CAMPAIGN: 'directory_listing',
      BASEDAGENTS_ACQUISITION_ID: 'acq_abc123',
    })).toEqual({ source: 'pulsemcp', campaign: 'directory_listing', acquisition_id: 'acq_abc123' });

    expect(attributionFromEnv({
      BASEDAGENTS_ACQUISITION_SOURCE: 'Not A Source!',
      BASEDAGENTS_ACQUISITION_CAMPAIGN: 'UPPER CASE',
      BASEDAGENTS_ACQUISITION_ID: 'wrong_prefix',
    })).toEqual({});

    expect(attributionFromEnv({})).toEqual({});
  });

  it('rejects "unknown" as an explicit source (it is the absence of one)', () => {
    expect(attributionFromEnv({ BASEDAGENTS_ACQUISITION_SOURCE: 'unknown' })).toEqual({});
  });
});

describe('attributionClientHeaders', () => {
  it('builds the X-BasedAgents-* header set', () => {
    expect(attributionClientHeaders({ interface: 'cli', source: 'github', campaign: 'readme' }, {})).toEqual({
      'X-BasedAgents-Interface': 'cli',
      'X-BasedAgents-Acquisition-Source': 'github',
      'X-BasedAgents-Acquisition-Campaign': 'readme',
    });
  });

  it.each([
    [{ BASEDAGENTS_NO_TELEMETRY: '1' }],
    [{ BASEDAGENTS_TELEMETRY: 'off' }],
    [{ BASEDAGENTS_TELEMETRY: 'OFF' }],
  ])('sends nothing under opt-out %j', (env) => {
    expect(attributionClientHeaders({ interface: 'cli', source: 'github' }, env)).toEqual({});
  });
});

describe('register() attribution placement', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends attribution top-level in /complete, never inside the profile', async () => {
    const bodies: Record<string, unknown>[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (path.endsWith('/v1/register/init')) {
        return new Response(JSON.stringify({ challenge_id: 'ch_1', challenge: 'YWJj', difficulty: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ agent_id: 'ag_test', status: 'active', chain_sequence: 1 }), { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const kp = await generateKeypair();
    const client = new RegistryClient('https://api.example.test');
    await client.register(
      kp,
      { name: 'T', description: 'd', capabilities: ['x'], protocols: ['mcp'] },
      { attribution: { source: 'npm', interface: 'cli' } },
    );

    const complete = bodies.find((b) => b.challenge_id === 'ch_1' && b.profile !== undefined)!;
    expect(complete.attribution).toEqual({ source: 'npm', interface: 'cli' });
    expect((complete.profile as Record<string, unknown>).attribution).toBeUndefined();
  });
});
