import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Agent, Verification } from '../types/index.js';
import { ProfileSchema, WalletUpdateSchema } from '../types/index.js';
import { agentAuth } from '../middleware/auth.js';
import { computeReputation } from '../reputation/calculator.js';
import { hashProfile, computeChainHash, GENESIS_HASH } from '../crypto/index.js';
import { isSafeUrl } from '../lib/url-validator.js';
import { nameSkeleton } from '../lib/skeleton.js';
import { ratingSummary } from '../tasks/service.js';

const agents = new Hono<AppEnv>();

/**
 * Obfuscate an email address for public API responses.
 * The full address is never returned — only a masked version to protect
 * against scraping while still confirming one was registered.
 *
 * hansl@agentmail.com  →  h***l@a******l.com
 * a@b.io               →  a@b.io  (too short to mask, leave as-is)
 */
function obfuscateEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dotIdx = domain.lastIndexOf('.');
  if (dotIdx < 1) return email;

  const domainName = domain.slice(0, dotIdx);
  const tld = domain.slice(dotIdx); // e.g. ".com"

  const maskLocal = local.length <= 2
    ? local
    : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];

  const maskDomain = domainName.length <= 2
    ? domainName
    : domainName[0] + '*'.repeat(domainName.length - 2) + domainName[domainName.length - 1];

  return `${maskLocal}@${maskDomain}${tld}`;
}

/**
 * Format an agent row for public API responses.
 * Sensitive fields (contact_email) are obfuscated — never returned in full.
 */
function formatAgent(agent: Agent) {
  return {
    agent_id: agent.id,
    name: agent.name,
    description: agent.description,
    capabilities: JSON.parse(agent.capabilities),
    protocols: JSON.parse(agent.protocols),
    offers: agent.offers ? JSON.parse(agent.offers) : [],
    needs: agent.needs ? JSON.parse(agent.needs) : [],
    homepage: agent.homepage,
    contact_endpoint: agent.contact_endpoint,
    comment: agent.comment ?? null,
    organization: agent.organization ?? null,
    organization_url: agent.organization_url ?? null,
    logo_url: agent.logo_url ?? null,
    tags: agent.tags ? JSON.parse(agent.tags) : [],
    version: agent.version ?? null,
    contact_email: agent.contact_email ? obfuscateEmail(agent.contact_email) : null,
    x_handle: agent.x_handle ?? null,
    skills: agent.skills ? JSON.parse(agent.skills) : [],
    webhook_url: agent.webhook_url ?? null,
    wallet_address: agent.wallet_address ?? null,
    wallet_network: agent.wallet_network ?? null,
    status: agent.status,
    reputation_score: agent.reputation_score,
    verification_count: agent.verification_count,
    profile_version: (agent as Agent & { profile_version?: number }).profile_version ?? 1,
    registered_at: agent.registered_at,
    last_seen: agent.last_seen,
  };
}

/**
 * GET /v1/agents/search
 * Search/filter agents by capabilities, protocols, offers, needs.
 * Full-text search on name + description. Paginated.
 */
