import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sign } from '@noble/ed25519';
import { canonicalJsonStringify } from '../crypto/index.js';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
  makeEligibleVerifier,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';

// Mock twitter
vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

// Mock skills resolver to avoid DB issues
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Insert a valid verification assignment into the database.
 */
async function insertAssignment(
  db: SQLiteAdapter,
  assignmentId: string,
  verifierId: string,
  targetId: string,
  options: { expired?: boolean; used?: boolean } = {}
): Promise<void> {
  const now = new Date();
  const expiresAt = options.expired
    ? new Date(now.getTime() - 60_000).toISOString()  // expired 1 min ago
    : new Date(now.getTime() + 10 * 60_000).toISOString(); // 10 min from now
  await db.run(
    `INSERT INTO verification_assignments (assignment_id, verifier_agent_id, target_agent_id, created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, ?)`,
    assignmentId, verifierId, targetId, now.toISOString(), expiresAt, options.used ? 1 : 0
  );
}

/**
 * Build the JSON body and signature for a verification submission.
 */
async function buildVerificationBody(
  verifierKeypair: TestKeypair,
  targetId: string,
  result: 'pass' | 'fail' | 'timeout',
  options: {
    nonce?: string;
    assignmentId?: string;
    coherenceScore?: number;
    structuredReport?: Record<string, unknown> | null;
  } = {}
) {
  const assignmentId = options.assignmentId ?? crypto.randomUUID();
  const nonce = options.nonce ?? crypto.randomUUID();
  const coherenceScore = options.coherenceScore ?? (result === 'pass' ? 0.9 : 0.1);
  const structuredReport = options.structuredReport === undefined
    ? undefined
    : options.structuredReport;

  const timestamp = new Date().toISOString();

  // Build the signed fields — must match the server's reconstruction order.
  // All fields including structured_report are covered by the inner signature (M4).
  const signedFields: {
    assignment_id: string;
    target_id: string;
    result: 'pass' | 'fail' | 'timeout';
    nonce: string;
    timestamp: string;
    coherence_score?: number;
    notes?: string;
    response_time_ms?: number;
    structured_report?: Record<string, unknown>;
  } = {
    assignment_id: assignmentId,
    target_id: targetId,
    result,
    nonce,
    timestamp,
  };
  signedFields.coherence_score = coherenceScore;
  signedFields.notes = 'test verification';
  signedFields.response_time_ms = 150;
  if (structuredReport !== undefined && structuredReport !== null) {
    signedFields.structured_report = structuredReport;
  }
  const reportData = canonicalJsonStringify(signedFields);

  const reportBytes = new TextEncoder().encode(reportData);
  const sigBytes = await sign(reportBytes, verifierKeypair.privateKey);
  const signature = btoa(String.fromCharCode(...sigBytes));

  return {
    ...signedFields,
    signature,
  };
}

