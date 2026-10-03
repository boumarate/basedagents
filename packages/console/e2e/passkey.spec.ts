/**
 * Sign-in ladder E2E — real Chromium + CDP virtual authenticator against the
 * real control plane and the real console.
 *
 * Six scenarios, each self-contained with its own email (the shared API and
 * database persist across tests within a run):
 *   1. start      — /start with a NEW email + magic link → the account is
 *                   created on the spot; the session is LOOK-ONLY (email
 *                   rung, no passkey, an armed action offers nothing to sign)
 *   2. first act  — the FIRST action (posting a task) mints the passkey: the
 *                   creation ceremony fires exactly once, the task lands only
 *                   after the server verified the assertion, and the stored
 *                   passkey IS the minted one; the second action (connecting
 *                   an agent) is a signature only
 *   3. login      — both rungs: magic link mints a look session (method
 *                   email); the passkey mints the full rung (method passkey)
 *   4. recovery   — magic link + recovery code → new passkey; old one no
 *                   longer authenticates; the connected agent survives
 *   5. negative   — aborted CREATION ceremony → no passkey stored, nothing
 *                   connected; the retry succeeds
 *   6. returning  — /start with an email that already has an account signs
 *                   it in with the one field, same account
 */
import { test, expect } from '@playwright/test';
import type { Page, CDPSession } from '@playwright/test';
import { generateKeypair, base58Encode, publicKeyToAgentId } from 'basedagents';

const API = 'http://localhost:3000';

/** CDP reports credential ids as standard base64; the API stores base64url. */
function b64url(s: string): string {
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── virtual authenticator plumbing ───

interface Authenticator {
  cdp: CDPSession;
  id: string;
  /** base64url credential ids created on this authenticator. */
  added: string[];
  /** how many get() assertions this page has produced. */
  asserted: () => number;
}

async function addAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const added: string[] = [];
  let assertedCount = 0;
  cdp.on('WebAuthn.credentialAdded', (e: { credential: { credentialId: string } }) => {
    added.push(e.credential.credentialId);
  });
  cdp.on('WebAuthn.credentialAsserted', () => {
    assertedCount++;
  });
  return { cdp, id: authenticatorId, added, asserted: () => assertedCount };
}

// ─── API helpers ───

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, init);
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function sessionCookie(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const c = cookies.find((x) => x.name === 'ba_owner_session');
  if (!c) throw new Error('no session cookie in context');
  return `ba_owner_session=${c.value}`;
}

/** Read the newest magic-link token for `email` whose URL path matches. */
async function magicToken(email: string, pathname: '/login' | '/recover' | '/start'): Promise<string> {
  const { messages } = await apiJson<{ messages: Array<{ body: string }> }>(
    `/v1/owner/test/outbox?recipient=${encodeURIComponent(email)}`,
  );
  for (const m of messages) {
    // newest first — the first match IS the latest token
    const hit = new RegExp(`${pathname}#t=([A-Za-z0-9_-]+)`).exec(m.body);
    if (hit) return hit[1];
  }
  throw new Error(`no ${pathname} magic link in the outbox for ${email}`);
}

interface Me {
  owner_id: string;
  email: string | null;
  session_method: string;
  has_passkey: boolean;
  credentials: Array<{ credential_id: string }>;
  delegations: Array<{ id: string; agent_id: string; label: string | null; status: string }>;
}

async function me(page: Page): Promise<Me> {
  return apiJson<Me>('/v1/owner/me', { headers: { Cookie: await sessionCookie(page) } });
}

/** Arm an action for this session and return what the server offers to sign with. */
async function armAction(page: Page): Promise<{ allowCredentials: Array<{ id: string }> }> {
  return apiJson('/v1/owner/action/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await sessionCookie(page) },
    body: JSON.stringify({ action_type: 'generate_recovery_code', params: {} }),
  });
}

// ─── the marketplace side: a registered agent to connect ───

let counter = 0;

interface SeededAgent {
  agentId: string;
  agentName: string;
}

