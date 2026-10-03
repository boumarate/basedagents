import { API_BASE } from '../api/client';

/**
 * Client-side funnel events the marketing site emits. Everything else in the
 * task funnel (task_posted, task_claimed, …) is written server-side from the
 * task lifecycle, so the site only reports the things the server cannot
 * see: a click on a "Post a task" call to action, and a visitor opening the
 * settled-payout history from the task board.
 */
export type WebFunnelEvent = 'task_cta_click' | 'payout_history_open';

/**
 * Fire-and-forget funnel ping (same shape as Home.tsx's local `ping`).
 * `keepalive` lets it survive the navigation the click triggers. Never
 * throws and never blocks the UI — telemetry must not break the page.
 */
export function funnelPing(event: WebFunnelEvent, provider?: string): void {
  try {
    void fetch(`${API_BASE}/v1/funnel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...(provider ? { provider } : {}) }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* telemetry must never break the page */
  }
}
