import { useEffect, useState } from 'react';
import { registryStatus } from '../lib/registryStatus';

/**
 * How many agents are registered, from GET /v1/status (`agents.total`). Like
 * the paid total, an unreachable API reads as `failed` (shown as a dash), never
 * as 0.
 */
export type AgentCount =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; total: number; display: string };

export function useAgentCount(): AgentCount {
  const [count, setCount] = useState<AgentCount>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    registryStatus()
      .then((s) => {
        if (cancelled) return;
        const total = s.agents?.total;
        setCount(typeof total === 'number' && Number.isFinite(total) && total >= 0
          ? { kind: 'ready', total, display: total.toLocaleString('en-US') }
          : { kind: 'failed' });
      })
      .catch(() => { if (!cancelled) setCount({ kind: 'failed' }); });
    return () => { cancelled = true; };
  }, []);
  return count;
}
