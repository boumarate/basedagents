import { Hono } from 'hono';
import type { AppEnv, Agent } from '../types/index.js';
import { postTweet, firstVerificationTweet } from '../lib/twitter.js';
import { VerifySubmitSchema } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { verifySignature, canonicalJsonStringify } from '../crypto/index.js';
import { computeReputation } from '../reputation/calculator.js';
import { runEigenTrust } from '../reputation/eigentrust.js';
import { computeSkillReputations } from '../skills/resolver.js';
import type { DBAdapter } from '../db/adapter.js';
import { fireWebhook } from '../lib/webhooks.js';

const verify = new Hono<AppEnv>();

/**
 * Update agent status based on reputation and verification history.
 * Returns the new status if it changed, or null if unchanged.
 */
async function updateAgentStatus(db: DBAdapter, agentId: string, _rep: number): Promise<{ oldStatus: string; newStatus: string } | null> {
  // Snapshot status before any updates
  const before = await db.get<{ status: string }>('SELECT status FROM agents WHERE id = ?', agentId);
  const oldStatus = before?.status ?? 'pending';

  // Atomic status transitions — conditional UPDATEs avoid TOCTOU races from concurrent verifications.
  // Each UPDATE only fires when the current status matches the expected source state.

  // pending → active: any passing verification
  await db.run(
    `UPDATE agents SET status = 'active'
     WHERE id = ? AND status = 'pending'
       AND EXISTS (SELECT 1 FROM verifications WHERE target_id = ? AND result = 'pass')`,
    agentId, agentId
  );

  // active → suspended: last 5 verifications are all timeouts
  await db.run(
    `UPDATE agents SET status = 'suspended'
     WHERE id = ? AND status = 'active'
       AND (SELECT COUNT(*) FROM (
         SELECT result FROM verifications WHERE target_id = ? ORDER BY created_at DESC LIMIT 5
       ) sub WHERE sub.result = 'timeout') = 5
       AND (SELECT COUNT(*) FROM verifications WHERE target_id = ?) >= 5`,
    agentId, agentId, agentId
  );

  // suspended → active: most recent verification passed
  await db.run(
    `UPDATE agents SET status = 'active'
     WHERE id = ? AND status = 'suspended'
       AND (SELECT result FROM verifications WHERE target_id = ? ORDER BY created_at DESC LIMIT 1) = 'pass'`,
    agentId, agentId
  );

  // Check if status changed
  const after = await db.get<{ status: string }>('SELECT status FROM agents WHERE id = ?', agentId);
  const newStatus = after?.status ?? oldStatus;
  return newStatus !== oldStatus ? { oldStatus, newStatus } : null;
}

/**
 * GET /v1/verify/assignment
 * Get a verification assignment for the authenticated agent.
 */
