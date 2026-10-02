import { useState, useEffect, useRef, useCallback } from 'react';
import { api, mapApiAgentToAgent } from '../api/client';
import { mockAgents } from '../data/mockData';
import type { Agent } from '../data/mockData';
import type { SearchParams } from '../api/types';

interface UseAgentSearchResult {
  agents: Agent[];
  total: number;
  totalPages: number;
  /** The list is being replaced: the first page of the current filters is in flight. */
  loading: boolean;
  /** A further page is being appended; the list on screen stays valid meanwhile. */
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
  usingMock: boolean;
}

/**
 * Paginated agent search. `params` are the filters (no page); the hook fetches
 * page 1 whenever they change and exposes `loadMore` to append the next page.
 * A page is only counted as loaded on success, so a failed `loadMore` keeps
 * the live list, surfaces `error`, and the next call retries the same page.
 */
export function useAgentSearch(params: SearchParams): UseAgentSearchResult {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loadedPages, setLoadedPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingMock, setUsingMock] = useState(false);

  const filterKey = JSON.stringify(params);
  // Bumped whenever the filters change, so a response from an older fetch
  // can't land on a newer list.
  const epochRef = useRef(0);
  const stateRef = useRef({ params, loadedPages: 0, totalPages: 0, busy: false });
  stateRef.current.params = params;

  const fetchPage = useCallback(async (pageNum: number) => {
    const epoch = epochRef.current;
    const append = pageNum > 1;
    stateRef.current.busy = true;
    if (append) setLoadingMore(true); else setLoading(true);

    try {
      const result = await api.searchAgents({ ...stateRef.current.params, page: pageNum });
      if (epoch !== epochRef.current) return;

      const fetched = result.agents.map(mapApiAgentToAgent);
      setAgents(prev => {
        if (!append) return fetched;
        // Dedupe by id: an agent can shift pages between requests.
        const seen = new Set(prev.map(a => a.id));
        return [...prev, ...fetched.filter(a => !seen.has(a.id))];
      });
      setTotal(result.pagination.total);
      setTotalPages(result.pagination.total_pages);
      stateRef.current.loadedPages = pageNum;
      stateRef.current.totalPages = result.pagination.total_pages;
      setLoadedPages(pageNum);
      setUsingMock(false);
      setError(null);
    } catch (err) {
      if (epoch !== epochRef.current) return;

      if (append) {
        // A later page failing must not discard the live results on screen:
        // keep them, surface the error, and leave the page uncounted so the
        // next loadMore retries it.
        setError(err instanceof Error ? err.message : String(err));
        return;
      }

      // First page failed → fall back to mock data with client-side filtering
      const p = stateRef.current.params;
      let filtered = [...mockAgents];
      if (p.q) {
        const q = p.q.toLowerCase();
        filtered = filtered.filter(
          a => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
        );
      }
      if (p.capabilities) {
        const caps = p.capabilities.split(',');
        filtered = filtered.filter(a => caps.some(c => a.capabilities.includes(c.trim())));
      }
      if (p.protocols) {
        const protos = p.protocols.split(',');
        filtered = filtered.filter(a => protos.some(pr => a.protocols.includes(pr.trim())));
      }
      if (p.sort === 'registered_at') {
        filtered.sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());
      } else {
        filtered.sort((a, b) => b.reputationScore - a.reputationScore);
      }

      setAgents(filtered);
      setTotal(filtered.length);
      setTotalPages(1);
      stateRef.current.loadedPages = 1;
      stateRef.current.totalPages = 1;
      setLoadedPages(1);
      setUsingMock(true);
      setError(null);
    } finally {
      if (epoch === epochRef.current) {
        stateRef.current.busy = false;
        if (append) setLoadingMore(false); else setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    epochRef.current += 1;
    stateRef.current.loadedPages = 0;
    stateRef.current.totalPages = 0;
    stateRef.current.busy = false;
    setLoadedPages(0);
    setLoadingMore(false);
    void fetchPage(1);
  }, [filterKey, fetchPage]);

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (s.busy || s.loadedPages === 0 || s.loadedPages >= s.totalPages) return;
    void fetchPage(s.loadedPages + 1);
  }, [fetchPage]);

  const hasMore = !usingMock && loadedPages > 0 && loadedPages < totalPages;

  return { agents, total, totalPages, loading, loadingMore, hasMore, loadMore, error, usingMock };
}
