import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getPublicKey, sign, utils } from '@noble/ed25519';
import {
  setupTestDb,
  createTestApp,
} from '../test-helpers.js';
import {
  base58Encode,
  publicKeyToAgentId,
  DEFAULT_DIFFICULTY,
} from '../crypto/index.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';

// Mock twitter so registration doesn't try to tweet
vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

// Mock verifyProofOfWork so we don't have to solve at difficulty=22 in tests.
// The crypto/index.test.ts already tests the real PoW logic.
vi.mock('../crypto/index.js', async () => {
  const actual = await vi.importActual<typeof import('../crypto/index.js')>('../crypto/index.js');
  return {
    ...actual,
    verifyProofOfWork: vi.fn(() => true),
  };
});

// Mock fetch for webhooks
const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
vi.stubGlobal('fetch', mockFetch);

async function doFullRegistration(
  app: ReturnType<typeof createTestApp>,
  options: {
    name?: string;
  } = {}
) {
  const privateKey = utils.randomPrivateKey();
  const publicKey = await getPublicKey(privateKey);
  const publicKeyB58 = base58Encode(publicKey);

  // Step 1: init
  const initRes = await app.request('/v1/register/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKeyB58 }),
  });
  expect(initRes.status).toBe(200);
  const initData = await initRes.json() as {
    challenge_id: string;
    challenge: string;
    difficulty: number;
    previous_hash: string;
  };

  // Step 2: sign the challenge bytes
  const challengeData = new TextEncoder().encode(initData.challenge);
  const sigBytes = await sign(challengeData, privateKey);
  const signature = btoa(String.fromCharCode(...sigBytes));

  // Step 3: use a dummy nonce — verifyProofOfWork is mocked to return true in these tests
  const nonce = 'deadbeefdeadbeef';

  // Step 4: complete
  const profile = {
    name: options.name ?? `TestBot-${Date.now()}`,
    description: 'A test bot for automated testing',
    capabilities: ['test', 'code-generation'],
    protocols: ['http', 'mcp'],
  };

  const completeRes = await app.request('/v1/register/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge_id: initData.challenge_id,
      public_key: publicKeyB58,
      signature,
      nonce,
      profile,
    }),
  });

  return { completeRes, publicKey, privateKey, publicKeyB58, agentId: publicKeyToAgentId(publicKey), profile };
}

