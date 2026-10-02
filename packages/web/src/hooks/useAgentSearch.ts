import { useState, useEffect, useRef } from 'react';
import { api, mapApiAgentToAgent } from '../api/client';
import { mockAgents } from '../data/mockData';
import type { Agent } from '../data/mockData';
import type { SearchParams } from '../api/types';

interface UseAgentSearchResult {
  agents: Agent[];
  total: number;
  totalPages: number;
  loading: boolean;
  error: string | null;
  usingMock: boolean;
}

export function useAgentSearch(params: SearchParams): UseAgentSearchResult {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingMock, setUsingMock] = useState(false);
  const paramsRef = useRef(JSON.stringify(params));
  // The filters of the pages accumulated so far: a fetch for page > 1 with the
  // same filters appends to the list, any other change replaces it.
  const filterKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = JSON.stringify(params);
    // Avoid re-fetching if params haven't changed
    if (key === paramsRef.current && agents.length > 0) return;
    paramsRef.current = key;

    const { page = 1, ...filters } = params;
    const filterKey = JSON.stringify(filters);
    const append = page > 1 && filterKey === filterKeyRef.current;
    filterKeyRef.current = filterKey;

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const result = await api.searchAgents(params);
        if (cancelled) return;

        const fetched = result.agents.map(mapApiAgentToAgent);
        setAgents(prev => {
          if (!append) return fetched;
          // Dedupe by id: an agent can shift pages between requests.
          const seen = new Set(prev.map(a => a.id));
          return [...prev, ...fetched.filter(a => !seen.has(a.id))];
        });
        setTotal(result.pagination.total);
        setTotalPages(result.pagination.total_pages);
        setUsingMock(false);
        setError(null);
      } catch (err) {
        if (cancelled) return;

        // Fallback to mock data with client-side filtering
        let filtered = [...mockAgents];
        if (params.q) {
          const q = params.q.toLowerCase();
          filtered = filtered.filter(
            a => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
          );
        }
        if (params.capabilities) {
          const caps = params.capabilities.split(',');
          filtered = filtered.filter(a => caps.some(c => a.capabilities.includes(c.trim())));
        }
        if (params.protocols) {
          const protos = params.protocols.split(',');
          filtered = filtered.filter(a => protos.some(p => a.protocols.includes(p.trim())));
        }
        if (params.sort === 'registered_at') {
          filtered.sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());
        } else {
          filtered.sort((a, b) => b.reputationScore - a.reputationScore);
        }

        setAgents(filtered);
        setTotal(filtered.length);
        setTotalPages(1);
        setUsingMock(true);
        setError(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [JSON.stringify(params)]);

  return { agents, total, totalPages, loading, error, usingMock };
}