agents.get('/search', async (c) => {
  const db = c.get('db');

  const q = c.req.query('q');
  const capabilities = c.req.query('capabilities');
  const protocols = c.req.query('protocols');
  const offers = c.req.query('offers');
  const needs = c.req.query('needs');
  // Default: all non-revoked/suspended statuses so whois finds pending agents too
  const status = c.req.query('status') || null;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const SORT_WHITELIST = ['reputation', 'registered_at', 'name'] as const;
  type SortKey = typeof SORT_WHITELIST[number];
  const rawSort = c.req.query('sort') || 'reputation';
  const sort: SortKey = (SORT_WHITELIST as readonly string[]).includes(rawSort) ? rawSort as SortKey : 'reputation';
  const offset = (page - 1) * limit;

  /**
   * Escape SQL LIKE wildcards to prevent pattern injection.
   * Combined with parameterized queries (?-binding), this provides
   * defense-in-depth: the binding prevents SQL injection, and the
   * escaping prevents unintended LIKE wildcards in user input.
   * (Audit item L4: parameterized LIKE — confirmed safe.)
   */
  function escapeLike(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  // Build dynamic query
  const conditions: string[] = status ? ['status = ?'] : ["status NOT IN ('suspended', 'revoked')"];
  const params: unknown[] = status ? [status] : [];

  if (q) {
    const safe = escapeLike(q);
    conditions.push('(name LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')');
    params.push(`%${safe}%`, `%${safe}%`);
  }

  // MED-4: Use json_each() instead of LIKE to prevent cross-JSON-boundary matches
  if (capabilities) {
    for (const cap of capabilities.split(',')) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(capabilities) WHERE json_each.value = ?)');
      params.push(cap.trim());
    }
  }

  if (protocols) {
    for (const proto of protocols.split(',')) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(protocols) WHERE json_each.value = ?)');
      params.push(proto.trim());
    }
  }

  if (offers) {
    for (const offer of offers.split(',')) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(offers) WHERE json_each.value = ?)');
      params.push(offer.trim());
    }
  }

  if (needs) {
    for (const need of needs.split(',')) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(needs) WHERE json_each.value = ?)');
      params.push(need.trim());
    }
  }

  const whereClause = conditions.join(' AND ');
  const orderBy = sort === 'registered_at'
    ? 'registered_at DESC'
    : sort === 'name'
    ? 'name ASC'
    : 'reputation_score DESC';

  // Get total count
  const countRow = await db.get<{ count: number }>(
    `SELECT COUNT(*) as count FROM agents WHERE ${whereClause}`,
    ...params
  );

  // Get paginated results
  const rows = await db.all<Agent>(
    `SELECT * FROM agents WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );

  return c.json({
    agents: rows.map(formatAgent),
    pagination: {
      page,
      limit,
      total: countRow?.count ?? 0,
      total_pages: Math.ceil((countRow?.count ?? 0) / limit),
    },
  });
});

/**
 * GET /v1/agents/:nameOrId
 * Get an agent's public profile + reputation.
 * Tries ID lookup first, then falls back to exact name match (case-insensitive).
 */
agents.get('/:id', async (c) => {
  const nameOrId = c.req.param('id');
  const db = c.get('db');

  // Try by ID first, then fall back to case-insensitive name match
  let agent = await db.get<Agent>('SELECT * FROM agents WHERE id = ?', nameOrId);
  if (!agent) {
    agent = await db.get<Agent>('SELECT * FROM agents WHERE name = ? COLLATE NOCASE', nameOrId);
  }

  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  // Get recent verifications (last 10 where this agent was the target)
  const recentVerifications = await db.all<Pick<Verification, 'verifier_id' | 'result' | 'coherence_score' | 'created_at'>>(
    `SELECT verifier_id, result, coherence_score, created_at
     FROM verifications
     WHERE target_id = ?
     ORDER BY created_at DESC
     LIMIT 10`,
    agent.id
  );

  // D11: the optional 1-5 ratings posters gave this agent's deliveries. A
  // failed lookup never takes the profile down with it.
  const ratings = await ratingSummary(db, agent.id).catch((err: unknown) => {
    console.error('[agents] rating summary failed:', err);
    return { count: 0, average: null };
  });

  return c.json({
    ...formatAgent(agent),
    ratings,
    recent_verifications: recentVerifications.map((v) => ({
      verifier: v.verifier_id,
      result: v.result,
      coherence_score: v.coherence_score,
      date: v.created_at,
    })),
  });
});

/**
 * PATCH /v1/agents/:id/profile
 * Partially update an agent's profile (AgentSig auth, owner only).
 * Also aliased at PUT /v1/agents/:id for backwards compat.
 */
async function handleProfileUpdate(c: Context<AppEnv>): Promise<Response> {
  const id = c.req.param('id');
  const authenticatedAgentId = c.get('agentId') as string;

  if (id !== authenticatedAgentId) {
    return c.json({ error: 'forbidden', message: 'You can only update your own profile' }, 403);
  }

  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = ProfileSchema.partial().safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const db = c.get('db');

  // Snapshot trust-relevant fields BEFORE the update for chain diffing
  const before = await db.get<{ capabilities: string | null; protocols: string | null; skills: string | null }>(
    'SELECT capabilities, protocols, skills FROM agents WHERE id = ?', id
  );
  if (!before) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);

  const updates = parsed.data;

  // SSRF protection: validate contact_endpoint and webhook_url (CRIT-1, CRIT-2)
  if (updates.contact_endpoint && !isSafeUrl(updates.contact_endpoint)) {
    return c.json({
      error: 'bad_request',
      message: 'contact_endpoint must be a safe HTTPS URL (no private/internal addresses)',
    }, 400);
  }
  if (updates.webhook_url && !isSafeUrl(updates.webhook_url)) {
    return c.json({
      error: 'bad_request',
      message: 'webhook_url must be a safe HTTPS URL (no private/internal addresses)',
    }, 400);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  const jsonFields = ['capabilities', 'protocols', 'offers', 'needs', 'tags', 'skills'] as const;
  const textFields = ['name', 'description', 'homepage', 'contact_endpoint', 'comment',
                      'organization', 'organization_url', 'logo_url', 'version', 'contact_email',
                      'x_handle', 'webhook_url'] as const;

  for (const field of textFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      // Normalise x_handle — always store with leading @
      if (field === 'x_handle' && updates[field]) {
        const h = updates[field] as string;
        params.push(h.startsWith('@') ? h : `@${h}`);
      } else if (field === 'webhook_url' && (!updates[field] || updates[field] === '')) {
        // Empty string or null clears the webhook and secret
        params.push(null);
        setClauses.push('webhook_secret = ?');
        params.push(null);
      } else if (field === 'webhook_url' && updates[field]) {
        // MED-6: Generate a new webhook_secret whenever webhook_url is set/changed
        params.push(updates[field]);
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        const newSecret = btoa(binary);
        setClauses.push('webhook_secret = ?');
        params.push(newSecret);
      } else {
        params.push(updates[field]);
      }
    }
  }
  for (const field of jsonFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      params.push(JSON.stringify(updates[field]));
    }
  }

  if (setClauses.length === 0) {
    return c.json({ error: 'bad_request', message: 'No fields to update' }, 400);
  }

  // Name uniqueness check (case-insensitive) — only when name is being changed
  if (updates.name !== undefined) {
    const nameTaken = await db.get<{ id: string }>(
      'SELECT id FROM agents WHERE name = ? COLLATE NOCASE AND id != ?',
      updates.name, id
    );
    if (nameTaken) {
      return c.json({ error: 'conflict', message: `Agent name '${updates.name}' is already taken` }, 409);
    }
    // Anti-impersonation (board spec §4): the same confusable-skeleton gate as
    // register/complete. Without it a rename is the bypass — register an
    // innocuous name that clears the skeleton check, then PATCH to a Cyrillic
    // homoglyph of a target. Recompute and re-store the skeleton so the column
    // stays truthful for the next writer's check.
    const skeleton = nameSkeleton(updates.name as string);
    const lookalike = await db.get<{ name: string }>(
      'SELECT name FROM agents WHERE name_skeleton = ? AND id != ?',
      skeleton, id
    );
    if (lookalike) {
      return c.json({
        error: 'conflict',
        message: `Agent name '${updates.name}' is confusable with existing agent '${lookalike.name}' — pick a visually distinct name`,
      }, 409);
    }
    setClauses.push('name_skeleton = ?');
    params.push(skeleton);
  }

  const now = new Date().toISOString();
  setClauses.push('last_seen = ?');
  params.push(now);

  // Bump profile_version
  setClauses.push('profile_version = profile_version + 1');

  params.push(id);
  await db.run(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`, ...params);

  const updatedAgent = await db.get<Agent>('SELECT * FROM agents WHERE id = ?', id);

  // Only write a chain entry when trust-relevant fields changed:
  // capabilities, protocols, or skills — these are what verifiers evaluate.
  // Cosmetic changes (description, logo, contact info) do not affect trust and stay off-chain.
  const trustFields = ['capabilities', 'protocols', 'skills'] as const;
  const trustChanged = trustFields.some(field => {
    if (updates[field] === undefined) return false;
    const beforeVal = JSON.stringify(JSON.parse(before[field] ?? '[]'));
    const afterVal  = JSON.stringify(updates[field]);
    return beforeVal !== afterVal;
  });

  if (trustChanged) {
    const profileSnapshot = {
      capabilities: JSON.parse(updatedAgent!.capabilities ?? '[]'),
      protocols: JSON.parse(updatedAgent!.protocols ?? '[]'),
      skills: updatedAgent!.skills ? JSON.parse(updatedAgent!.skills) : [],
    };
    const profileHash = hashProfile(profileSnapshot as Record<string, unknown>);
    const latestEntry = await db.get<{ entry_hash: string }>(
      'SELECT entry_hash FROM chain ORDER BY sequence DESC LIMIT 1'
    );
    const previousHash = latestEntry?.entry_hash ?? GENESIS_HASH;
    const pubKeyRaw = updatedAgent!.public_key;
    const pubKeyBytes = pubKeyRaw instanceof Uint8Array
      ? pubKeyRaw
      : new Uint8Array(Object.values(pubKeyRaw as Record<string, number>));
    const entryHash = computeChainHash(previousHash, pubKeyBytes, '', profileHash, now);

    const seqRowUpdate = await db.get<{ next_seq: number }>(
      'SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq FROM chain'
    );
    await db.run(
      `INSERT INTO chain (sequence, entry_hash, previous_hash, agent_id, public_key, nonce, profile_hash, timestamp, entry_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'capability_update')`,
      seqRowUpdate!.next_seq, entryHash, previousHash, id, updatedAgent!.public_key, '', profileHash, now
    );
  }

  return c.json(formatAgent(updatedAgent!));
}