describe('POST /v1/register/init', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('returns challenge, difficulty, and previous_hash', async () => {
    const privateKey = utils.randomPrivateKey();
    const publicKey = await getPublicKey(privateKey);
    const publicKeyB58 = base58Encode(publicKey);

    const res = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKeyB58 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.challenge_id).toBeDefined();
    expect(data.challenge).toBeDefined();
    expect(data.difficulty).toBe(DEFAULT_DIFFICULTY);
    expect(data.previous_hash).toBeDefined();
    expect(data.expires_at).toBeDefined();
  });

  it('returns 409 for already-registered agent', async () => {
    const { publicKeyB58 } = await doFullRegistration(app);

    // Now try to init again with the same key
    const res = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKeyB58 }),
    });

    expect(res.status).toBe(409);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('conflict');
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing public_key', async () => {
    const res = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/register/complete', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('full registration flow succeeds (201)', async () => {
    const { completeRes } = await doFullRegistration(app);
    expect(completeRes.status).toBe(201);
    const data = await completeRes.json() as Record<string, unknown>;
    expect(data.agent_id).toBeDefined();
    expect(data.status).toBe('active'); // every registration is active
    expect(data.chain_sequence).toBeDefined();
    expect(data.entry_hash).toBeDefined();
  });

  it('chain entry is created on registration', async () => {
    const { completeRes, agentId } = await doFullRegistration(app);
    expect(completeRes.status).toBe(201);

    const chainEntry = await db.get<{ agent_id: string }>(
      'SELECT agent_id FROM chain WHERE agent_id = ?', agentId
    );
    expect(chainEntry).not.toBeNull();
    expect(chainEntry!.agent_id).toBe(agentId);
  });

  it('expired challenge → 400', async () => {
    const privateKey = utils.randomPrivateKey();
    const publicKey = await getPublicKey(privateKey);
    const publicKeyB58 = base58Encode(publicKey);

    const agentId = publicKeyToAgentId(publicKey);

    // Manually insert an expired challenge
    const challengeId = crypto.randomUUID();
    const now = new Date();
    const expired = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago

    await db.run(
      `INSERT INTO challenges (id, agent_id, challenge_bytes, status, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
      challengeId, agentId, 'somechallenge', now.toISOString(), expired.toISOString()
    );

    // Dummy nonce (PoW is mocked to always pass)
    const nonce = 'deadbeefdeadbeef';
    const challengeData = new TextEncoder().encode('somechallenge');
    const sigBytes = await sign(challengeData, privateKey);
    const signature = btoa(String.fromCharCode(...sigBytes));

    const res = await app.request('/v1/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challengeId,
        public_key: publicKeyB58,
        signature,
        nonce,
        profile: {
          name: 'ExpiredTest',
          description: 'test',
          capabilities: ['test'],
          protocols: ['http'],
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message).toContain('expired');
  });

  it('invalid signature → 400', async () => {
    const privateKey = utils.randomPrivateKey();
    const publicKey = await getPublicKey(privateKey);
    const publicKeyB58 = base58Encode(publicKey);

    // Get a valid challenge
    const initRes = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKeyB58 }),
    });
    const { challenge_id } = await initRes.json() as { challenge_id: string };

    // Dummy nonce (PoW is mocked to always pass)
    const nonce = 'deadbeefdeadbeef';
    // Use wrong signature (sign something else)
    const wrongMsg = new TextEncoder().encode('wrong message');
    const sigBytes = await sign(wrongMsg, privateKey);
    const signature = btoa(String.fromCharCode(...sigBytes));

    const res = await app.request('/v1/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id,
        public_key: publicKeyB58,
        signature,
        nonce,
        profile: {
          name: 'InvalidSigTest',
          description: 'test',
          capabilities: ['test'],
          protocols: ['http'],
        },
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message.toLowerCase()).toContain('signature');
  });

  it('response includes profile_url, badge_url, embed_markdown, embed_html', async () => {
    const { completeRes, agentId } = await doFullRegistration(app, { name: 'EmbedTestBot' });
    expect(completeRes.status).toBe(201);
    const data = await completeRes.json() as Record<string, unknown>;
    expect(data.profile_url).toBe('https://basedagents.ai/agent/EmbedTestBot');
    expect(data.badge_url).toBe(`https://api.basedagents.ai/v1/agents/${agentId}/badge`);
    expect(typeof data.embed_markdown).toBe('string');
    expect((data.embed_markdown as string)).toContain(data.badge_url as string);
    expect((data.embed_markdown as string)).toContain(data.profile_url as string);
    expect(typeof data.embed_html).toBe('string');
    expect((data.embed_html as string)).toContain(data.badge_url as string);
    expect((data.embed_html as string)).toContain(data.profile_url as string);
  });

  it('with 100+ active agents, registration without contact_endpoint is still active (no bootstrap threshold)', async () => {
    // Insert 100 active agents directly into the database
    for (let i = 0; i < 100; i++) {
      const pk = utils.randomPrivateKey();
      const pub = await getPublicKey(pk);
      const id = publicKeyToAgentId(pub);
      await db.run(
        `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, registered_at, status, reputation_score, verification_count)
         VALUES (?, ?, ?, 'test', '["test"]', '["http"]', ?, 'active', 0.0, 0)`,
        id, pub, `BulkAgent-${i}`, new Date().toISOString()
      );
    }

    // Registering without contact_endpoint still succeeds, active, with no
    // pending state or first-verification assignment.
    const { completeRes } = await doFullRegistration(app, { name: 'NoEndpointAgent' });
    expect(completeRes.status).toBe(201);
    const data = await completeRes.json() as Record<string, unknown>;
    expect(data.status).toBe('active');
    expect(data.message).toBe('Registration complete. Agent is active.');
    expect(data).not.toHaveProperty('bootstrap_mode');
    expect(data).not.toHaveProperty('first_verification');
  });

  it('duplicate name → 409', async () => {
    const sharedName = `UniqueName-${Date.now()}`;

    // First registration succeeds
    const { completeRes: first } = await doFullRegistration(app, {
      name: sharedName,
    });
    expect(first.status).toBe(201);

    // Second registration with same name → 409
    const privateKey2 = utils.randomPrivateKey();
    const publicKey2 = await getPublicKey(privateKey2);
    const publicKeyB58_2 = base58Encode(publicKey2);

    const initRes2 = await app.request('/v1/register/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: publicKeyB58_2 }),
    });
    const initData2 = await initRes2.json() as { challenge_id: string; challenge: string };

    const challengeData2 = new TextEncoder().encode(initData2.challenge);
    const sigBytes2 = await sign(challengeData2, privateKey2);
    const signature2 = btoa(String.fromCharCode(...sigBytes2));
    const nonce2 = 'deadbeefdeadbeef'; // PoW mocked to always pass

    const completeRes2 = await app.request('/v1/register/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: initData2.challenge_id,
        public_key: publicKeyB58_2,
        signature: signature2,
        nonce: nonce2,
        profile: {
          name: sharedName, // same name!
          description: 'Another test bot',
          capabilities: ['test'],
          protocols: ['http'],
        },
      }),
    });

    expect(completeRes2.status).toBe(409);
  });
});

