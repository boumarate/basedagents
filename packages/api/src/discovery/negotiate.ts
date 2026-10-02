/**
 * Content negotiation for `/` on all three hosts (WS1). One rule, shared by the
 * API Worker and the site/console Pages Functions (which import this file):
 *
 *   Accept names text/markdown and not text/html    → the skill (SKILL.md)
 *   Accept names application/json and not text/html → the service descriptor
 *   anything else                                   → the host's normal response
 *
 * Browsers always send text/html, so pages are never affected. `*\/*` alone
 * (curl's default) matches neither agent format. Import-free on purpose.
 */
export type AgentFormat = 'markdown' | 'json';

export function agentFormat(accept: string | null | undefined): AgentFormat | null {
  const a = (accept ?? '').toLowerCase();
  if (a.includes('text/html')) return null;
  if (a.includes('text/markdown')) return 'markdown';
  if (a.includes('application/json')) return 'json';
  return null;
}

/** Every response at `/` varies on Accept, so no cache may serve one format for another. */
export const NEGOTIATED_VARY = 'Accept';
