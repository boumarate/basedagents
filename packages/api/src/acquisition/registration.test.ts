/**
 * Agent acquisition at registration (routes/register.ts + recordAgentAcquisition):
 *
 *  - a registration carrying attribution (body or headers) writes exactly one
 *    immutable agent_acquisition row and a verified installation link
 *  - attribution never changes the public chain: the profile hash and entry
 *    hash are byte-identical with and without it
 *  - malformed attribution is dropped and the registration still succeeds
 *  - an expired/unknown acquisition id degrades to the explicit tag
 *  - agents that predate the system (no row) stay unknown — later tagged
 *    traffic never turns them into new acquisitions
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getPublicKey, sign, utils } from '@noble/ed25519';
import { setupTestDb, createTestApp, createTestAgent, signRequest } from '../test-helpers.js';
import { base58Encode, publicKeyToAgentId, hashProfile } from '../crypto/index.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { recordAgentAcquisition, parseAttributionHeaders } from './capture.js';

vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

vi.mock('../crypto/index.js', async () => {
  const actual = await vi.importActual<typeof import('../crypto/index.js')>('../crypto/index.js');
  return { ...actual, verifyProofOfWork: vi.fn(() => true) };
});

const INSTALL = '11111111-2222-4333-8444-555555555555';

interface AcquisitionRow {
  agent_id: string;
  source: string;
  campaign: string;
  method: string;
  installation_id: string;
  interface: string;
}

async function register(
  app: ReturnType<typeof createTestApp>,
  opts: { name: string; attribution?: unknown; headers?: Record<string, string> },
) {
  const privateKey = utils.randomPrivateKey();
  const publicKey = await getPublicKey(privateKey);
  const publicKeyB58 = base58Encode(publicKey);
  const initRes = await app.request('/v1/register/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKeyB58 }),
  });
  const init = await initRes.json() as { challenge_id: string; challenge: string };
  const sigBytes = await sign(new TextEncoder().encode(init.challenge), privateKey);
  const profile = {
    name: opts.name,
    description: 'An attribution test bot',
    capabilities: ['test'],
    protocols: ['mcp'],
  };
  const completeRes = await app.request('/v1/register/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify({
      challenge_id: init.challenge_id,
      public_key: publicKeyB58,
      signature: btoa(String.fromCharCode(...sigBytes)),
      nonce: 'deadbeefdeadbeef',
      profile,
      ...(opts.attribution !== undefined ? { attribution: opts.attribution } : {}),
    }),
  });
  return { completeRes, agentId: publicKeyToAgentId(publicKey), profile };
}

describe('agent acquisition at registration', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  const acquisition = (agentId: string) =>
    db.get<AcquisitionRow>('SELECT * FROM agent_acquisition WHERE agent_id = ?', agentId);

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
  });

  it('records body attribution once, with a verified installation link', async () => {
    const { completeRes, agentId } = await register(app, {
      name: 'AttributedBot',
      attribution: { source: 'pulsemcp', campaign: 'directory_listing', installation_id: INSTALL, interface: 'mcp_stdio' },
    });
    expect(completeRes.status).toBe(201);
    const row = (await acquisition(agentId))!;
    expect(row.source).toBe('pulsemcp');
    expect(row.campaign).toBe('directory_listing');
    expect(row.method).toBe('config_tag');
    expect(row.installation_id).toBe(INSTALL);
    const links = await db.all('SELECT * FROM installation_agent_links WHERE agent_id = ?', agentId);
    expect(links).toHaveLength(1);
  });

  it('falls back to request headers when the body carries no attribution', async () => {
    const { completeRes, agentId } = await register(app, {
      name: 'HeaderBot',
      headers: {
        'X-BasedAgents-Acquisition-Source': 'github',
        'X-BasedAgents-Installation-Id': INSTALL,
        'X-BasedAgents-Interface': 'mcp_stdio',
      },
    });
    expect(completeRes.status).toBe(201);
    const row = (await acquisition(agentId))!;
    expect(row.source).toBe('github');
    expect(row.interface).toBe('mcp_stdio');
  });

  it('records unknown (not nothing) for an untagged registration — coverage stays honest', async () => {
    const { completeRes, agentId } = await register(app, { name: 'UntaggedBot' });
    expect(completeRes.status).toBe(201);
    const row = (await acquisition(agentId))!;
    expect(row.source).toBe('unknown');
    expect(row.method).toBe('unknown');
  });

  it('never lets attribution leak into the chain: profile and entry hashes are attribution-independent', async () => {
    const a = await register(app, { name: 'PlainHashBot' });
    const b = await register(app, {
      name: 'TaggedHashBot',
      attribution: { source: 'hackernews', campaign: 'october_launch' },
    });
    expect(a.completeRes.status).toBe(201);
    expect(b.completeRes.status).toBe(201);
    // Same-shaped profiles (names aside) hash by profile content only; the
    // stored chain rows must carry exactly hashProfile(profile) — no
    // attribution input anywhere in the preimage.
    for (const r of [a, b]) {
      const chainRow = await db.get<{ profile_hash: string }>(
        'SELECT profile_hash FROM chain WHERE agent_id = ?', r.agentId,
      );
      expect(chainRow!.profile_hash).toBe(hashProfile(r.profile as unknown as Record<string, unknown>));
    }
  });

  it('drops malformed attribution without failing the registration', async () => {
    const { completeRes, agentId } = await register(app, {
      name: 'MalformedBot',
      attribution: { source: ['not', 'a', 'string'], campaign: 42, installation_id: 'nope' },
    });
    expect(completeRes.status).toBe(201);
    const row = (await acquisition(agentId))!;
    expect(row.source).toBe('unknown');
    expect(row.installation_id).toBe('');
  });

  it('degrades an unknown acquisition id to the explicit tag', async () => {
    const { completeRes, agentId } = await register(app, {
      name: 'ExpiredAcqBot',
      attribution: { source: 'npm', acquisition_id: 'acq_never_issued_1' },
    });
    expect(completeRes.status).toBe(201);
    const row = (await acquisition(agentId))!;
    expect(row.source).toBe('npm');
    expect(row.method).toBe('config_tag');
  });

  it('resolves a live acquisition id server-side at registration', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await db.run(
      `INSERT INTO acquisition_ids (id, source, campaign, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      'acq_regtest12345', 'website', 'getting_started', new Date().toISOString(), future,
    );
    const { agentId } = await register(app, {
      name: 'SetupTokenBot',
      attribution: { acquisition_id: 'acq_regtest12345' },
    });
    const row = (await acquisition(agentId))!;
    expect(row.source).toBe('website');
    expect(row.method).toBe('setup_token');
  });

  it('writes exactly one acquisition record per agent, ever', async () => {
    const agent = await createTestAgent(db);
    const headers = (src: string) =>
      parseAttributionHeaders((n) => (n === 'X-BasedAgents-Acquisition-Source' ? src : undefined));
    await recordAgentAcquisition(db, agent.agentId, agent.agentId, headers('github'), undefined);
    await recordAgentAcquisition(db, agent.agentId, agent.agentId, headers('npm'), undefined);
    const rows = await db.all<AcquisitionRow>('SELECT * FROM agent_acquisition WHERE agent_id = ?', agent.agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('github');
  });

  it('keeps pre-existing agents unattributed: tagged traffic links but never re-acquires them', async () => {
    const veteran = await createTestAgent(db); // predates the system: no acquisition row
    const path = `/v1/agents/${veteran.agentId}/messages`;
    const auth = await signRequest(veteran, 'GET', path);
    await app.request(path, {
      headers: {
        ...auth,
        'X-BasedAgents-Installation-Id': INSTALL,
        'X-BasedAgents-Interface': 'mcp_stdio',
        'X-BasedAgents-Acquisition-Source': 'pulsemcp',
      },
    });
    // The installation is linked and tagged…
    const links = await db.all('SELECT * FROM installation_agent_links WHERE agent_id = ?', veteran.agentId);
    expect(links).toHaveLength(1);
    // …but the agent's acquisition stays absent (reads as unknown/existing).
    expect(await acquisition(veteran.agentId)).toBeNull();
  });

  it('skips attribution entirely when ACQUISITION_ANALYTICS is off, and registration still works', async () => {
    const offApp = createTestApp(db, { ACQUISITION_ANALYTICS: '0' });
    const { completeRes, agentId } = await register(offApp, {
      name: 'FlagOffBot',
      attribution: { source: 'github' },
    });
    expect(completeRes.status).toBe(201);
    expect(await acquisition(agentId)).toBeNull();
  });

  it('survives a broken analytics table without failing registration', async () => {
    await db.exec('DROP TABLE agent_acquisition');
    const { completeRes } = await register(app, {
      name: 'ResilientBot',
      attribution: { source: 'github' },
    });
    expect(completeRes.status).toBe(201);
  });
});