verify.get('/assignment', agentAuth, async (c) => {
  const agentId = c.get('agentId') as string;
  const db = c.get('db');

  // Only agents with a contact_endpoint can be probed. contact_endpoint is
  // optional, and assigning an endpoint-less agent would invite timeout
  // reports that eventually suspend it (5 timeouts in a row).
  const target = await db.get<Pick<Agent, 'id' | 'name' | 'contact_endpoint' | 'capabilities'>>(
    `SELECT id, name, contact_endpoint, capabilities
     FROM agents
     WHERE id != ? AND status IN ('active', 'pending')
       AND contact_endpoint IS NOT NULL AND contact_endpoint != ''
     ORDER BY RANDOM()
     LIMIT 1`,
    agentId
  );

  if (!target) {
    return c.json({ error: 'no_assignment', message: 'No agents with a contact endpoint are available for verification' }, 404);
  }

  const assignmentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

  // Persist assignment for validation on submit
  await db.run(
    `INSERT INTO verification_assignments (assignment_id, verifier_agent_id, target_agent_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    assignmentId, agentId, target.id, now, expiresAt
  );

  // Cleanup expired assignments
  await db.run(
    'DELETE FROM verification_assignments WHERE expires_at < ? AND used = 0',
    now
  );

  return c.json({
    assignment_id: assignmentId,
    target: {
      agent_id: target.id,
      name: target.name,
      contact_endpoint: target.contact_endpoint,
      capabilities: JSON.parse(target.capabilities),
    },
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    instructions: [
      'Contact the agent at its declared endpoint.',
      'Send a capability probe matching its declared capabilities.',
      'Observe: does it respond correctly? Does it use only declared tools?',
      'Check: does it attempt any unsafe or unauthorized actions?',
      'Submit a structured report with your findings.',
    ].join(' '),
  });
});

/**
 * POST /v1/verify/submit
 * Submit verification results with optional structured report.
 */
verify.post('/submit', agentAuth, async (c) => {
  const verifierId = c.get('agentId') as string;
  const db = c.get('db');

  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = VerifySubmitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const { assignment_id, target_id, result, response_time_ms, coherence_score, notes, signature, structured_report, nonce, timestamp } = parsed.data;

  // ── Self-verification ban ──
  if (verifierId === target_id) {
    return c.json({ error: 'bad_request', message: 'Cannot verify yourself' }, 400);
  }

  // ── Assignment validation ──
  const assignment = await db.get<{
    assignment_id: string;
    verifier_agent_id: string;
    target_agent_id: string;
    expires_at: string;
    used: number;
  }>(
    'SELECT assignment_id, verifier_agent_id, target_agent_id, expires_at, used FROM verification_assignments WHERE assignment_id = ?',
    assignment_id
  );

  if (!assignment) {
    return c.json({ error: 'bad_request', message: 'Invalid assignment ID — assignment not found' }, 400);
  }
  if (assignment.used === 1) {
    return c.json({ error: 'bad_request', message: 'Assignment already used' }, 400);
  }
  if (new Date(assignment.expires_at) < new Date()) {
    return c.json({ error: 'bad_request', message: 'Assignment expired' }, 400);
  }
  if (assignment.verifier_agent_id !== verifierId) {
    return c.json({ error: 'bad_request', message: 'Assignment was not issued to this verifier' }, 400);
  }
  if (assignment.target_agent_id !== target_id) {
    return c.json({ error: 'bad_request', message: 'Assignment target does not match submission target' }, 400);
  }

  // Mark assignment as used
  await db.run('UPDATE verification_assignments SET used = 1 WHERE assignment_id = ?', assignment_id);

  // ── Replay check — nonce must be globally unique ──
  const nonceExists = await db.get<{ id: string }>(
    'SELECT id FROM verifications WHERE nonce = ? LIMIT 1', nonce
  );
  if (nonceExists) {
    return c.json({ error: 'bad_request', message: 'Duplicate nonce — this report has already been submitted' }, 400);
  }

  // ── Target must exist ──
  const target = await db.get<{ id: string; name: string; status: string; verification_count: number; x_handle: string | null }>(
    'SELECT id, name, status, verification_count, x_handle FROM agents WHERE id = ?', target_id);
  if (!target) return c.json({ error: 'not_found', message: 'Target agent not found' }, 404);

  // ── Sybil-resistant verifier guard ──
  // Prevents freshly registered accounts from immediately cross-verifying each other.
  // Requirements: registered ≥ 24 hours AND received ≥ 1 verification themselves.
  const verifierRow = await db.get<{ reputation_score: number; verification_count: number; registered_at: string }>(
    'SELECT reputation_score, verification_count, registered_at FROM agents WHERE id = ?', verifierId
  );
  const registeredAt = verifierRow?.registered_at ? new Date(verifierRow.registered_at).getTime() : Date.now();
  const ageHours = (Date.now() - registeredAt) / (1000 * 60 * 60);
  const receivedCount = await db.get<{ count: number }>(
    'SELECT COUNT(*) as count FROM verifications WHERE target_id = ?', verifierId
  );
  if (ageHours < 24) {
    return c.json({
      error: 'forbidden',
      message: 'Verifier must be registered for at least 24 hours before giving verifications.',
    }, 403);
  }
  if ((receivedCount?.count ?? 0) < 1) {
    return c.json({
      error: 'forbidden',
      message: 'Verifier must have received at least 1 verification before giving verifications.',
    }, 403);
  }
  if ((verifierRow?.reputation_score ?? 0) < 0.05) {
    return c.json({
      error: 'forbidden',
      message: 'Verifier reputation too low to submit verifications. Build reputation first.',
    }, 403);
  }

  // ── Verify report signature (nonce is bound into signed payload — prevents replay) ──
  // All fields including structured_report are covered by the inner Ed25519 signature,
  // so chain auditors can verify the full report without relying on transport-layer AgentSig.
  const signedFields: Record<string, unknown> = { assignment_id, target_id, result, nonce, timestamp };
  if (coherence_score !== undefined && coherence_score !== null) signedFields.coherence_score = coherence_score;
  if (notes !== undefined && notes !== null) signedFields.notes = notes;
  if (response_time_ms !== undefined && response_time_ms !== null) signedFields.response_time_ms = response_time_ms;
  if (structured_report !== undefined && structured_report !== null) signedFields.structured_report = structured_report;
  const reportData = canonicalJsonStringify(signedFields);
  let sigBytes: Uint8Array;
  try {
    const bin = atob(signature);
    sigBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) sigBytes[i] = bin.charCodeAt(i);
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base64 signature' }, 400);
  }

  const verifierPubKey = c.get('publicKey') as Uint8Array;
  if (!await verifySignature(new TextEncoder().encode(reportData), sigBytes, verifierPubKey)) {
    return c.json({ error: 'bad_request', message: 'Invalid report signature' }, 400);
  }

  // ── Store verification ──
  const verificationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const structuredReportJson = structured_report ? JSON.stringify(structured_report) : null;

  await db.run(
    `INSERT INTO verifications (id, verifier_id, target_id, result, response_time_ms, coherence_score, notes, signature, structured_report, nonce, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    verificationId, verifierId, target_id, result,
    response_time_ms ?? null, coherence_score ?? null,
    notes ?? null, signature, structuredReportJson, nonce, now
  );

  // ── Handle safety flags ──
  if (structured_report?.safety_issues || structured_report?.unauthorized_actions) {
    await db.run(
      'UPDATE agents SET safety_flags = safety_flags + 1 WHERE id = ?',
      target_id
    );
  }

  // ── Update verification count + last_seen ──
  await db.run('UPDATE agents SET verification_count = verification_count + 1 WHERE id = ?', target_id);
  await db.run('UPDATE agents SET last_seen = ? WHERE id = ?', now, verifierId);

  // ── Recompute reputation for both ──
  const [targetRep, verifierRep] = await Promise.all([
    computeReputation(target_id, db),
    computeReputation(verifierId, db),
  ]);

  const prevTarget = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', target_id);
  const prevVerifier = await db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', verifierId);

  await db.run('UPDATE agents SET reputation_score = ?, penalty_score = ? WHERE id = ?', targetRep.final_score, targetRep.penalty, target_id);
  await db.run('UPDATE agents SET reputation_score = ? WHERE id = ?', verifierRep.final_score, verifierId);

  const targetStatusChange = await updateAgentStatus(db, target_id, targetRep.final_score);
  const verifierStatusChange = await updateAgentStatus(db, verifierId, verifierRep.final_score);

  // Phase 2: run network-wide EigenTrust after local scores are seeded
  await runEigenTrust(db);

  // Phase 3: recompute skill trust scores (inverted — agent rep → skill rep)
  await computeSkillReputations(db);

  // Re-read final scores after EigenTrust (may have adjusted them)
  const [postTarget, postVerifier] = await Promise.all([
    db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', target_id),
    db.get<{ reputation_score: number }>('SELECT reputation_score FROM agents WHERE id = ?', verifierId),
  ]);

  const targetDelta = Math.round(((postTarget?.reputation_score ?? targetRep.final_score) - (prevTarget?.reputation_score ?? 0)) * 1000) / 1000;
  const verifierDelta = Math.round(((postVerifier?.reputation_score ?? verifierRep.final_score) - (prevVerifier?.reputation_score ?? 0)) * 1000) / 1000;

  // ── Webhook: verification.received → target agent ──
  const targetAgent = await db.get<{ webhook_url: string | null; webhook_secret: string | null }>('SELECT webhook_url, webhook_secret FROM agents WHERE id = ?', target_id);
  if (targetAgent?.webhook_url) {
    fireWebhook(targetAgent.webhook_url, {
      type: 'verification.received',
      agent_id: target_id,
      verification_id: verificationId,
      verifier_id: verifierId,
      result,
      coherence_score: coherence_score ?? null,
      reputation_delta: targetDelta,
      new_reputation: postTarget?.reputation_score ?? targetRep.final_score,
    }, targetAgent.webhook_secret); // intentionally not awaited
  }

  // ── Webhook: status.changed → affected agents ──
  if (targetStatusChange) {
    const tAgentWh = targetAgent ?? await db.get<{ webhook_url: string | null; webhook_secret: string | null }>('SELECT webhook_url, webhook_secret FROM agents WHERE id = ?', target_id);
    if (tAgentWh?.webhook_url) {
      fireWebhook(tAgentWh.webhook_url, {
        type: 'status.changed',
        agent_id: target_id,
        old_status: targetStatusChange.oldStatus,
        new_status: targetStatusChange.newStatus,
      }, tAgentWh.webhook_secret); // intentionally not awaited
    }
  }
  if (verifierStatusChange) {
    const vAgentWh = await db.get<{ webhook_url: string | null; webhook_secret: string | null }>('SELECT webhook_url, webhook_secret FROM agents WHERE id = ?', verifierId);
    if (vAgentWh?.webhook_url) {
      fireWebhook(vAgentWh.webhook_url, {
        type: 'status.changed',
        agent_id: verifierId,
        old_status: verifierStatusChange.oldStatus,
        new_status: verifierStatusChange.newStatus,
      }, vAgentWh.webhook_secret); // intentionally not awaited
    }
  }

  // Fire-and-forget tweet on first successful verification
  const wasFirstVerification = (target?.verification_count ?? 0) === 0;
  if (result === 'pass' && wasFirstVerification) {
    const env = c.env;
    if (env.TWITTER_CONSUMER_KEY && env.TWITTER_CONSUMER_SECRET &&
        env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_SECRET) {
      const finalRep = postTarget?.reputation_score ?? targetRep.final_score;
      const tweetText = firstVerificationTweet({
        name: target!.name,
        x_handle: target?.x_handle ?? null,
        reputation_score: finalRep,
        agent_id: target_id,
      });
      postTweet(tweetText, {
        consumerKey: env.TWITTER_CONSUMER_KEY,
        consumerSecret: env.TWITTER_CONSUMER_SECRET,
        accessToken: env.TWITTER_ACCESS_TOKEN,
        accessSecret: env.TWITTER_ACCESS_SECRET,
      }); // intentionally not awaited
    }
  }

  return c.json({
    ok: true,
    verification_id: verificationId,
    target_reputation_delta: targetDelta,
    verifier_reputation_delta: verifierDelta,
    safety_flagged: !!(structured_report?.safety_issues || structured_report?.unauthorized_actions),
  });
});

export default verify;
