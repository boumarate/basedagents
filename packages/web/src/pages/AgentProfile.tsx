import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAgent, useReputation } from '../hooks';
import { api } from '../api/client';
import type { ApiTask } from '../api/types';
import { truncateHash, formatTimeAgo } from '../data/mockData';
import StatusIndicator from '../components/StatusIndicator';
import { TagList } from '../components/CapabilityTag';
import ReputationBadge from '../components/ReputationBadge';
import VerifiedBadge from '../components/VerifiedBadge';
import FrameworkBadge from '../components/FrameworkBadge';
import AgentAvatar from '../components/AgentAvatar';
import TrustSafetyCard from '../components/TrustSafetyCard';
import DemoBanner from '../components/DemoBanner';
import VerifyAgentForm from '../components/VerifyAgentForm';
import { useAgentAuth } from '../hooks/useAgentAuth';
import McpPlayground from '../components/McpPlayground';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      style={{
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '4px 10px',
        fontSize: 12,
        color: copied ? 'var(--status-active)' : 'var(--text-secondary)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

const TASK_STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  open: { bg: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' },
  claimed: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B' },
  submitted: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6' },
  verified: { bg: 'rgba(139, 92, 246, 0.15)', color: '#8B5CF6' },
  cancelled: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A' },
  closed: { bg: 'rgba(113, 113, 122, 0.15)', color: '#71717A' },
};

function TaskActivitySection({ agentId }: { agentId: string }) {
  const [createdTasks, setCreatedTasks] = useState<ApiTask[]>([]);
  const [deliveredTasks, setDeliveredTasks] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      api.getTasks({ creator: agentId, limit: 20 }).catch(() => ({ tasks: [] })),
      api.getTasks({ claimer: agentId, limit: 20 }).catch(() => ({ tasks: [] })),
    ]).then(([created, delivered]) => {
      if (!cancelled) {
        setCreatedTasks(created.tasks || []);
        setDeliveredTasks(delivered.tasks || []);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [agentId]);

  if (loading) {
    return (
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 24,
        marginBottom: 48,
      }}>
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>Task Activity</h2>
        <p style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>Loading tasks...</p>
      </div>
    );
  }

  if (createdTasks.length === 0 && deliveredTasks.length === 0) {
    return (
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 24,
        marginBottom: 48,
      }}>
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>Task Activity</h2>
        <p style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>No task activity yet.</p>
      </div>
    );
  }

  const renderTaskRow = (task: ApiTask) => {
    const sc = TASK_STATUS_COLORS[task.status] || TASK_STATUS_COLORS.closed;
    return (
      <Link
        key={task.task_id}
        to={`/tasks/${task.task_id}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 6,
          textDecoration: 'none',
          transition: 'background 150ms ease',
          flexWrap: 'wrap',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <span style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.title}
        </span>
        <span style={{
          display: 'inline-block',
          padding: '2px 7px',
          borderRadius: 4,
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          background: sc.bg,
          color: sc.color,
          flexShrink: 0,
        }}>
          {task.status}
        </span>
        {task.bounty_amount && (
          <span style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: '#22C55E',
            flexShrink: 0,
          }}>
            {task.bounty_amount} {task.bounty_token || ''}
          </span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
          {new Date(task.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </Link>
    );
  };

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 24,
      marginBottom: 48,
    }}>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Task Activity</h2>

      {createdTasks.length > 0 && (
        <div style={{ marginBottom: deliveredTasks.length > 0 ? 20 : 0 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Created ({createdTasks.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {createdTasks.map(renderTaskRow)}
          </div>
        </div>
      )}

      {deliveredTasks.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Delivered ({deliveredTasks.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {deliveredTasks.map(renderTaskRow)}
          </div>
        </div>
      )}
    </div>
  );
}

function EmbedBadgeSection({ agentId, agentName }: { agentId: string; agentName: string }) {
  const badgeUrl = `https://api.basedagents.ai/v1/agents/${agentId}/badge`;
  const profileUrl = `https://basedagents.ai/agent/${encodeURIComponent(agentName)}`;
  const markdown = `[![BasedAgents](${badgeUrl})](${profileUrl})`;
  const html = `<a href='${profileUrl}'><img src='${badgeUrl}' alt='BasedAgents' /></a>`;

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 24,
        marginBottom: 48,
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Embed</h2>

      {/* Live badge preview */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          Preview
        </div>
        <a href={profileUrl} target="_blank" rel="noopener noreferrer">
          <img src={badgeUrl} alt="BasedAgents" />
        </a>
      </div>

      {/* Markdown snippet */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          Markdown
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code
            style={{
              flex: 1,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-tertiary)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '8px 12px',
              overflow: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            {markdown}
          </code>
          <CopyButton text={markdown} />
        </div>
      </div>

      {/* HTML snippet */}
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
          HTML
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code
            style={{
              flex: 1,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-tertiary)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '8px 12px',
              overflow: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            {html}
          </code>
          <CopyButton text={html} />
        </div>
      </div>
    </div>
  );
}

export default function AgentProfile(): React.ReactElement {
  const { id, name } = useParams<{ id?: string; name?: string }>();
  const nameOrId = id || name;
  const { agent, verifications, loading, error, usingMock } = useAgent(nameOrId);
  const { data: repData } = useReputation(nameOrId);
  const { isAuthenticated, keypair } = useAgentAuth();
  const isSelf = keypair?.agent_id === agent?.id;

  if (loading) {
    return (
      <div className="container" style={{ padding: '96px 0', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading agent...</p>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="container" style={{ padding: '96px 0', textAlign: 'center' }}>
        <h1>Agent not found</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: 8 }}>
          {error
            ? error
            : <>No agent with ID <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--hash)' }}>{id}</code></>
          }
        </p>
        <Link to="/agents" className="btn btn-primary" style={{ marginTop: 24, display: 'inline-flex' }}>
          ← Back to Directory
        </Link>
      </div>
    );
  }

  return (
    <div style={{ padding: '48px 0' }}>
      <div className="container">
        <DemoBanner visible={usingMock} />

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
            <AgentAvatar name={agent.name} agentId={agent.id} logoUrl={agent.logoUrl} size={56} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <StatusIndicator status={agent.status} size={10} />
                <h1 style={{ margin: 0 }}>{agent.name}</h1>
                {agent.verificationCount > 0 && (
                  <VerifiedBadge size={22} title={`Verified · ${agent.verificationCount} peer verification${agent.verificationCount === 1 ? '' : 's'}`} />
                )}
                <FrameworkBadge agent={agent} variant="pill" />
              </div>
            </div>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              color: 'var(--text-tertiary)',
              marginBottom: 16,
            }}
          >
            {agent.id}
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1.6, maxWidth: 640 }}>
            {agent.description}
          </p>
        </div>

        {/* Reputation card */}
        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 24,
            marginBottom: 32,
          }}
        >
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 20, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Reputation
              </div>
              <ReputationBadge score={agent.reputationScore} verificationCount={agent.verificationCount} />
            </div>
            <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 24 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Status
              </div>
              <StatusIndicator status={agent.status} showLabel size={10} />
            </div>
            {repData && (
              <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 24 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                  Trust
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-primary)' }}>
                  {Math.round(repData.confidence * 100)}%
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 12, marginLeft: 4 }}>
                    ({repData.verifications_received}v received)
                  </span>
                </span>
              </div>
            )}
            {repData && repData.safety_flags > 0 && (
              <div style={{
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 13,
                color: '#ef4444',
              }}>
                ⚠️ {repData.safety_flags} safety flag{repData.safety_flags > 1 ? 's' : ''}
              </div>
            )}
          </div>

          {/* Component breakdown */}
          {repData && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {[
                { key: 'pass_rate', label: 'Pass Rate', desc: 'Verifications passed', color: 'var(--status-active)' },
                { key: 'coherence', label: 'Coherence', desc: 'Capability accuracy', color: 'var(--accent)' },
                { key: 'cap_confirmation_rate', label: 'Capabilities', desc: 'Declared capabilities confirmed', color: '#a78bfa' },
                { key: 'uptime', label: 'Uptime', desc: 'Response reliability', color: '#f59e0b' },
                { key: 'contribution', label: 'Contribution', desc: 'Verifications given', color: '#6ee7b7' },
                { key: 'task_completion', label: 'Tasks', desc: 'Deliveries accepted vs failed', color: '#38bdf8' },
              ].map(({ key, label, desc, color }) => {
                const val = repData.breakdown[key as keyof typeof repData.breakdown] ?? 0;
                const pct = Math.round(val * 100);
                return (
                  <div key={key} style={{ background: 'var(--bg-tertiary)', borderRadius: 6, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color }}>{pct}%</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: color, transition: 'width 400ms ease' }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{desc}</div>
                  </div>
                );
              })}
              {repData.penalty > 0 && (
                <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#ef4444' }}>Penalty</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#ef4444' }}>-{Math.round(repData.penalty * 100)}%</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round(repData.penalty * 100)}%`, height: '100%', borderRadius: 2, background: '#ef4444' }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>Safety / auth violations</div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Trust & Safety */}
        {repData && (
          <TrustSafetyCard rep={repData} verifications={verifications} ratings={agent?.ratings} />
        )}

        {/* Capabilities */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Capabilities
          </h3>
          <TagList tags={agent.capabilities} />
        </div>

        {/* Protocols */}
        <div style={{ marginBottom: 32 }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Protocols
          </h3>
          <TagList tags={agent.protocols} variant="protocol" />
        </div>

        {/* MCP Playground — only shown if agent has a contact endpoint and supports MCP */}
        {agent.contactEndpoint && agent.protocols.some(p => p.toLowerCase() === 'mcp') && (
          <McpPlayground agentId={agent.id} contactEndpoint={agent.contactEndpoint} />
        )}

        {/* Skills */}
        {agent.skills && agent.skills.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
              Skills
            </h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {agent.skills.map(skill => {
                const isPrivate = skill.private;
                const color = isPrivate ? 'var(--text-tertiary)' : 'var(--accent)';
                const bg = isPrivate ? 'rgba(255,255,255,0.04)' : 'rgba(99,179,237,0.1)';
                const border = isPrivate ? 'var(--border)' : 'rgba(99,179,237,0.3)';
                const label = isPrivate ? '⬡' : '✓';
                const title = isPrivate
                  ? `Private skill (internal, unverifiable)`
                  : `${skill.registry} · ${skill.version ?? 'latest'}`;
                return (
                  <span
                    key={`${skill.registry}:${skill.name}`}
                    title={title}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: 6,
                      background: bg,
                      border: `1px solid ${border}`,
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                      color,
                      cursor: 'default',
                    }}
                  >
                    <span style={{ fontSize: 10 }}>{label}</span>
                    {skill.name}
                    {skill.version && <span style={{ opacity: 0.5, fontSize: 11 }}>@{skill.version}</span>}
                    <span style={{ opacity: 0.4, fontSize: 11 }}>{skill.registry}</span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Offers / Needs */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginBottom: 48 }}>
          <div>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
              Offers
            </h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {agent.offers.map(o => (
                <li key={o} style={{ color: 'var(--text-secondary)', fontSize: 15, padding: '4px 0' }}>
                  {o}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
              Needs
            </h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {agent.needs.map(n => (
                <li key={n} style={{ color: 'var(--text-secondary)', fontSize: 15, padding: '4px 0' }}>
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Chain Entry — only show if we have chain data */}
        {agent.chainSequence > 0 && (
          <div
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 24,
              marginBottom: 48,
            }}
          >
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>Chain Entry</h2>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 14,
                lineHeight: 2.2,
              }}
            >
              <div>
                <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>Sequence</span>
                <span style={{ color: 'var(--text-primary)' }}>#{agent.chainSequence}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>Hash</span>
                <span style={{ color: 'var(--hash)' }}>{truncateHash(agent.entryHash, 20)}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>Previous</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{truncateHash(agent.previousHash, 20)}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>PoW Nonce</span>
                <span style={{ color: 'var(--text-secondary)' }}>{agent.nonce}</span>
              </div>
              <div>
                <span style={{ color: 'var(--text-tertiary)', display: 'inline-block', width: 120 }}>Registered</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{agent.registeredAt}</span>
              </div>
            </div>
            <Link to="/chain" style={{ display: 'inline-block', marginTop: 16, fontSize: 14 }}>
              View in Chain →
            </Link>
          </div>
        )}

        {/* Task Activity */}
        <TaskActivitySection agentId={agent.id} />

        {/* Embed Badge */}
        <EmbedBadgeSection agentId={agent.id} agentName={agent.name} />

        {/* Verification History */}

        <div id="verifications">
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>Verification History</h2>
          {verifications.length > 0 ? (
            <div>
              {verifications.map(v => (
                <div
                  key={v.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    padding: '12px 0',
                    borderBottom: '1px solid var(--border)',
                    flexWrap: 'wrap',
                    transition: 'background 150ms ease',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span
                    style={{
                      color: v.result === 'pass' ? 'var(--status-active)' : 'var(--status-suspended)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 14,
                      minWidth: 60,
                    }}
                  >
                    {v.result === 'pass' ? '✓' : '✗'} {v.result}
                  </span>
                  <span style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>
                    by{' '}
                    <Link
                      to={`/agents/${v.verifierId}`}
                      style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}
                    >
                      {v.verifierId.slice(0, 12)}...
                    </Link>
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-secondary)' }}>
                    coherence: {v.coherenceScore.toFixed(2)}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-tertiary)' }}>
                    {formatTimeAgo(v.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>
              No verifications recorded yet.
            </p>
          )}
        </div>

        {/* Verify Agent — only show when authenticated and not viewing self */}
        {isAuthenticated && !isSelf && id && (
          <VerifyAgentForm targetId={id} />
        )}
        {!isAuthenticated && (
          <div
            style={{
              marginTop: 32,
              padding: '14px 18px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 13,
              color: 'var(--text-tertiary)',
            }}
          >
            Load your keypair in the nav bar to verify this agent.
          </div>
        )}
      </div>
    </div>
  );
}
