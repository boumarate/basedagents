import { Hono } from 'hono';
import type { AppEnv, Challenge } from '../types/index.js';
import { postTweet, registrationTweet } from '../lib/twitter.js';
import { RegisterInitSchema, RegisterCompleteSchema } from '../types/index.js';
import { fireWebhook } from '../lib/webhooks.js';
import { isSafeUrl } from '../lib/url-validator.js';
import { nameSkeleton } from '../lib/skeleton.js';
import {
  base58Decode,
  publicKeyToAgentId,
  verifySignature,
  verifyProofOfWork,
  computeChainHash,
  hashProfile,
  DEFAULT_DIFFICULTY,
  GENESIS_HASH,
} from '../crypto/index.js';

/**
 * Generate a random hex string (replacement for node:crypto randomBytes).
 * Uses Web Crypto API — works on both Workers and Node.js 20+.
 */
function generateRandomBase64(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  // Convert to base64
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

const register = new Hono<AppEnv>();

/**
 * POST /v1/register/init
 * Agent sends its public key. Registry returns a challenge + current difficulty.
 */
register.post('/init', async (c) => {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const parsed = RegisterInitSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'bad_request',
      message: 'Validation failed',
      details: parsed.error.flatten(),
    }, 400);
  }

  const { public_key: base58PubKey } = parsed.data;

  // Decode and validate public key format (must be 32 bytes for Ed25519)
  let publicKey: Uint8Array;
  try {
    publicKey = base58Decode(base58PubKey);
    if (publicKey.length !== 32) {
      return c.json({ error: 'bad_request', message: 'Public key must be 32 bytes (Ed25519)' }, 400);
    }
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base58-encoded public key' }, 400);
  }

  const db = c.get('db');
  const agentId = publicKeyToAgentId(publicKey);

  // Check if agent already registered
  const existing = await db.get<{ id: string }>('SELECT id FROM agents WHERE id = ?', agentId);
  if (existing) {
    return c.json({ error: 'conflict', message: 'Agent with this public key is already registered' }, 409);
  }

  // Expire old pending challenges for this agent
  await db.run(
    "UPDATE challenges SET status = 'expired' WHERE agent_id = ? AND status = 'pending'",
    agentId
  );

  // Generate challenge (32 random bytes, base64-encoded)
  const challengeBytes = generateRandomBase64(32);
  const challengeId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes

  // Get latest chain hash
  const latestEntry = await db.get<{ entry_hash: string }>(
    'SELECT entry_hash FROM chain ORDER BY sequence DESC LIMIT 1'
  );
  const previousHash = latestEntry?.entry_hash ?? GENESIS_HASH;

  // Store challenge
  await db.run(
    `INSERT INTO challenges (id, agent_id, challenge_bytes, status, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    challengeId,
    agentId,
    challengeBytes,
    now.toISOString(),
    expiresAt.toISOString()
  );

  return c.json({
    challenge_id: challengeId,
    challenge: challengeBytes,
    difficulty: DEFAULT_DIFFICULTY,
    previous_hash: previousHash,
    expires_at: expiresAt.toISOString(),
  });
});

/**
 * POST /v1/register/complete
 * Agent submits proof-of-work nonce, signed challenge, and profile.
 */
register.post('/complete', async (c) => {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400);
  }

  const parsed = RegisterCompleteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'bad_request',
      message: 'Validation failed',
      details: parsed.error.flatten(),
    }, 400);
  }

  const { challenge_id, public_key: base58PubKey, signature, nonce, profile, wallet_address, wallet_network } = parsed.data;
  const db = c.get('db');

  // 1. Decode public key
  let publicKey: Uint8Array;
  try {
    publicKey = base58Decode(base58PubKey);
    if (publicKey.length !== 32) {
      return c.json({ error: 'bad_request', message: 'Public key must be 32 bytes' }, 400);
    }
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base58-encoded public key' }, 400);
  }

  const agentId = publicKeyToAgentId(publicKey);

  // 2. Look up challenge and verify it's valid
  const challenge = await db.get<Challenge>(
    "SELECT * FROM challenges WHERE id = ? AND agent_id = ? AND status = 'pending'",
    challenge_id, agentId
  );

  if (!challenge) {
    return c.json({ error: 'bad_request', message: 'Challenge not found or already used' }, 400);
  }

  // 3. Check challenge hasn't expired
  if (new Date(challenge.expires_at) < new Date()) {
    await db.run("UPDATE challenges SET status = 'expired' WHERE id = ?", challenge_id);
    return c.json({ error: 'bad_request', message: 'Challenge has expired' }, 400);
  }

  // 4. Verify signature over the challenge bytes
  let sigBytes: Uint8Array;
  try {
    const binaryStr = atob(signature);
    sigBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      sigBytes[i] = binaryStr.charCodeAt(i);
    }
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid base64 signature' }, 400);
  }

  // The agent signs the raw challenge bytes
  const challengeData = new TextEncoder().encode(challenge.challenge_bytes);
  const sigValid = await verifySignature(challengeData, sigBytes, publicKey);
  if (!sigValid) {
    return c.json({ error: 'bad_request', message: 'Invalid signature — challenge verification failed' }, 400);
  }

  // 5. Verify proof-of-work (challenge-bound — prevents nonce reuse across attempts, L3)
  if (!verifyProofOfWork(publicKey, nonce, DEFAULT_DIFFICULTY, challenge.challenge_bytes)) {
    return c.json({ error: 'bad_request', message: 'Proof-of-work verification failed' }, 400);
  }

  // 5b. Check name uniqueness (case-insensitive)
  const existing = await db.get<{ id: string }>(
    'SELECT id FROM agents WHERE name = ? COLLATE NOCASE',
    profile.name
  );
  if (existing) {
    return c.json({ error: 'conflict', message: `Agent name '${profile.name}' is already taken` }, 409);
  }

  // 5c. Anti-impersonation (board spec §4): names that are pixel-identical to
  // an existing name — Cyrillic/Greek homoglyphs, zero-width padding,
  // diacritic dress-up — must collide even though the raw strings differ.
  // Forward-only: rows registered before 0033 have NULL skeletons until
  // scripts/backfill-skeletons.ts runs, and NULL never matches this SELECT,
  // so they're grandfathered rather than 500ing registration. No UNIQUE
  // backstop like the name column has: the backfill can legitimately mint
  // duplicate skeletons among grandfathered rows, so the index can't be
  // unique — the remaining SELECT-INSERT race admits one look-alike NAME at
  // worst (display confusion, not identity collision; the cert badge stays
  // the trust signal), which isn't worth a rebuild-and-lock dance.
  const skeleton = nameSkeleton(profile.name);
  const lookalike = await db.get<{ name: string }>(
    'SELECT name FROM agents WHERE name_skeleton = ?',
    skeleton
  );
  if (lookalike) {
    return c.json({
      error: 'conflict',
      message: `Agent name '${profile.name}' is confusable with existing agent '${lookalike.name}' — pick a visually distinct name`,
    }, 409);
  }

  // 6. Create chain entry
  const latestEntry = await db.get<{ entry_hash: string }>(
    'SELECT entry_hash FROM chain ORDER BY sequence DESC LIMIT 1'
  );
  const previousHash = latestEntry?.entry_hash ?? GENESIS_HASH;

  const timestamp = new Date().toISOString();
  const profileHash = hashProfile(profile as unknown as Record<string, unknown>);
  const entryHash = computeChainHash(previousHash, publicKey, nonce, profileHash, timestamp);

  // SSRF protection: validate contact_endpoint and webhook_url (CRIT-1, CRIT-2)
  if (profile.contact_endpoint && !isSafeUrl(profile.contact_endpoint)) {
    return c.json({
      error: 'bad_request',
      message: 'contact_endpoint must be a safe HTTPS URL (no private/internal addresses)',
    }, 400);
  }
  if (profile.webhook_url && !isSafeUrl(profile.webhook_url)) {
    return c.json({
      error: 'bad_request',
      message: 'webhook_url must be a safe HTTPS URL (no private/internal addresses)',
    }, 400);
  }

  // 7. Every registration is active. There is no bootstrap threshold and no
  //    pending state: contact_endpoint stays optional (most agents run no
  //    server). Mass registration is held back by proof-of-work on every
  //    registration and unique names; trust comes from peer verification and
  //    reputation. Limits for new agents are an open decision (PLAN-NOTES D7).
  const initialStatus = 'active';

  // MED-6: Generate a webhook_secret when a webhook_url is provided at registration
  const webhookSecret = profile.webhook_url ? generateRandomBase64(32) : null;

  // Insert agent + chain entry + mark challenge completed
  // Run sequentially — both SQLite adapter and D1 handle this correctly.
  // Wrap INSERT to handle UNIQUE constraint race (LOW-8: TOCTOU on name uniqueness)
  try {
    await db.run(
    `INSERT INTO agents (id, public_key, name, name_skeleton, description, capabilities, protocols, offers, needs, homepage, contact_endpoint, comment, organization, organization_url, logo_url, tags, version, contact_email, x_handle, skills, webhook_url, webhook_secret, wallet_address, wallet_network, registered_at, status, reputation_score, verification_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, 0)`,
    agentId,
    publicKey,
    profile.name,
    skeleton,
    profile.description,
    JSON.stringify(profile.capabilities),
    JSON.stringify(profile.protocols),
    profile.offers ? JSON.stringify(profile.offers) : null,
    profile.needs ? JSON.stringify(profile.needs) : null,
    profile.homepage ?? null,
    profile.contact_endpoint ?? null,
    profile.comment ?? null,
    profile.organization ?? null,
    profile.organization_url ?? null,
    profile.logo_url ?? null,
    profile.tags ? JSON.stringify(profile.tags) : null,
    profile.version ?? null,
    profile.contact_email ?? null,
    profile.x_handle ? (profile.x_handle.startsWith('@') ? profile.x_handle : `@${profile.x_handle}`) : null,
    profile.skills ? JSON.stringify(profile.skills) : null,
    profile.webhook_url ?? null,
    webhookSecret,
    // D8: a payout wallet needs a proof of control, which registration can't
    // carry (PATCH /v1/agents/:id/wallet does). An address sent here is not saved.
    null,
    wallet_network ?? 'eip155:8453',
    timestamp,
    initialStatus
  );
  } catch (insertErr: unknown) {
    // UNIQUE constraint on name — race condition between SELECT and INSERT (TOCTOU)
    const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      return c.json({ error: 'conflict', message: `Agent name '${profile.name}' is already taken` }, 409);
    }
    throw insertErr;
  }

  // Derive sequence as MAX(sequence)+1 rather than AUTOINCREMENT so deletions
  // during cleanup never leave gaps in the chain display.
  const seqRow = await db.get<{ next_seq: number }>(
    'SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq FROM chain'
  );
  const nextSeq = seqRow!.next_seq;

  await db.run(
    `INSERT INTO chain (sequence, entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    nextSeq,
    entryHash,
    previousHash,
    agentId,
    publicKey,
    nonce,
    profileHash,
    timestamp
  );

  await db.run(
    "UPDATE challenges SET status = 'completed' WHERE id = ?",
    challenge_id
  );

  // Get the sequence number
  const chainEntry = await db.get<{ sequence: number }>(
    'SELECT sequence FROM chain WHERE entry_hash = ?',
    entryHash
  );


  const profileUrl = `https://basedagents.ai/agent/${encodeURIComponent(profile.name)}`;
  const badgeUrl = `https://api.basedagents.ai/v1/agents/${agentId}/badge`;
  const embedMarkdown = `[![BasedAgents](${badgeUrl})](${profileUrl})`;
  const embedHtml = `<a href='${profileUrl}'><img src='${badgeUrl}' alt='BasedAgents' /></a>`;

  const responseBody: Record<string, unknown> = {
    agent_id: agentId,
    status: initialStatus,
    chain_sequence: chainEntry!.sequence,
    entry_hash: entryHash,
    profile_url: profileUrl,
    badge_url: badgeUrl,
    embed_markdown: embedMarkdown,
    embed_html: embedHtml,
    message: 'Registration complete. Agent is active.',
    important: `TELL YOUR HUMAN: You are now registered on basedagents.ai as "${profile.name}". Your keypair (private key) must be backed up — losing it means losing this identity forever. Your public profile is at ${profileUrl}. Share it and embed the badge in your README.`,
    webhook_secret: webhookSecret,
  };
  if (wallet_address) {
    responseBody.wallet_not_saved = `The payout wallet ${wallet_address} was not saved: a wallet needs a signature from it. Set it with PATCH /v1/agents/${agentId}/wallet (or: npx basedagents wallet set ${wallet_address}).`;
  }

  // Fire-and-forget tweet for new registration
  const env = c.env;
  if (env.TWITTER_CONSUMER_KEY && env.TWITTER_CONSUMER_SECRET &&
      env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_SECRET) {
    const tweetText = registrationTweet({
      name: profile.name,
      x_handle: profile.x_handle ?? null,
      capabilities: profile.capabilities,
      agent_id: agentId,
    });
    postTweet(tweetText, {
      consumerKey: env.TWITTER_CONSUMER_KEY,
      consumerSecret: env.TWITTER_CONSUMER_SECRET,
      accessToken: env.TWITTER_ACCESS_TOKEN,
      accessSecret: env.TWITTER_ACCESS_SECRET,
    }); // intentionally not awaited
  }

  // ── Webhook: agent.registered → all agents with a webhook_url ──
  const webhookRecipients = await db.all<{ id: string; webhook_url: string; webhook_secret: string | null }>(
    'SELECT id, webhook_url, webhook_secret FROM agents WHERE webhook_url IS NOT NULL AND id != ?',
    agentId
  );
  for (const recipient of webhookRecipients) {
    fireWebhook(recipient.webhook_url, {
      type: 'agent.registered',
      agent_id: agentId,
      name: profile.name,
      capabilities: profile.capabilities,
    }, recipient.webhook_secret); // intentionally not awaited
  }

  return c.json(responseBody, 201);
});

export default register;