/** Insert a registry agent row (E2E-only) so it can be connected without the proof-of-work ceremony. */
async function seedAgent(): Promise<SeededAgent> {
  const kp = await generateKeypair();
  const agentId = publicKeyToAgentId(kp.publicKey);
  const agentName = `e2e-agent-${Date.now()}-${++counter}`;
  await apiJson('/v1/owner/test/seed-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, public_key_b58: base58Encode(kp.publicKey), name: agentName }),
  });
  return { agentId, agentName };
}

function freshEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${++counter}@example.com`;
}

// ─── UI flows ───

/**
 * /start → one email field → magic link from the outbox → the console. A new
 * address gets its account created by the click; a returning one is signed
 * in. Either way the session is the email rung.
 */
async function startWithEmail(page: Page, email: string): Promise<void> {
  await page.goto('/start');
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  // The success state is the sync point — the outbox write happens inside the
  // POST, so reading before this heading races the request.
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const token = await magicToken(email, '/start');
  await page.goto('/login'); // leave /start so #t= is a real load, not a fragment change
  await page.goto(`/start#t=${token}`);
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
}

/** /agents/new → id + name → "Connect this agent" → the agent's own page. */
async function connectAgent(page: Page, agent: SeededAgent): Promise<void> {
  await page.goto('/agents/new');
  await expect(page.getByRole('heading', { name: 'Add an agent' })).toBeVisible();
  await page.getByLabel('Agent ID').fill(agent.agentId);
  await page.getByLabel(/^Name/).fill(agent.agentName);
  await page.getByRole('button', { name: 'Connect this agent' }).click();
  await expect(page).toHaveURL(/\/agents\/ag_/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: agent.agentName })).toBeVisible();
}

