/**
 * Open-task expiry policy (decision D13, migration 0045).
 *
 * An `open` task nobody claims within its open window becomes `expired` — a
 * terminal status swept by the cron (openExpiryGate in service.ts). The
 * window is stamped as tasks.expires_at when the task is posted:
 *
 *   * default: TASK_OPEN_TTL_DAYS days (7 when unset), for every poster;
 *   * a poster may ask for 1–MAX_OPEN_TTL_DAYS days via `expires_in_days`;
 *   * a HOUSE account (HOUSE_ACCOUNT_IDS — agent ag_… or owner ow_… ids) may
 *     exceed the cap, and 0 = never expire (expires_at NULL): standing tasks
 *     like the "[First task NN]" onboarding slots outlive the sweep on
 *     purpose. Anyone else asking for 0 or > cap answers
 *     400 `expiry_window_not_allowed`.
 *
 * When a lapsed claim returns a task to `open`, the claim-expiry gate
 * re-stamps a fresh default window (a week spent claimed by a no-show must
 * not expire the task the moment it comes back); a NULL (never) stays NULL.
 */
import { houseAccountIds } from './settled.js';
import { isoPlus } from './service.js';

/** Default open window, days (env-tunable via TASK_OPEN_TTL_DAYS). */
export const DEFAULT_OPEN_TTL_DAYS = 7;
/** Longest window a non-house poster may ask for. */
export const MAX_OPEN_TTL_DAYS = 90;
/** Absolute ceiling for house accounts asking for a finite window. */
export const HOUSE_MAX_OPEN_TTL_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

type ExpiryEnv = { TASK_OPEN_TTL_DAYS?: string; HOUSE_ACCOUNT_IDS?: string } | undefined | null;

/** The deployment's default open window in days (bad/unset env → 7). */
export function defaultOpenTtlDays(env: ExpiryEnv): number {
  const raw = Number(env?.TASK_OPEN_TTL_DAYS ?? '');
  return Number.isInteger(raw) && raw >= 1 && raw <= HOUSE_MAX_OPEN_TTL_DAYS ? raw : DEFAULT_OPEN_TTL_DAYS;
}

/** The default window as an expires_at for `nowIso` — the claim-expiry re-stamp. */
export function defaultOpenExpiresAt(env: ExpiryEnv, nowIso: string): string {
  return isoPlus(nowIso, defaultOpenTtlDays(env) * DAY_MS);
}

/**
 * Resolve a poster's requested window into the expires_at to stamp
 * (null = never). `ok: false` = the request exceeds what this poster may ask
 * for — the route answers 400 `expiry_window_not_allowed`.
 */
export function resolveOpenExpiry(
  env: ExpiryEnv,
  creatorId: string,
  requestedDays: number | undefined,
  nowIso: string,
): { ok: true; expiresAt: string | null } | { ok: false; max: number } {
  if (requestedDays === undefined) return { ok: true, expiresAt: defaultOpenExpiresAt(env, nowIso) };
  const isHouse = houseAccountIds(env?.HOUSE_ACCOUNT_IDS).has(creatorId);
  if (requestedDays === 0) {
    return isHouse ? { ok: true, expiresAt: null } : { ok: false, max: MAX_OPEN_TTL_DAYS };
  }
  if (!isHouse && requestedDays > MAX_OPEN_TTL_DAYS) return { ok: false, max: MAX_OPEN_TTL_DAYS };
  return { ok: true, expiresAt: isoPlus(nowIso, requestedDays * DAY_MS) };
}
