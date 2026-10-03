/**
 * Tasks P0 E2E — a human posts a task from the console and reviews what
 * comes back, against the real control plane and the real console (same
 * servers and virtual-authenticator plumbing as passkey.spec.ts).
 *
 *   1. post      — /start creates the account (email rung), /tasks/new → post
 *                  → the task shows on /tasks, and the PUBLIC marketplace list
 *                  carries it with creator.kind === 'owner'
 *   2. review    — post → the E2E seed helper claims + delivers as an agent →
 *                  "Request changes" with a note → the seed delivers again →
 *                  "Accept" → the page shows the accepted state and pill, and
 *                  the detail endpoint reports verified/creator with two receipts
 *
 * Posting is a signed act, so the first post mints the account's passkey (the
 * virtual authenticator answers the prompt); the review actions then ride the
 * session plus that passkey's signature.
 */
import { test, expect } from '@playwright/test';
import type { Page, CDPSession } from '@playwright/test';

const API_PORT = 3000;
const API = `http://localhost:${API_PORT}`;

// ─── virtual authenticator (passkey.spec.ts) ───
// The first post mints the passkey; the authenticator is attached so that
// creation prompt (and every later assertion) resolves instead of hanging.

async function addAuthenticator(page: Page): Promise<{ cdp: CDPSession; id: string }> {
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
  return { cdp, id: authenticatorId };
}

// ─── API helpers (passkey.spec.ts) ───

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
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
async function magicToken(email: string, pathname: '/start' | '/login'): Promise<string> {
  const { messages } = await apiJson<{ messages: Array<{ body: string }> }>(
    `/v1/owner/test/outbox?recipient=${encodeURIComponent(email)}`,
  );
  for (const m of messages) {
    const hit = new RegExp(`${pathname}#t=([A-Za-z0-9_-]+)`).exec(m.body);
    if (hit) return hit[1];
  }
  throw new Error(`no ${pathname} magic link in the outbox for ${email}`);
}

// ─── the door: /start with a new email → account + email-rung session (passkey.spec.ts) ───

let counter = 0;

async function startWithEmail(page: Page): Promise<string> {
  const email = `tasks-e2e-${Date.now()}-${++counter}@example.com`;
  await page.goto('/start');
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const token = await magicToken(email, '/start');
  await page.goto('/login'); // leave /start so #t= is a real load, not a fragment change
  await page.goto(`/start#t=${token}`);
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  return email;
}

// ─── task flows ───

interface Draft {
  title: string;
  description: string;
  capabilities?: string;
  expectedOutput?: string;
}

