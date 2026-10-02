/**
 * Small shared helpers for the agent surfaces (sidebar, /home, /agents/*):
 * how an agent is named on screen, and where its public profile lives.
 */
import { ControlApiError } from '../api/control.js';
import type { Delegation } from '../api/types.js';

export function errText(err: unknown): string {
  if (err instanceof ControlApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

/** The label the human gave the agent, else a shortened id. */
export function agentDisplayName(d: Pick<Delegation, 'label' | 'agent_id'>): string {
  return d.label ?? shortId(d.agent_id);
}

/** The agent's public profile on the marketplace site. */
export function agentProfileUrl(agentId: string): string {
  return `https://basedagents.ai/agents/${encodeURIComponent(agentId)}`;
}