/** /tasks/new → the minimum composer → the task's review page; returns the task id. */
async function postTask(page: Page, title: string): Promise<string> {
  await page.goto('/tasks/new');
  await expect(page.getByRole('heading', { name: 'Post a task' })).toBeVisible();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Description').fill('Read CHANGELOG.md and write a five-bullet summary of the last release.');
  await page.getByRole('button', { name: 'Post a task' }).click();
  await expect(page).toHaveURL(/\/tasks\/task_[^/?#]+$/, { timeout: 20_000 });
  const id = /\/tasks\/(task_[^/?#]+)$/.exec(page.url())?.[1];
  if (!id) throw new Error(`no task id in ${page.url()}`);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. start: new email + magic link → account created, look-only session, nothing to sign with', async ({ page }) => {
  const email = freshEmail('start');
  const auth = await addAuthenticator(page);
  await startWithEmail(page, email);

  // No passkey ceremony happened anywhere in the sign-up.
  expect(auth.added).toHaveLength(0);
  expect(auth.asserted()).toBe(0);

  // The ratified facts: an account for that email, the email rung, no passkey,
  // nothing connected yet.
  const session = await me(page);
  expect(session.owner_id).toMatch(/^ow_[1-9A-HJ-NP-Za-km-z]+$/);
  expect(session.email).toBe(email);
  expect(session.session_method).toBe('email');
  expect(session.has_passkey).toBe(false);
  expect(session.credentials).toHaveLength(0);
  expect(session.delegations).toHaveLength(0);

  // The overview: empty task and agent states, the sidebar has no agents, and
  // the sign-in panel explains the coming first-action mint.
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('No tasks yet', { exact: false })).toBeVisible();
  await expect(page.getByText('No agent is connected to this account yet', { exact: false })).toBeVisible();
  await expect(page.locator('.sidebar .side-empty', { hasText: 'None yet' })).toBeVisible();
  await expect(page.getByText(/the first time you act/)).toBeVisible();

  // "Sessions to look, signatures to act": with no passkey there is nothing
  // that can sign — an armed action offers NO usable credential.
  const begin = await armAction(page);
  expect(begin.allowCredentials).toHaveLength(0);
});

test('2. first action mints the passkey; the stored passkey is the minted one; second action is signature-only', async ({ page }) => {
  const email = freshEmail('first');
  const auth = await addAuthenticator(page);
  await startWithEmail(page, email);

  // FIRST action — post a task: the creation ceremony fires (once), then the
  // assertion over the task's canonical.
  const title = `Summarize the changelog (e2e ${Date.now()})`;
  const taskId = await postTask(page, title);
  expect(auth.added).toHaveLength(1);
  expect(auth.asserted()).toBe(1);

  const session = await me(page);
  expect(session.has_passkey).toBe(true);
  expect(session.session_method).toBe('email'); // still the email rung — the passkey signs acts, not looks
  // The stored passkey IS the one the authenticator just minted…
  expect(session.credentials).toHaveLength(1);
  expect(b64url(session.credentials[0].credential_id)).toBe(b64url(auth.added[0]));
  // …and it is what every later action is offered to sign with.
  const begin = await armAction(page);
  expect(begin.allowCredentials).toHaveLength(1);
  expect(b64url(begin.allowCredentials[0].id)).toBe(b64url(auth.added[0]));

  // The action landed: the server only writes the task after verifying the
  // assertion against the stored key over the exact canonical it armed.
  const { tasks } = await apiJson<{ tasks: Array<{ task_id: string; title: string; status: string }> }>(
    '/v1/owner/tasks?status=all',
    { headers: { Cookie: await sessionCookie(page) } },
  );
  expect(tasks.find((t) => t.task_id === taskId)).toMatchObject({ title, status: 'open' });

  // SECOND action — connect an agent: signature only, no new credential.
  const agent = await seedAgent();
  await connectAgent(page, agent);
  expect(auth.added).toHaveLength(1); // unchanged
  expect(auth.asserted()).toBe(2);
  const after = await me(page);
  expect(after.delegations).toHaveLength(1);
  expect(after.delegations[0]).toMatchObject({ agent_id: agent.agentId, label: agent.agentName, status: 'active' });

  // The overview and the sidebar both list it now.
  await page.goto('/home');
  await expect(page.locator('.sidebar .side-label', { hasText: agent.agentName })).toBeVisible();
  await expect(page.locator('.row .row-label', { hasText: agent.agentName })).toBeVisible();
});

test('3. login, both rungs: magic link → look session (email); passkey → full rung', async ({ page }) => {
  const email = freshEmail('login');
  await addAuthenticator(page);
  await startWithEmail(page, email);
  const { owner_id } = await me(page);

  // Setup: mint the passkey with a first action so the second rung exists.
  await connectAgent(page, await seedAgent());
  expect((await me(page)).has_passkey).toBe(true);

  // Fresh browser state — the console is gated again.
  await page.context().clearCookies();
  await page.goto('/home');
  await expect(page).toHaveURL(/\/login/);

  // Rung 1 — email magic link. The sign-in email door is unified with /start,
  // so a returning account's link lands on /start#t= (which signs them
  // straight in). Uniform "check your email", token from outbox.
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const token = await magicToken(email, '/start');
  await page.goto(`/start#t=${token}`); // real load from /login (different path)
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  const look = await me(page);
  expect(look.session_method).toBe('email');
  expect(look.owner_id).toBe(owner_id);

  // Rung 2 — the passkey. Fresh cookies again; the resident credential signs.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  const full = await me(page);
  expect(full.session_method).toBe('passkey');
  expect(full.owner_id).toBe(owner_id);
});

test('4. recovery: magic link + code → new passkey; old passkey dead, connected agent intact', async ({ page }) => {
  const email = freshEmail('recovery');
  const oldAuth = await addAuthenticator(page);
  await startWithEmail(page, email);

  // Mint the passkey with a first action (recovery-code generation is itself a signed act).
  const agent = await seedAgent();
  await connectAgent(page, agent);
  const oldCredentialId = oldAuth.added[0];

  // Generate the recovery code (a passkey action) and capture the one-time display.
  await page.goto('/home');
  await page.getByRole('button', { name: 'Generate recovery code' }).click();
  const code = (await page.locator('.code-block-select').textContent({ timeout: 20_000 }))!.trim();
  expect(code).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
  const oldSession = await sessionCookie(page);

  // Request the magic link and read it from the E2E outbox (never Resend).
  await page.goto('/recover');
  await page.getByLabel(/Email/).fill(email);
  await page.getByRole('button', { name: 'Email me a recovery link' }).click();
  await expect(page.getByText(/recovery link is on its way/)).toBeVisible();
  const token = await magicToken(email, '/recover');

  // The lost-device story: the old authenticator is gone; a NEW one enrolls.
  await oldAuth.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: oldAuth.id });
  const newAuth = await addAuthenticator(page);

  // Leave /recover first: navigating /recover → /recover#t=… is a FRAGMENT
  // navigation (no reload), and the page reads the token once at mount.
  await page.goto('/login');
  await page.goto(`/recover#t=${token}`);
  await page.getByLabel(/Recovery code/).fill(code);
  await page.getByRole('button', { name: 'Enroll new passkey' }).click();
  await expect(page.getByText(/New passkey enrolled/)).toBeVisible({ timeout: 20_000 });
  expect(newAuth.added).toHaveLength(1);

  // The pre-recovery session is revoked…
  const deadSession = await api('/v1/owner/me', { headers: { Cookie: oldSession } });
  expect(deadSession.status).toBe(401);

  // …the old credential no longer authenticates (not offered at login)…
  const loginBegin = await apiJson<{ allowCredentials: Array<{ id: string }> }>(
    '/v1/owner/login/begin',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) },
  );
  expect(loginBegin.allowCredentials).toHaveLength(1);
  expect(b64url(loginBegin.allowCredentials[0].id)).not.toBe(b64url(oldCredentialId));

  // …the new passkey signs in, and the connected agent survived the rotation.
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  await expect(page.locator('.sidebar .side-label', { hasText: agent.agentName })).toBeVisible();
  expect((await me(page)).delegations[0]).toMatchObject({ agent_id: agent.agentId, status: 'active' });
});

