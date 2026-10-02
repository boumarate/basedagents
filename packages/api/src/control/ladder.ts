/**
 * The authority ladder — anonymous → email (magic link) → passkey.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * There is no signup form. A human enters one email field; the magic-link
 * click is the ratifying moment. Returning owners get a look-only session
 * (reads); a brand-new address gets a single-use START CODE that /start/buyer
 * turns into an account (id minted at random — no key to derive it from).
 * The passkey — the authority root from then on — is minted at the FIRST
 * ACTION (posting a task, connecting an agent), the first moment authority
 * is exercised. Every mutation carries a fresh WebAuthn assertion (routes.ts).
 *
 * Routes (mounted at /v1/owner), none of them take a session:
 *   POST /login/email             magic-link login (look-only session)
 *   POST /login/email/finish      token → session
 *   POST /start/email             browser door: magic link to ANY address
 *   POST /start/finish            token → session (returning) | start code (first-time)
 *   POST /start/buyer             start code → account + session
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types/index.js';
import { ControlStore } from './store.js';
import { randomBuyerOwnerId } from './identity.js';
import { mintSession } from './routes.js';
import { emailSenderFromEnv, consoleOrigin } from './email.js';
import type { EmailSender } from './email.js';
import { base58Encode, sha256, bytesToHex } from '../crypto/index.js';
import { base64urlEncode } from './webauthn.js';

const MAGIC_LINK_TTL_SECONDS = 900; // 15m
// A start code outlives the magic link that minted it: the verified email
// waits for the account to be created (/start/buyer) — 60m is generous.
const START_CODE_TTL_SECONDS = 3600; // 60m

const textEncoder = new TextEncoder();

function sha256hex(input: string): string {
  return bytesToHex(sha256(textEncoder.encode(input)));
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getStore(c: Context<AppEnv>): ControlStore {
  return new ControlStore(c.get('db'));
}

function err(c: Context<AppEnv>, status: 400 | 401 | 402 | 404 | 409 | 429, error: string, message: string) {
  return c.json({ error, message }, status);
}

async function parseJson(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json();
}

function isE2E(env: unknown): boolean {
  return ((env ?? {}) as Record<string, string | undefined>).E2E === '1';
}

/** Same resolution order as recovery.ts: injected → E2E outbox → env. */
function getEmailSender(c: Context<AppEnv>): EmailSender {
  const injected = (c.get as (k: string) => EmailSender | undefined)('emailSender');
  if (injected) return injected;
  if (isE2E(c.env)) {
    const store = getStore(c);
    return { send: async (m) => store.appendTestOutbox(m.to, m.subject, m.text) };
  }
  return emailSenderFromEnv(c.env);
}

// ─── validation schemas ───

// ─── validation schemas ───

const TokenSchema = z.object({ token: z.string().min(1) });
const BuyerStartSchema = z.object({ start_code: z.string().min(1) });
const EmailLoginSchema = z.object({ email: z.string().email() });

// ─── the sub-app ───

const app = new Hono<AppEnv>();

// ── Email login (look-only rung) ──

app.post('/login/email', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = EmailLoginSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'a valid email is required');

  const store = getStore(c);
  const email = parsed.data.email.trim().toLowerCase();
  const owner = await store.getOwnerByEmail(email);
  if (owner) {
    const token = base64urlEncode(randomBytes(32));
    await store.createMagicLinkToken({
      tokenHash: sha256hex(token),
      purpose: 'login',
      email,
      ownerId: owner.id,
      ttlSeconds: MAGIC_LINK_TTL_SECONDS,
    });
    await getEmailSender(c).send({
      to: email,
      subject: 'Sign in to BasedAgents',
      text:
        `Click within 15 minutes to sign in:\n\n` +
        `${consoleOrigin(c.env)}/login#t=${token}\n\n` +
        `If you didn't request this, ignore this email.`,
    });
  }
  return c.json({ ok: true }); // uniform — no account enumeration
});

app.post('/login/email/finish', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = TokenSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const consumed = await store.consumeMagicLinkToken(sha256hex(parsed.data.token), 'login', nowIso());
  if (!consumed?.owner_id) return err(c, 401, 'unauthorized', 'invalid or expired link');

  await mintSession(c, consumed.owner_id, { method: 'email' });
  return c.json({ owner_id: consumed.owner_id });
});