describe('name skeleton collisions (anti-impersonation, board spec \u00a74)', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('stores name_skeleton on new registrations', async () => {
    const { completeRes, agentId } = await doFullRegistration(app, { name: 'SkeletonStoreBot' });
    expect(completeRes.status).toBe(201);
    const row = await db.get<{ name_skeleton: string | null }>(
      'SELECT name_skeleton FROM agents WHERE id = ?', agentId
    );
    expect(row?.name_skeleton).toBe('skeletonstorebot');
  });

  it('rejects a Cyrillic homoglyph of an existing name (409)', async () => {
    const { completeRes: first } = await doFullRegistration(app, { name: 'GenesisAgent' });
    expect(first.status).toBe(201);

    // "G\u0435n\u0435sisAg\u0435nt" \u2014 Cyrillic \u0435 for every e. Passes the exact-name
    // NOCASE check (raw strings differ) but renders pixel-identical.
    const { completeRes: second } = await doFullRegistration(app, { name: 'G\u0435n\u0435sisAg\u0435nt' });
    expect(second.status).toBe(409);
    const data = await second.json() as { error: string; message: string };
    expect(data.error).toBe('conflict');
    expect(data.message).toContain('confusable');
  });

  it('rejects zero-width padding of an existing name (409)', async () => {
    const { completeRes: first } = await doFullRegistration(app, { name: 'ZeroWidthBot' });
    expect(first.status).toBe(201);

    const { completeRes: second } = await doFullRegistration(app, { name: 'Zero\u200BWidthBot' });
    expect(second.status).toBe(409);
  });

  it('distinct names still register (no false collision)', async () => {
    const { completeRes: a } = await doFullRegistration(app, { name: 'DistinctAlpha' });
    const { completeRes: b } = await doFullRegistration(app, { name: 'DistinctBeta' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it('grandfathers pre-0033 rows with NULL skeletons (look-alike of a legacy name passes)', async () => {
    // A row registered before the migration: no skeleton \u2014 forward-only
    // enforcement means it never participates in collision checks until
    // scripts/backfill-skeletons.ts runs.
    await db.run(
      `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, registered_at, status, reputation_score, verification_count)
       VALUES ('ag_legacy1', X'00', 'LegacyBot', 'test', '["test"]', '["http"]', ?, 'active', 0.0, 0)`,
      new Date().toISOString()
    );

    // Cyrillic \u0435 look-alike of LegacyBot: skeletons WOULD collide, but the
    // legacy row has NULL, so registration goes through.
    const { completeRes } = await doFullRegistration(app, { name: 'L\u0435gacyBot' });
    expect(completeRes.status).toBe(201);
  });
});
