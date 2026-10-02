/**
 * Preserve the destination a visitor was trying to reach when a protected route
 * bounced them to sign-in, so authentication returns them to that exact page
 * instead of a generic /home (redesign brief §2, acceptance scenario 3).
 *
 * Stored in localStorage (not sessionStorage) so it survives an email magic-link
 * click that opens in a NEW tab. Only a local path is ever stored — never a
 * credential or task input — and it is validated on the way in and out to
 * prevent an open redirect. A short TTL keeps a stale intent from hijacking a
 * much later, unrelated sign-in.
 */
const KEY = 'ba_return_to';
const TTL_MS = 30 * 60 * 1000; // 30 minutes — long enough for the inbox round trip

/** A safe same-origin path: starts with a single "/", and is not an auth page. */
function isSafePath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
  return !/^\/(login|start|recover|claim|invited|link)(\/|$|\?|#)/.test(path);
}

export function rememberIntent(path: string): void {
  try {
    if (isSafePath(path)) localStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    /* storage may be unavailable — intent is a convenience, never required */
  }
}

/**
 * Validate a return path that arrives from OUTSIDE storage — e.g. the `r`
 * hash param a sign-in email carries (/start#t=…&r=%2Ftesting). Same rules
 * as the stored intent: a single-leading-slash local path, never an auth
 * page, so an attacker-composed link can only point within the console.
 */
export function safeReturnPath(raw: string | null): string | null {
  return raw && raw.length <= 512 && isSafePath(raw) ? raw : null;
}

/** Return the remembered destination once (clearing it), or null. */
export function takeIntent(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    if (!raw) return null;
    const { path, at } = JSON.parse(raw) as { path?: string; at?: number };
    if (typeof path === 'string' && typeof at === 'number' && Date.now() - at < TTL_MS && isSafePath(path)) {
      return path;
    }
  } catch {
    /* ignore malformed/absent intent */
  }
  return null;
}