describe('POST /v1/verify/submit', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let verifier: TestKeypair & { name: string };
  let target: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    verifier = await createTestAgent(db, { reputationScore: 0.5, status: 'active' });
    await makeEligibleVerifier(db, verifier.agentId);
    target = await createTestAgent(db, { reputationScore: 0, status: 'pending' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('full verification flow returns ok with reputation delta', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, target.agentId);
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.verification_id).toBeDefined();
    expect(typeof data.target_reputation_delta).toBe('number');
    expect(typeof data.verifier_reputation_delta).toBe('number');
  });

  it('self-verification → 400', async () => {
    const body = await buildVerificationBody(verifier, verifier.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, verifier.agentId);
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('bad_request');
  });

  it('duplicate nonce → 400', async () => {
    const sharedNonce = crypto.randomUUID();
    const body1 = await buildVerificationBody(verifier, target.agentId, 'pass', { nonce: sharedNonce });
    await insertAssignment(db, body1.assignment_id, verifier.agentId, target.agentId);
    const bodyStr1 = JSON.stringify(body1);
    const authHeaders1 = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr1);

    // First submission succeeds
    const res1 = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders1 },
      body: bodyStr1,
    });
    expect(res1.status).toBe(200);

    // Need a second target to avoid the self-verification ban
    const target2 = await createTestAgent(db, { reputationScore: 0, status: 'pending' });
    // Re-sign with same nonce but different target — nonce collision should still fail
    const body2 = await buildVerificationBody(verifier, target2.agentId, 'pass', { nonce: sharedNonce });
    await insertAssignment(db, body2.assignment_id, verifier.agentId, target2.agentId);
    const bodyStr2 = JSON.stringify(body2);
    const authHeaders2 = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr2);

    const res2 = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders2 },
      body: bodyStr2,
    });
    expect(res2.status).toBe(400);
    const data = await res2.json() as { message: string };
    expect(data.message.toLowerCase()).toContain('nonce');
  });

  it('invalid report signature → 400', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, target.agentId);

    // Corrupt the signature
    body.signature = btoa('invalidsignature'.repeat(4));

    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message.toLowerCase()).toContain('signature');
  });

  it('target not found → 404', async () => {
    const fakeTargetId = 'ag_nonexistentXYZ123';
    const body = await buildVerificationBody(verifier, fakeTargetId, 'pass');
    // Temporarily disable FK constraints to insert assignment with nonexistent target
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run(
      `INSERT INTO verification_assignments (assignment_id, verifier_agent_id, target_agent_id, created_at, expires_at, used)
       VALUES (?, ?, ?, ?, ?, 0)`,
      body.assignment_id, verifier.agentId, fakeTargetId, new Date().toISOString(),
      new Date(Date.now() + 600000).toISOString()
    );
    await db.exec('PRAGMA foreign_keys = ON');
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(404);
  });

  it('status transition: pending → active after first pass verification', async () => {
    // Verify target starts as pending
    const before = await db.get<{ status: string }>(
      'SELECT status FROM agents WHERE id = ?', target.agentId
    );
    expect(before!.status).toBe('pending');

    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, target.agentId);
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(200);

    const after = await db.get<{ status: string }>(
      'SELECT status FROM agents WHERE id = ?', target.agentId
    );
    expect(after!.status).toBe('active');
  });

  it('reputation delta is returned in response', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, target.agentId);
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(typeof data.target_reputation_delta).toBe('number');
  });

  it('webhook is fired when target has webhook_url', async () => {
    // Create target with webhook_url
    const webhookTarget = await createTestAgent(db, {
      reputationScore: 0,
      status: 'pending',
      webhookUrl: 'https://webhook.example.com/events',
    });

    const body = await buildVerificationBody(verifier, webhookTarget.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, webhookTarget.agentId);
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(200);

    // Give fire-and-forget webhooks a tick to execute
    await new Promise(r => setTimeout(r, 10));

    // fetch should have been called with the webhook URL
    const webhookCalls = mockFetch.mock.calls.filter(
      ([url]: string[]) => url === 'https://webhook.example.com/events'
    );
    expect(webhookCalls.length).toBeGreaterThan(0);
  });

  it('unauthorized request (no auth header) → 401', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    const bodyStr = JSON.stringify(body);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    });
    expect(res.status).toBe(401);
  });

  // ── H1: Replay attack protection ──

  it('replay attack rejected — same signature used twice → 401', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, target.agentId);
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    // First request succeeds
    const res1 = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res1.status).toBe(200);

    // Replay the exact same request (same auth headers = same signature)
    // Need a new assignment for the body's assignment_id (old one is used), but the auth replay
    // should be caught before we even get to assignment validation
    const res2 = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res2.status).toBe(401);
    const data = await res2.json() as { message: string };
    expect(data.message).toContain('replay');
  });

  // ── H2: Assignment validation ──

  it('fabricated assignment ID rejected → 400', async () => {
    const fakeAssignmentId = crypto.randomUUID();
    const body = await buildVerificationBody(verifier, target.agentId, 'pass', {
      assignmentId: fakeAssignmentId,
    });
    // Do NOT insert assignment — it's fabricated
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message).toContain('assignment');
  });

  it('expired assignment rejected → 400', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, target.agentId, { expired: true });
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message.toLowerCase()).toContain('expired');
  });

  it('assignment with wrong verifier rejected → 400', async () => {
    const otherAgent = await createTestAgent(db, { reputationScore: 0.5, status: 'active' });
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    // Assignment was issued to a different agent
    await insertAssignment(db, body.assignment_id, otherAgent.agentId, target.agentId);
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message).toContain('verifier');
  });

  it('assignment with wrong target rejected → 400', async () => {
    const otherTarget = await createTestAgent(db, { reputationScore: 0, status: 'pending' });
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    // Assignment was issued for a different target
    await insertAssignment(db, body.assignment_id, verifier.agentId, otherTarget.agentId);
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message).toContain('target');
  });

  it('already-used assignment rejected → 400', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    await insertAssignment(db, body.assignment_id, verifier.agentId, target.agentId, { used: true });
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message.toLowerCase()).toContain('used');
  });

  it('valid assignment flow works end to end', async () => {
    // Only agents with a contact_endpoint are assigned
    await db.run('UPDATE agents SET contact_endpoint = ? WHERE id = ?', 'https://target.example.com/verify', target.agentId);
    // Get assignment via the API
    const assignmentHeaders = await signRequest(verifier, 'GET', '/v1/verify/assignment');
    const assignRes = await app.request('/v1/verify/assignment', {
      method: 'GET',
      headers: assignmentHeaders,
    });
    expect(assignRes.status).toBe(200);
    const assignData = await assignRes.json() as { assignment_id: string; target: { agent_id: string } };

    // Submit verification using the assignment
    const body = await buildVerificationBody(verifier, assignData.target.agent_id, 'pass', {
      assignmentId: assignData.assignment_id,
    });
    const bodyStr = JSON.stringify(body);
    const submitHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const submitRes = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...submitHeaders },
      body: bodyStr,
    });
    expect(submitRes.status).toBe(200);
    const submitData = await submitRes.json() as { ok: boolean; verification_id: string };
    expect(submitData.ok).toBe(true);
    expect(submitData.verification_id).toBeDefined();
  });

  // ── NEW-4: Timestamp is required in verification submissions ──

  it('missing timestamp → 400 (NEW-4: timestamp required)', async () => {
    // Build a body without timestamp — schema should reject it
    const assignmentId = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    await insertAssignment(db, assignmentId, verifier.agentId, target.agentId);

    // Build signed fields WITHOUT timestamp
    const signedFields: Record<string, unknown> = {
      assignment_id: assignmentId,
      target_id: target.agentId,
      result: 'pass',
      nonce,
      coherence_score: 0.9,
      notes: 'test',
    };
    const reportData = canonicalJsonStringify(signedFields);
    const reportBytes = new TextEncoder().encode(reportData);
    const { sign: edSign } = await import('@noble/ed25519');
    const sigBytes = await edSign(reportBytes, verifier.privateKey);
    const signature = btoa(String.fromCharCode(...sigBytes));

    // Omit timestamp from the request body
    const bodyWithoutTimestamp = {
      ...signedFields,
      signature,
      // timestamp intentionally omitted
    };

    const bodyStr = JSON.stringify(bodyWithoutTimestamp);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(400);
  });

  it('invalid timestamp format → 400 (NEW-4: timestamp must be ISO datetime)', async () => {
    const assignmentId = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    await insertAssignment(db, assignmentId, verifier.agentId, target.agentId);

    const signedFields: Record<string, unknown> = {
      assignment_id: assignmentId,
      target_id: target.agentId,
      result: 'pass',
      nonce,
      timestamp: 'not-a-valid-datetime', // invalid format
      coherence_score: 0.9,
    };
    const reportData = canonicalJsonStringify(signedFields);
    const reportBytes = new TextEncoder().encode(reportData);
    const { sign: edSign } = await import('@noble/ed25519');
    const sigBytes = await edSign(reportBytes, verifier.privateKey);
    const signature = btoa(String.fromCharCode(...sigBytes));

    const bodyStr = JSON.stringify({ ...signedFields, signature });
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /v1/verify/assignment', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let verifier: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    verifier = await createTestAgent(db, { reputationScore: 0.5, status: 'active' });
  });

  async function getAssignment() {
    const headers = await signRequest(verifier, 'GET', '/v1/verify/assignment');
    return app.request('/v1/verify/assignment', { method: 'GET', headers });
  }

  it('never assigns an agent without a contact_endpoint (it could only time out)', async () => {
    const probeable = await createTestAgent(db, { status: 'active' });
    await db.run('UPDATE agents SET contact_endpoint = ? WHERE id = ?', 'https://probeable.example.com/verify', probeable.agentId);
    for (let i = 0; i < 3; i++) await createTestAgent(db, { status: 'active' }); // endpoint-less

    for (let i = 0; i < 10; i++) {
      const res = await getAssignment();
      expect(res.status).toBe(200);
      const data = await res.json() as { target: { agent_id: string; contact_endpoint: string }; bootstrap_mode?: boolean };
      expect(data.target.agent_id).toBe(probeable.agentId);
      expect(data.target.contact_endpoint).toBe('https://probeable.example.com/verify');
      expect(data).not.toHaveProperty('bootstrap_mode');
    }
  });

  it('404 no_assignment when no other agent has a contact_endpoint', async () => {
    await createTestAgent(db, { status: 'active' });
    const res = await getAssignment();
    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('no_assignment');
  });
});