test('5. negative: aborted creation ceremony → no passkey, nothing connected; retry succeeds', async ({ page }) => {
  const email = freshEmail('abort');
  const auth = await addAuthenticator(page);
  await startWithEmail(page, email);
  const agent = await seedAgent();

  await page.goto('/agents/new');
  await page.getByLabel('Agent ID').fill(agent.agentId);
  await page.getByLabel(/^Name/).fill(agent.agentName);

  // Abort the CREATION ceremony mid-flight: stop auto-presence so create()
  // hangs waiting for a touch that never comes, then reload — the pending
  // WebAuthn request dies with the document (the user closing the sheet).
  await auth.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: auth.id,
    enabled: false,
  });
  await page.getByRole('button', { name: 'Connect this agent' }).click();
  await expect(page.getByRole('button', { name: 'Waiting…' })).toBeVisible();
  await page.reload();

  // Nothing was minted and nothing moved: no credential, no assertion, the
  // account still has no passkey, and the agent is not connected.
  expect(auth.added).toHaveLength(0);
  expect(auth.asserted()).toBe(0);
  const session = await me(page);
  expect(session.has_passkey).toBe(false);
  expect(session.delegations).toHaveLength(0);
  await expect(page.locator('.sidebar .side-empty', { hasText: 'None yet' })).toBeVisible();

  // The flow recovers: presence back on, the same form mints and signs.
  await auth.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: auth.id,
    enabled: true,
  });
  await connectAgent(page, agent);
  expect(auth.added).toHaveLength(1);
  expect(auth.asserted()).toBe(1);
  const after = await me(page);
  expect(after.has_passkey).toBe(true);
  expect(after.delegations[0]).toMatchObject({ agent_id: agent.agentId, status: 'active' });
});

test('6. /start with a returning email signs in with the one field — same account, no second one', async ({ page }) => {
  const email = freshEmail('return');
  await addAuthenticator(page);
  await startWithEmail(page, email);
  const { owner_id } = await me(page);
  const agent = await seedAgent();
  await connectAgent(page, agent);
  await page.context().clearCookies();

  // The same door, the same one field — no password, no form.
  await page.goto('/start');
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  await expect(page.locator('input')).toHaveCount(1);
  await expect(page.getByLabel('Email')).toBeVisible();
  await startWithEmail(page, email);

  const session = await me(page);
  expect(session.owner_id).toBe(owner_id); // signed into the existing account, not a duplicate
  expect(session.session_method).toBe('email');
  expect(session.delegations[0]).toMatchObject({ agent_id: agent.agentId, status: 'active' });
  await expect(page.locator('.sidebar .side-label', { hasText: agent.agentName })).toBeVisible();
});
