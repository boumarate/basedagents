/**
 * Signed-cookie + CSRF primitives for the MCP OAuth AS (SPEC §2/§3/§8).
 *
 * The AS is COOKIELESS with respect to authority — it never mints a
 * `ba_owner_session`. The one cookie it does set, `mcp_authreq`, carries NO
 * authority: it is a signed `{authreq_id, csrf}` envelope whose only jobs are
 * (a) CSRF protection of the two POST forms (email + decision) and (b) binding
 * the magic-link click back to the exact authorization request that armed it
 * (login-fixation defense, §3 step 3). All authoritative state lives in D1 and
 * is resumable from the URL token, so a stripped/absent cookie degrades the flow
 * but never grants anything.
 *
 * Integrity is an HMAC-SHA256 over `MCP_SIGNING_SECRET` (Web Crypto `subtle`,
 * Workers-native, no Node crypto). The payload is NOT encrypted — it holds no
 * secret, only two opaque ids — but it IS tamper-evident: a client cannot forge
 * a cookie that names a different authreq_id or csrf without the secret. The MAC
 * is verified in constant time so a byte-by-byte forgery oracle is closed.
 */

import { sha256, bytesToHex } from '../crypto/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Best client-IP guess on the edge: Cloudflare's header first, the left-most
 * X-Forwarded-For hop as the fallback. Shared by the OAuth DCR throttle and the
 * /mcp anonymous-call limiter so both key the same way.
 */
export function clientIpFrom(header: (name: string) => string | undefined): string {
  return (
    header('cf-connecting-ip') ||
    header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/** Rate-limit keys store a hash, never the raw IP. */
export function ipHash(ip: string): string {
  return bytesToHex(sha256(enc.encode(ip)));
}

/** URL-safe base64 without padding — the repo-wide token/id encoding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** A fresh, unguessable per-form CSRF token (128 bits, base64url). */
export function newCsrfToken(): string {
  return base64urlEncode(randomBytes(16));
}

/** HMAC-SHA256(secret, msg) as raw bytes — Workers-native, async subtle. */
async function hmacSha256(secret: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return new Uint8Array(sig);
}

/**
 * Constant-time string compare. Length is leaked (unavoidable, and not secret
 * here) but the content comparison never short-circuits, so an attacker gets no
 * per-byte timing oracle on the MAC or the CSRF token.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface AuthreqCookie {
  authreq_id: string;
  csrf: string;
}

/**
 * Serialize + sign the `mcp_authreq` payload: `base64url(json).base64url(mac)`.
 * The MAC covers the encoded body exactly, so any tamper flips the verify.
 */
export async function signCookie(secret: string, payload: AuthreqCookie): Promise<string> {
  const body = base64urlEncode(enc.encode(JSON.stringify(payload)));
  const mac = base64urlEncode(await hmacSha256(secret, body));
  return `${body}.${mac}`;
}

/**
 * Verify + parse a signed `mcp_authreq` cookie. Returns the payload iff the MAC
 * validates (constant-time), else null — a forged/tampered/garbage cookie is
 * indistinguishable from an absent one to every caller.
 */
export async function verifyCookie(secret: string, token: string | undefined): Promise<AuthreqCookie | null> {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = base64urlEncode(await hmacSha256(secret, body));
  if (!timingSafeEqual(mac, expected)) return null;
  try {
    const obj = JSON.parse(dec.decode(base64urlDecode(body))) as AuthreqCookie;
    if (typeof obj?.authreq_id !== 'string' || typeof obj?.csrf !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}