agents.patch('/:id/profile', agentAuth, (c) => handleProfileUpdate(c as Context<AppEnv>));
agents.put('/:id', agentAuth, (c) => handleProfileUpdate(c as Context<AppEnv>));

/**
 * GET /v1/agents/:id/reputation
 * Detailed reputation breakdown.
 */
agents.get('/:id/reputation', async (c) => {
  const id = c.req.param('id');
  const db = c.get('db');

  const agentExists = await db.get<{ id: string }>('SELECT id FROM agents WHERE id = ?', id);
  if (!agentExists) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  const rep = await computeReputation(id, db);

  // Also update stored reputation_score
  await db.run(
    'UPDATE agents SET reputation_score = ? WHERE id = ?',
    rep.final_score, id
  );

  return c.json({
    agent_id: id,
    reputation_score: rep.final_score,
    breakdown: rep.components,
    penalty: rep.penalty,
    safety_flags: rep.safety_flags,
    weights: rep.weights,
    raw_score: rep.raw_score,
    confidence: rep.confidence,
    verifications_received: rep.verifications_received,
    verifications_given: rep.verifications_given,
    tasks_accepted: rep.tasks_accepted,
    tasks_failed: rep.tasks_failed,
  });
});

/**
 * GET /v1/agents/:id/wallet — Public wallet info
 */
