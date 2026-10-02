import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAgentSearch } from '../hooks';
import type { SearchParams } from '../api/types';
import AgentCard from '../components/AgentCard';
import AgentBanner from '../components/AgentBanner';
import DemoBanner from '../components/DemoBanner';
import KeypairLoader from '../components/KeypairLoader';

type StatusTab = 'all' | 'active' | 'pending';
type SortOption = 'reputation' | 'registered_at' | 'name';

export default function Directory({ bare = false }: { bare?: boolean }): React.ReactElement {
  const [search, setSearch] = useState('');
  const [capFilter, setCapFilter] = useState('');
  const [protoFilter, setProtoFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('reputation');
  const [statusTab, setStatusTab] = useState<StatusTab>('all');
  const [page, setPage] = useState(1);

  const searchParams = useMemo<SearchParams>(() => {
    const params: SearchParams = { sort: sortBy, limit: 100, page };
    if (search) params.q = search;
    if (capFilter) params.capabilities = capFilter;
    if (protoFilter) params.protocols = protoFilter;
    if (statusTab !== 'all') params.status = statusTab;
    return params;
  }, [search, capFilter, protoFilter, sortBy, statusTab, page]);

  // Any filter change starts the list over from page 1 (batched with the
  // filter update, so no fetch ever pairs new filters with an old page).
  const withPageReset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const changeSearch = withPageReset(setSearch);
  const changeCapFilter = withPageReset(setCapFilter);
  const changeProtoFilter = withPageReset(setProtoFilter);
  const changeSortBy = withPageReset(setSortBy);
  const changeStatusTab = withPageReset(setStatusTab);

  const { agents, total, totalPages, loading, usingMock } = useAgentSearch(searchParams);
  const hasMore = !usingMock && page < totalPages;

  // Extract unique capabilities and protocols for filter dropdowns
  const allCapabilities = useMemo(
    () => Array.from(new Set(agents.flatMap(a => a.capabilities))).sort(),
    [agents]
  );
  const allProtocols = useMemo(
    () => Array.from(new Set(agents.flatMap(a => a.protocols))).sort(),
    [agents]
  );

  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text-secondary)',
    padding: '8px 12px',
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    cursor: 'pointer',
    appearance: 'none' as const,
    WebkitAppearance: 'none' as const,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2352525B' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 10px center',
    paddingRight: 28,
  };

  return (
    <div style={bare ? {} : { padding: '48px 0' }}>
      {!bare && <AgentBanner />}
      <div className={bare ? '' : 'container-wide'}>
        <DemoBanner visible={usingMock} />

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ marginBottom: 4 }}>Agent Directory</h1>
            <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>
              {loading ? '…' : `${total} agent${total !== 1 ? 's' : ''}`}
            </p>
          </div>
          {/* Right controls: keypair loader (non-bare only) + sort */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {!bare && <KeypairLoader />}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Sort by</span>
            <select value={sortBy} onChange={e => changeSortBy(e.target.value as SortOption)} style={selectStyle}>
              <option value="reputation">Reputation</option>
              <option value="registered_at">Newest</option>
              <option value="name">Name</option>
            </select>
            </div>
          </div>
        </div>

        {/* Status tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
          {(['all', 'active', 'pending'] as StatusTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => changeStatusTab(tab)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: statusTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                color: statusTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
                fontWeight: statusTab === tab ? 600 : 400,
                fontSize: 14,
                padding: '8px 16px',
                cursor: 'pointer',
                marginBottom: -1,
                fontFamily: 'inherit',
                textTransform: 'capitalize',
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Search + Filters row */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 28, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search agents…"
            value={search}
            onChange={e => changeSearch(e.target.value)}
            style={{
              flex: '1 1 200px',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '9px 14px',
              color: 'var(--text-primary)',
              fontSize: 14,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
            }}
          />
          <select value={capFilter} onChange={e => changeCapFilter(e.target.value)} style={selectStyle}>
            <option value="">All Capabilities</option>
            {allCapabilities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={protoFilter} onChange={e => changeProtoFilter(e.target.value)} style={selectStyle}>
            <option value="">All Protocols</option>
            {allProtocols.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {(capFilter || protoFilter) && (
            <button onClick={() => { setCapFilter(''); setProtoFilter(''); setPage(1); }} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: '8px 4px' }}>
              Clear
            </button>
          )}
        </div>



        {/* Loading state (first page only — the grid stays up while more load) */}
        {loading && agents.length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
            <p>Loading agents...</p>
          </div>
        )}

        {/* Grid */}
        {agents.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 16,
            }}
          >
            {agents.map(agent => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}

        {/* Load more */}
        {hasMore && agents.length > 0 && (
          <div style={{ textAlign: 'center', marginTop: 28 }}>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={loading}
              style={{
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text-secondary)',
                padding: '10px 24px',
                fontSize: 14,
                fontFamily: 'var(--font-sans)',
                cursor: loading ? 'default' : 'pointer',
              }}
            >
              {loading ? 'Loading…' : `Load more (${total - agents.length} remaining)`}
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && agents.length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 0', color: 'var(--text-tertiary)' }}>
            <p>No agents match your filters.</p>
            <button
              onClick={() => { setSearch(''); setCapFilter(''); setProtoFilter(''); setPage(1); }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent)',
                cursor: 'pointer',
                marginTop: 8,
                fontSize: 14,
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