/** Fill the composer and post; returns the new task id from the review page's URL. */
async function postTask(page: Page, draft: Draft): Promise<string> {
  await page.goto('/tasks/new');
  await expect(page.getByRole('heading', { name: 'Post a task' })).toBeVisible();
  // Payments are off in E2E, so the composer shows the unpaid note (no bounty field).
  await expect(page.getByText('This task is unpaid', { exact: false })).toBeVisible();
  await page.getByLabel('Title').fill(draft.title);
  await page.getByLabel('Description').fill(draft.description);
  await page.getByLabel('Category').selectOption('code');
  if (draft.capabilities) await page.getByLabel('Required capabilities').fill(draft.capabilities);
  if (draft.expectedOutput) await page.getByLabel('Expected output').fill(draft.expectedOutput);
  await page.getByLabel('Output format').selectOption('link');
  await page.getByRole('button', { name: 'Post a task' }).click();

  await expect(page).toHaveURL(/\/tasks\/task_[^/?#]+$/, { timeout: 20_000 });
  const id = /\/tasks\/(task_[^/?#]+)$/.exec(page.url())?.[1];
  if (!id) throw new Error(`no task id in ${page.url()}`);
  await expect(page.getByRole('heading', { name: draft.title })).toBeVisible();
  return id;
}

/**
 * E2E-only (control/testing.ts): seed an agent the first time, claim the task
 * if open, and write a delivery receipt; on a task already claimed by the
 * seeded agent (after "Request changes") it just delivers again.
 */
async function seedDelivery(
  page: Page,
  taskId: string,
  summary: string,
): Promise<{ ok: true; agent_id: string; receipt_id: string }> {
  return apiJson('/v1/owner/test/seed-task-delivery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await sessionCookie(page) },
    body: JSON.stringify({ task_id: taskId, summary }),
  });
}

interface PublicTask {
  task_id: string;
  title: string;
  status: string;
  creator: { kind: 'agent' | 'owner'; id: string | null; name: string | null };
  bounty: unknown;
}

interface OwnerDetail {
  ok: true;
  task: {
    task_id: string;
    status: string;
    accepted_by: 'creator' | 'auto' | null;
    review_state: 'revision_requested' | 'disputed' | null;
    revision_count: number;
    claimed_by_agent_id: string | null;
    review_note: string | null;
  };
  receipts: Array<{ receipt_id: string; agent_id: string; summary: string }>;
}

async function ownerDetail(page: Page, taskId: string): Promise<OwnerDetail> {
  return apiJson<OwnerDetail>(`/v1/owner/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Cookie: await sessionCookie(page) },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. post: /tasks/new → the task shows on /tasks and on the public list as posted by a human', async ({ page }) => {
  await addAuthenticator(page);
  await startWithEmail(page);

  const title = `Summarize the changelog (e2e ${Date.now()})`;
  const taskId = await postTask(page, {
    title,
    description: 'Read CHANGELOG.md on the main branch and write a five-bullet summary of the last release.',
    capabilities: 'github, writing',
    expectedOutput: 'A link to a gist with the five bullets.',
  });

  // The review page for a fresh task: open, nothing delivered, cancel is the only action.
  await expect(page.locator('.status', { hasText: 'Open' })).toBeVisible();
  await expect(page.getByText('Nothing delivered yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel task' })).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'github' })).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'writing' })).toBeVisible();

  // The list: the task card carries the title, the Open pill, and links back to the review page.
  await page.goto('/tasks');
  // `exact` so the h1 "Tasks" doesn't also match the "All tasks" subhead once the
  // list has loaded — a non-exact match resolves to two headings (strict-mode error).
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  const card = page.locator(`.card[data-task-id="${taskId}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: title })).toBeVisible();
  await expect(card.locator('.status', { hasText: 'Open' })).toBeVisible();
  await expect(page.getByText('Needs your review')).toHaveCount(0);

  // The overview lists it too, under "Your tasks".
  await page.goto('/home');
  await expect(page.locator(`.card[data-task-id="${taskId}"]`).getByRole('link', { name: title })).toBeVisible();

  // The public marketplace sees it too — posted by a human, unpaid.
  const { tasks } = await apiJson<{ ok: true; tasks: PublicTask[] }>('/v1/tasks?status=open&limit=100');
  const mine = tasks.find((t) => t.task_id === taskId);
  expect(mine).toBeTruthy();
  expect(mine!.title).toBe(title);
  expect(mine!.creator.kind).toBe('owner');
  expect(mine!.bounty).toBeNull();
  // The public shape never leaks the account id behind a human-posted task.
  expect(JSON.stringify(mine)).not.toContain('creator_owner_id');
});

test('2. review: delivered → request changes → delivered again → accept', async ({ page }) => {
  await addAuthenticator(page);
  await startWithEmail(page);

  const title = `Scrape pricing pages (e2e ${Date.now()})`;
  const taskId = await postTask(page, {
    title,
    description: 'Collect the list price of the top plan from the pricing pages of the ten vendors linked below.',
    expectedOutput: 'JSON: [{vendor, plan, price_usd, source_url}]',
  });

  // An agent claims and delivers (seeded — no real agent in the loop).
  const firstSummary = 'Prices collected for 8 of the 10 vendors.';
  const first = await seedDelivery(page, taskId, firstSummary);
  expect(first.agent_id).toMatch(/^ag_/);

  // The review page now offers the three review actions.
  await page.goto(`/tasks/${taskId}`);
  await expect(page.locator('.status', { hasText: 'Delivered' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dispute' })).toBeVisible();
  await expect(page.getByText('0 of 3 used')).toBeVisible();
  await expect(page.getByText('Latest delivery')).toBeVisible();
  await expect(page.getByText(firstSummary)).toBeVisible();

  // Request changes: the note is required and goes to the agent that delivered.
  await page.getByLabel(/^Note/).fill('Two vendors are missing the plan name — please add it.');
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.locator('.pill', { hasText: 'Changes requested' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.status', { hasText: 'In progress' })).toBeVisible();
  await expect(page.getByText('Two vendors are missing the plan name — please add it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);

  let detail = await ownerDetail(page, taskId);
  expect(detail.task.status).toBe('claimed');
  expect(detail.task.review_state).toBe('revision_requested');
  expect(detail.task.revision_count).toBe(1);
  expect(detail.task.claimed_by_agent_id).toBe(first.agent_id);

  // The agent delivers a second version; the page picks it up on reload, with
  // both receipts newest first.
  const secondSummary = 'Prices for all 10 vendors, plan names added.';
  const second = await seedDelivery(page, taskId, secondSummary);
  expect(second.agent_id).toBe(first.agent_id);
  await page.reload();
  await expect(page.locator('.status', { hasText: 'Delivered' })).toBeVisible();
  await expect(page.getByText('1 of 3 used')).toBeVisible();
  const deliveries = page.locator('.cards .card');
  await expect(deliveries).toHaveCount(2);
  await expect(deliveries.nth(0)).toContainText('Latest delivery');
  await expect(deliveries.nth(0)).toContainText(secondSummary);
  await expect(deliveries.nth(1)).toContainText('Earlier delivery');
  await expect(deliveries.nth(1)).toContainText(firstSummary);

  // Accept (no note) → the accepted state, pill, and date.
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByTestId('task-accepted')).toContainText('Accepted on', { timeout: 20_000 });
  await expect(page.locator('.status-approved', { hasText: 'Accepted' })).toBeVisible();
  await expect(page.locator('.pill', { hasText: 'Accepted automatically' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);

  detail = await ownerDetail(page, taskId);
  expect(detail.task.status).toBe('verified');
  expect(detail.task.accepted_by).toBe('creator');
  expect(detail.task.review_state).toBeNull();
  expect(detail.receipts).toHaveLength(2);

  // The list shows the same pill and no longer asks for a review.
  await page.goto('/tasks');
  const card = page.locator(`.card[data-task-id="${taskId}"]`);
  await expect(card.locator('.status-approved', { hasText: 'Accepted' })).toBeVisible();
  await expect(page.getByText('Needs your review')).toHaveCount(0);
});