agents.get('/:id/wallet', async (c) => {
  const id = c.req.param('id');
  const db = c.get('db');

  const agent = await db.get<{ wallet_address: string | null; wallet_network: string | null }>(
    'SELECT wallet_address, wallet_network FROM agents WHERE id = ?', id
  );
  if (!agent) {
    return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  }

  return c.json({
    agent_id: id,
    wallet_address: agent.wallet_address,
    wallet_network: agent.wallet_network,
  });
});

/**
 * PATCH /v1/agents/:id/wallet — Update wallet address (AgentSig auth, owner only)
 */
agents.patch('/:id/wallet', agentAuth, async (c) => {
  const id = c.req.param('id');
  const authenticatedAgentId = c.get('agentId') as string;

  if (id !== authenticatedAgentId) {
    return c.json({ error: 'forbidden', message: 'You can only update your own wallet' }, 403);
  }

  let body: unknown;
  try { body = JSON.parse(await c.req.text()); }
  catch { return c.json({ error: 'bad_request', message: 'Invalid JSON body' }, 400); }

  const parsed = WalletUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', message: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const db = c.get('db');
  const updates = parsed.data;
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.wallet_address !== undefined) {
    setClauses.push('wallet_address = ?');
    params.push(updates.wallet_address);
  }
  if (updates.wallet_network !== undefined) {
    setClauses.push('wallet_network = ?');
    params.push(updates.wallet_network);
  }

  if (setClauses.length === 0) {
    return c.json({ error: 'bad_request', message: 'No fields to update' }, 400);
  }

  params.push(id);
  await db.run(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`, ...params);

  const agent = await db.get<{ wallet_address: string | null; wallet_network: string | null }>(
    'SELECT wallet_address, wallet_network FROM agents WHERE id = ?', id
  );

  return c.json({
    agent_id: id,
    wallet_address: agent!.wallet_address,
    wallet_network: agent!.wallet_network,
  });
});

export default agents;
