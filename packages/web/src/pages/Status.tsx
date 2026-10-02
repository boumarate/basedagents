import React, { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? 'https://api.basedagents.ai';

interface StatusData {
  status: 'operational' | 'degraded' | 'down';
  version: string;
  db_latency_ms: number;
  agents: { total: number; active: number; pending: number; suspended: number };
  chain: { height: number; last_hash: string | null };
  verifications: { total: number; last_at: string | null };
  last_registration: { name: string; at: string } | null;
  checked_at: string;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function latencyLabel(ms: number): string {
  if (ms < 100) return 'Fast';
  if (ms < 300) return 'Good';
  if (ms < 800) return 'Slow';
  return 'Degraded';
}

function latencyColor(ms: number): string {
  if (ms < 100) return 'var(--status-active)';
  if (ms < 300) return 'var(--status-active)';
  if (ms < 800) return '#f59e0b';
  return 'var(--status-suspended)';
}

const STATUS_CONFIG = {
  operational: { label: 'All systems operational', color: 'var(--status-active)', dot: '●' },
  degraded:    { label: 'Degraded performance',    color: '#f59e0b',              dot: '◐' },
  down:        { label: 'Service disruption',      color: 'var(--status-suspended)', dot: '●' },
};

function ServiceRow({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 0', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: ok ? 'var(--status-active)' : 'var(--status-suspended)', fontSize: 10 }}>●</span>
        <span style={{ fontSize: 15, color: 'var(--text-primary)' }}>{name}</span>
      </div>
      <span style={{ fontSize: 13, color: ok ? 'var(--status-active)' : 'var(--status-suspended)' }}>
        {detail}
      </span>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '20px 24px',
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
        {value}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function Status(): React.ReactElement {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchMs, setFetchMs] = useState<number | null>(null);

  useEffect(() => {
    const load = async () => {
      const t0 = Date.now();
      try {
        const res = await fetch(`${API_URL}/v1/status`);
        setFetchMs(Date.now() - t0);
        if (!res.ok) throw new Error('non-2xx');
        setData(await res.json() as StatusData);
        setError(false);
      } catch {
        setFetchMs(Date.now() - t0);
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 30_000); // refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const statusCfg = error
    ? STATUS_CONFIG.down
    : data
      ? STATUS_CONFIG[data.status] ?? STATUS_CONFIG.operational
      : STATUS_CONFIG.operational;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px' }}>System Status</h1>
        <p style={{ color: 'var(--text-tertiary)', margin: 0, fontSize: 15 }}>
          Live metrics for the BasedAgents registry infrastructure.
        </p>
      </div>

      {/* Overall status banner */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '20px 24px',
        display: 'flex', alignItems: 'center', gap: 14,
        marginBottom: 40,
      }}>
        {loading ? (
          <span style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>Checking…</span>
        ) : (
          <>
            <span style={{ color: statusCfg.color, fontSize: 18 }}>{statusCfg.dot}</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16, color: 'var(--text-primary)' }}>
                {statusCfg.label}
              </div>
              {data && (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  Last checked {timeAgo(data.checked_at)}
                  {fetchMs !== null && ` · ${fetchMs}ms`}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Services */}
      <div style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 0 }}>
          Services
        </h2>
        <ServiceRow
          name="API"
          ok={!error && !!data}
          detail={!error && fetchMs !== null ? `${fetchMs}ms` : error ? 'Unreachable' : '—'}
        />
        <ServiceRow
          name="Database"
          ok={!error && !!data}
          detail={data ? `${data.db_latency_ms}ms · ${latencyLabel(data.db_latency_ms)}` : error ? 'Unknown' : '—'}
        />
        <ServiceRow
          name="Chain"
          ok={!error && !!data && (data.chain.height ?? 0) > 0}
          detail={data ? `Block ${data.chain.height}` : error ? 'Unknown' : '—'}
        />
      </div>

      {/* Stats */}
      {data && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>
            Registry Stats
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 40 }}>
            <StatCard label="Total Agents" value={data.agents.total} />
            <StatCard
              label="Active Agents"
              value={data.agents.active}
              sub={data.agents.total > 0 ? `${Math.round(data.agents.active / data.agents.total * 100)}% of total` : undefined}
            />
            <StatCard label="Chain Height" value={data.chain.height} sub="registrations" />
            <StatCard
              label="Verifications"
              value={data.verifications.total}
              sub={data.verifications.last_at ? `Last ${timeAgo(data.verifications.last_at)}` : 'none yet'}
            />
          </div>

          {/* Agent breakdown */}
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>
            Agent Breakdown
          </h2>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 40 }}>
            {([
              ['Active', data.agents.active, 'var(--status-active)'],
              ['Pending', data.agents.pending, 'var(--status-pending)'],
              ['Suspended', data.agents.suspended, 'var(--status-suspended)'],
            ] as [string, number, string][]).map(([label, count, color]) => {
              const pct = data.agents.total > 0 ? (count / data.agents.total) * 100 : 0;
              return (
                <div key={label} style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ color, fontSize: 10 }}>●</span>
                  <span style={{ fontSize: 14, color: 'var(--text-primary)', minWidth: 80 }}>{label}</span>
                  <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-secondary)', minWidth: 24, textAlign: 'right' }}>{count}</span>
                </div>
              );
            })}
          </div>

          {/* Recent activity */}
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>
            Recent Activity
          </h2>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {data.last_registration && (
              <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, color: 'var(--text-primary)' }}>
                  <span style={{ color: 'var(--text-tertiary)' }}>Last registration</span>
                  {' · '}
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{data.last_registration.name}</span>
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{timeAgo(data.last_registration.at)}</span>
              </div>
            )}
            {data.verifications.last_at && (
              <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>Last verification</span>
                <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{timeAgo(data.verifications.last_at)}</span>
              </div>
            )}
            {!data.last_registration && !data.verifications.last_at && (
              <div style={{ padding: '20px', color: 'var(--text-tertiary)', fontSize: 14 }}>No activity yet.</div>
            )}
          </div>
        </>
      )}

      {error && !loading && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: 20, color: '#ef4444', fontSize: 14 }}>
          Could not reach the API. The service may be experiencing issues.
        </div>
      )}
    </div>
  );
}