// ── Browser start door (onboarding redesign §2, /start) ──
//
// The web "Start in your browser" door: one email field, no password, no form.
// A magic link is sent to ANY address (unlike /login/email, which is silent for
// unknowns) because the finish page is useful either way — returning owners get
// a look session; a brand-new address gets the command to paste to its agent.
// The email text is uniform, so this still leaks nothing about who has an
// account (the branch is only visible to the recipient, and shows public copy).

app.post('/start/email', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = EmailLoginSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'a valid email is required');

  const store = getStore(c);
  const email = parsed.data.email.trim().toLowerCase();
  const owner = await store.getOwnerByEmail(email);

  const token = base64urlEncode(randomBytes(32));
  await store.createMagicLinkToken({
    tokenHash: sha256hex(token),
    purpose: 'start',
    email,
    ownerId: owner?.id, // null for a first-time visitor — resolved at finish
    ttlSeconds: MAGIC_LINK_TTL_SECONDS,
  });
  await getEmailSender(c).send({
    to: email,
    subject: 'Continue with BasedAgents',
    text:
      `Click within 15 minutes to pick up where you left off:\n\n` +
      `${consoleOrigin(c.env)}/start#t=${token}\n\n` +
      `If you didn't request this, ignore this email.`,
  });
  return c.json({ ok: true }); // uniform response
});

app.post('/start/finish', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = TokenSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'validation failed');

  const store = getStore(c);
  const consumed = await store.consumeMagicLinkToken(sha256hex(parsed.data.token), 'start', nowIso());
  if (!consumed) return err(c, 401, 'unauthorized', 'invalid or expired link');

  // Returning owner → mint the look session. First-time visitor → no account
  // yet; the console shows the agent-paste command (setup still happens where
  // the agent lives, never a browser-side vault) — but the just-verified email
  // is NOT discarded: a single-use start code binds it, rides the prompt as
  // `--start st_…`, and pre-addresses the eventual /link claim (CONTROL_PLANE
  // §8, "the start code"). The code carries no authority — the magic-link
  // click still ratifies.
  if (consumed.owner_id) {
    await mintSession(c, consumed.owner_id, { method: 'email' });
    return c.json({ has_account: true });
  }
  const startCode = `st_${base58Encode(randomBytes(9))}`;
  await store.createMagicLinkToken({
    tokenHash: sha256hex(startCode),
    purpose: 'start_code',
    email: consumed.email,
    ttlSeconds: START_CODE_TTL_SECONDS,
  });
  return c.json({
    has_account: false,
    start_code: startCode,
    start_code_expires_in_seconds: START_CODE_TTL_SECONDS,
  });
});

// ── Browser buyer signup (post/hire without an agent) ──
//
// A first-time visitor who wants to HIRE — post a task, review the result — not
// run an agent. They have no vault (nothing to seal) and never will; the
// account exists to own tasks and, on the first post, hold a passkey. Authorized
// by the single-use `start_code` that /start/finish minted after the magic-link
// click, so the email is already proven controlled. This CONSUMES the start
// code: a person is hiring OR setting up an agent, and this path is the former.
// No enumeration risk — the code is unguessable and bound to the clicked email.
app.post('/start/buyer', async (c) => {
  let body: unknown;
  try {
    body = await parseJson(c);
  } catch {
    return err(c, 400, 'bad_request', 'invalid JSON body');
  }
  const parsed = BuyerStartSchema.safeParse(body);
  if (!parsed.success) return err(c, 400, 'bad_request', 'a start code is required');

  const store = getStore(c);
  const consumed = await store.consumeMagicLinkToken(sha256hex(parsed.data.start_code), 'start_code', nowIso());
  if (!consumed?.email) return err(c, 401, 'unauthorized', 'invalid or expired start code');
  const email = consumed.email;

  // Idempotent: if this email already has an account (operator or a buyer who
  // clicked twice), sign into it rather than minting a duplicate.
  let owner = await store.getOwnerByEmail(email);
  let created = false;
  if (!owner) {
    try {
      owner = await store.createOwner({ ownerId: randomBuyerOwnerId(), email });
      created = true;
    } catch {
      // Lost a create race on the UNIQUE(email) — fall back to the winner's row.
      owner = await store.getOwnerByEmail(email);
    }
    if (owner && created) await store.setEmailVerified(owner.id);
  }
  if (!owner) return err(c, 409, 'conflict', 'could not create the account — try again');

  await mintSession(c, owner.id, { method: 'email' });
  return c.json({ owner_id: owner.id, created });
});

// ── Agent-first entry: invite_owner ──
export default app;
