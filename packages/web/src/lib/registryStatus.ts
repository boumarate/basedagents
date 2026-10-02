import { api } from '../api/client';
import type { ApiStatusResponse } from '../api/types';

/**
 * GET /v1/status, shared by everything on a page that reads it (the homepage
 * hero's agent count and its live-work section), so one visit makes one
 * request. A result is reused for a minute; a failure isn't kept, so the next
 * caller tries again.
 */
const TTL_MS = 60_000;
let cached: { at: number; promise: Promise<ApiStatusResponse> } | null = null;

export function registryStatus(): Promise<ApiStatusResponse> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.promise;
  const promise = api.getStatus().catch((err: unknown) => {
    if (cached?.promise === promise) cached = null;
    throw err;
  });
  cached = { at: now, promise };
  return promise;
}
