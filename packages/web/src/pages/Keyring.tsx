import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouteMeta } from '../hooks/useRouteMeta';
import CodeSnippet from '../components/CodeSnippet';
import {
  DemoVault,
  LeaseDeniedError,
  type DemoAccessEvent,
  type DemoEventType,
  type VerifyLogResult,
} from '../lib/keyringDemo';

const SPEC_URL = 'https://github.com/maxfain/basedagents/blob/main/KEYRING_SPEC.md';
const README_URL = 'https://github.com/maxfain/basedagents/blob/main/packages/keyring/README.md';

const installCmd = 'npm install -g @basedagents/keyring';

// Copied exactly from packages/keyring/README.md
const mcpConfig = `{
  "mcpServers": {
    "keyring": {
      "command": "npx",
      "args": ["-y", "--package=@basedagents/keyring", "basedagents-keyring-mcp"],
      "env": {
        "BASEDAGENTS_KEYPAIR_PATH": "~/.basedagents/agent-keypair.json"
      }
    }
  }
}`;

const PROBLEMS = [
  {
    title: 'Provisioning friction',
    desc: 'Every new project means five dashboard logins and pasting keys into .env files.',
  },
  {
    title: 'Zero visibility',
    desc: 'Nobody can answer "which agents hold my Supabase service-role key right now?"',
  },
  {
    title: 'Revocation is fiction',
    desc: 'Deleting a key from .env does nothing. The real key lives on at the provider until someone rotates it.',
  },
];

const EVENT_COLORS: Record<string, { bg: string; color: string }> = {
  lease: { bg: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' },
  lease_denied: { bg: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' },
  kill_switch: { bg: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' },
  grant_revoked: { bg: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' },
  grant_created: { bg: 'var(--accent-muted)', color: 'var(--accent)' },
};
const EVENT_NEUTRAL = { bg: 'rgba(113, 113, 122, 0.15)', color: '#A1A1AA' };

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '18px 20px',
};

const monoSmall: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--text-tertiary)',
};

function truncId(id: string): string {
  return `${id.slice(0, 11)}…`;
}

function fmtCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500,
      textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
    }}>
      {children}
    </div>
  );
}

function StepCard({ index, title, enabled, children }: {
  index: number;
  title: string;
  enabled: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{
      ...cardStyle,
      opacity: enabled ? 1 : 0.45,
      pointerEvents: enabled ? 'auto' : 'none',
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{
          width: 24, height: 24, borderRadius: '50%', background: 'var(--accent-muted)',
          color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', flexShrink: 0,
        }}>
          {index}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-primary)' }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function DenialBox({ text, caption }: { text: string; caption?: string }): React.ReactElement {
  return (
    <div style={{
      marginTop: 10, padding: '10px 12px', borderRadius: 6,
      background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)',
    }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#EF4444' }}>
        ✗ lease_denied — {text}
      </div>
      {caption && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{caption}</div>
      )}
    </div>
  );
}

export default function Keyring(): React.ReactElement {
  useRouteMeta('/keyring/demo');
  const vaultRef = useRef<DemoVault | null>(null);
  const [ready, setReady] = useState(false);
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion(v => v + 1), []);

  // Step 1 — credential
  const [label, setLabel] = useState('Stripe secret (prod)');
  const [secret, setSecret] = useState('sk_live_demo_4242');
  const [credId, setCredId] = useState<string | null>(null);
  const [sealedExpanded, setSealedExpanded] = useState(false);
  // Step 2 — grant
  const [maxUses, setMaxUses] = useState(2);
  const [ttlSeconds, setTtlSeconds] = useState(600);
  const [granted, setGranted] = useState(false);
  // Step 3 — lease as ci-bot
  const [leaseInfo, setLeaseInfo] = useState<{ value: string; ttlSeconds: number; expiresAt: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [leaseError, setLeaseError] = useState<string | null>(null);
  const [leaseAttempted, setLeaseAttempted] = useState(false);
  // Step 4 — lease as deploy-bot
  const [deployError, setDeployError] = useState<string | null>(null);
  // Step 5 — kill switch
  const [killed, setKilled] = useState(false);
  const [postKillError, setPostKillError] = useState<string | null>(null);
  // Step 6 — verify
  const [verifyResult, setVerifyResult] = useState<VerifyLogResult | null>(null);
  const [tampered, setTampered] = useState(false);

  const initVault = useCallback(async () => {
    const vault = new DemoVault();
    await vault.init(['ci-bot', 'deploy-bot']);
    vaultRef.current = vault;
    setReady(true);
    bump();
  }, [bump]);

  useEffect(() => {
    void initVault();
  }, [initVault]);

  // Live TTL countdown — visual only; the interval is cleaned up on change/unmount.
  useEffect(() => {
    if (!leaseInfo) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((leaseInfo.expiresAt - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [leaseInfo]);

  const reset = useCallback(async () => {
    setReady(false);
    vaultRef.current?.untamper();
    setCredId(null); setSealedExpanded(false);
    setLabel('Stripe secret (prod)'); setSecret('sk_live_demo_4242');
    setMaxUses(2); setTtlSeconds(600); setGranted(false);
    setLeaseInfo(null); setLeaseError(null); setLeaseAttempted(false);
    setDeployError(null); setKilled(false); setPostKillError(null);
    setVerifyResult(null); setTampered(false);
    await initVault();
  }, [initVault]);

  const addCredential = async () => {
    const vault = vaultRef.current;
    if (!vault) return;
    const cred = await vault.addCredential(label || 'Stripe secret (prod)', 'STRIPE_SECRET_KEY', secret || 'sk_live_demo_4242');
    setCredId(cred.credential_id);
    bump();
  };

  const createGrant = async () => {
    const vault = vaultRef.current;
    if (!vault || !credId) return;
    await vault.createGrant(credId, 'ci-bot', { maxUses, maxTtlSeconds: ttlSeconds });
    setGranted(true);
    bump();
  };

  const leaseAs = async (agent: string, context: string): Promise<string | null> => {
    const vault = vaultRef.current;
    if (!vault || !credId) return null;
    try {
      const lease = await vault.lease(agent, credId, context);
      setLeaseInfo({ value: lease.value, ttlSeconds: lease.ttlSeconds, expiresAt: lease.expiresAt.getTime() });
      return null;
    } catch (err) {
      if (err instanceof LeaseDeniedError) return err.message;
      throw err;
    } finally {
      bump();
    }
  };

  const leaseAsCiBot = async () => {
    setLeaseAttempted(true);
    setLeaseError(await leaseAs('ci-bot', 'deploy checkout service'));
  };

  const leaseAsDeployBot = async () => {
    setDeployError(await leaseAs('deploy-bot', 'read production secrets'));
  };

  const killCiBot = async () => {
    const vault = vaultRef.current;
    if (!vault) return;
    await vault.killSwitch('ci-bot');
    setKilled(true);
    bump();
  };

  const leaseAfterKill = async () => {
    setPostKillError(await leaseAs('ci-bot', 'deploy checkout service (after kill)'));
  };

  const runVerify = async () => {
    const vault = vaultRef.current;
    if (!vault) return;
    setVerifyResult(await vault.verifyLog());
  };

  const toggleTamper = async () => {
    const vault = vaultRef.current;
    if (!vault) return;
    if (tampered) {
      vault.untamper();
      setTampered(false);
    } else {
      vault.tamper(3);
      setTampered(true);
    }
    bump();
    setVerifyResult(await vault.verifyLog());
  };

  const vault = vaultRef.current;
  const events: DemoAccessEvent[] = vault ? [...vault.events].reverse() : [];
  const ownerId = vault?.owner.agent_id ?? '';
  const expired = leaseInfo !== null && remaining <= 0;

  return (
    <div>
      {/* ── Hero ── */}
      <div style={{ padding: '64px 0 48px', borderBottom: '1px solid var(--border)' }}>
        <div className="container">
          <h1 style={{ marginBottom: 16 }}>Keyring</h1>
          <p style={{ fontSize: 20, color: 'var(--text-primary)', lineHeight: 1.5, maxWidth: 640, marginBottom: 12 }}>
            Your agents already have identities. Keyring is what those identities are trusted to carry.
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: 16, lineHeight: 1.6, maxWidth: 640, marginBottom: 28 }}>
            Scoped, revocable credentials for AI agents. Secrets are sealed to identity keys,
            leased for at most 15 minutes, and every access is a signed event.
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '0 1 420px', minWidth: 260 }}>
              <CodeSnippet terminal>{installCmd}</CodeSnippet>
            </div>
            <a
              href={SPEC_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              style={{ textDecoration: 'none' }}
            >
              Read the spec →
            </a>
          </div>
        </div>
      </div>

      {/* ── Problem strip ── */}
      <div style={{ padding: '48px 0', borderBottom: '1px solid var(--border)' }}>
        <div className="container">
          <h2 style={{ marginBottom: 8 }}>Running agents across your stack fails in three ways</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 15, marginBottom: 24 }}>
            Keyring fixes the first two today, and is honest about the third.
          </p>
          <div className="keyring-three-col">
            {PROBLEMS.map(p => (
              <div key={p.title} style={cardStyle}>
                <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>{p.title}</div>
                <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.55, margin: 0 }}>{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Live demo ── */}
      <div id="demo" style={{ padding: '48px 0', borderBottom: '1px solid var(--border)', scrollMarginTop: 80 }}>
        <div className="container-wide">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Live demo</h2>
            <button className="keyring-btn keyring-btn-ghost" onClick={reset} disabled={!ready}>
              Reset demo
            </button>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 15, marginBottom: 6, maxWidth: 720 }}>
            This demo runs real cryptography in your browser. Nothing leaves this page.
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 24, maxWidth: 720 }}>
            Ed25519 identities, X25519 sealed boxes, XChaCha20-Poly1305, SHA-256 hash chain —
            the same construction the shipped package uses.
          </p>

          {!ready && (
            <div style={{ ...cardStyle, color: 'var(--text-tertiary)' }}>Generating Ed25519 keypairs…</div>
          )}

          {ready && vault && (
            <div className="keyring-demo-grid">
              {/* ── Left: action flow ── */}
              <div>
                {/* Step 1 */}
                <StepCard index={1} title="Add a credential" enabled={true}>
                  <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
                    <label style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      Label
                      <input className="keyring-input" type="text" value={label}
                        onChange={e => setLabel(e.target.value)} disabled={credId !== null} />
                    </label>
                    <label style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      Secret value
                      <input className="keyring-input" type="text" value={secret}
                        onChange={e => setSecret(e.target.value)} disabled={credId !== null} />
                    </label>
                  </div>
                  <button className="keyring-btn" onClick={addCredential} disabled={credId !== null}>
                    {credId ? '✓ Sealed to owner key' : 'Seal to owner key'}
                  </button>
                  {credId && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{
                        fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)',
                        background: 'var(--bg-tertiary)', borderRadius: 6, padding: '8px 10px',
                        wordBreak: 'break-all', border: '1px solid var(--border)',
                      }}>
                        {sealedExpanded
                          ? vault.credentials[0]?.sealed[ownerId]
                          : `${vault.credentials[0]?.sealed[ownerId]?.slice(0, 56)}…`}
                        {' '}
                        <button
                          onClick={() => setSealedExpanded(x => !x)}
                          style={{
                            background: 'none', border: 'none', color: 'var(--accent)',
                            cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font-mono)', padding: 0,
                          }}
                        >
                          [{sealedExpanded ? 'collapse' : 'expand'}]
                        </button>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 6 }}>
                        This is all the vault ever stores.
                      </div>
                    </div>
                  )}
                </StepCard>

                {/* Step 2 */}
                <StepCard index={2} title="Grant to ci-bot" enabled={credId !== null}>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 12, color: 'var(--text-tertiary)', flex: '1 1 120px' }}>
                      Max uses
                      <input className="keyring-input" type="number" min={1} max={10} value={maxUses}
                        onChange={e => setMaxUses(Math.max(1, Number(e.target.value) || 1))} disabled={granted} />
                    </label>
                    <label style={{ fontSize: 12, color: 'var(--text-tertiary)', flex: '1 1 120px' }}>
                      Max lease TTL (seconds)
                      <input className="keyring-input" type="number" min={30} max={900} step={30} value={ttlSeconds}
                        onChange={e => setTtlSeconds(Math.min(900, Math.max(30, Number(e.target.value) || 600)))} disabled={granted} />
                    </label>
                  </div>
                  <button className="keyring-btn" onClick={createGrant} disabled={granted}>
                    {granted ? '✓ Grant created' : 'Create grant'}
                  </button>
                  {granted && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 8 }}>
                      The secret was re-sealed to ci-bot's public key — its copy appears in the vault state.
                    </div>
                  )}
                </StepCard>

                {/* Step 3 */}
                <StepCard index={3} title="Lease as ci-bot" enabled={granted}>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                    ci-bot signs the lease payload with its own key and opens its sealed copy.
                    Click more than {maxUses} times to hit the usage cap.
                  </p>
                  <button className="keyring-btn" onClick={leaseAsCiBot}>
                    Lease as ci-bot
                  </button>
                  {leaseInfo && (
                    <div style={{
                      marginTop: 10, padding: '10px 12px', borderRadius: 6,
                      background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.3)',
                    }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#22C55E', wordBreak: 'break-all' }}>
                        STRIPE_SECRET_KEY={leaseInfo.value}
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 6, color: expired ? '#EF4444' : 'var(--text-secondary)' }}>
                        {expired
                          ? '✗ lease EXPIRED — the in-memory value is gone'
                          : `TTL ${fmtCountdown(remaining)} — in memory only, never written to disk`}
                      </div>
                    </div>
                  )}
                  {leaseError && <DenialBox text={leaseError} />}
                </StepCard>

                {/* Step 4 */}
                <StepCard index={4} title="Lease as deploy-bot" enabled={leaseAttempted}>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                    deploy-bot has no grant for this credential.
                  </p>
                  <button className="keyring-btn" onClick={leaseAsDeployBot}>
                    Lease as deploy-bot
                  </button>
                  {deployError && (
                    <DenialBox
                      text="no grant for this identity"
                      caption="This attempt is on the record — denials are signed events too."
                    />
                  )}
                </StepCard>

                {/* Step 5 */}
                <StepCard index={5} title="Kill switch ci-bot" enabled={deployError !== null}>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                    Revokes every grant ci-bot holds and deletes its sealed copy from the vault.
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="keyring-btn keyring-btn-danger" onClick={killCiBot} disabled={killed}>
                      {killed ? '✓ ci-bot revoked' : 'Kill switch ci-bot'}
                    </button>
                    {killed && (
                      <button className="keyring-btn keyring-btn-ghost" onClick={leaseAfterKill}>
                        Lease as ci-bot again
                      </button>
                    )}
                  </div>
                  {postKillError && <DenialBox text="grant was revoked" />}
                  {killed && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 10, lineHeight: 1.5 }}>
                      New leases are blocked instantly and the sealed copy is deleted.
                      Outstanding leases die within their TTL. Provider-side keys persist
                      until rotated — automated burns are the v0.2 Provisioner.
                    </div>
                  )}
                </StepCard>

                {/* Step 6 */}
                <StepCard index={6} title="Verify the log" enabled={killed}>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                    Recomputes the hash chain and checks every Ed25519 signature — the same
                    verification <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>based verify-log</span> runs offline.
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="keyring-btn" onClick={runVerify}>Verify the log</button>
                    <button className="keyring-btn keyring-btn-ghost" onClick={toggleTamper}>
                      {tampered ? 'Untamper event #3' : 'Tamper with event #3'}
                    </button>
                  </div>
                  {verifyResult && (
                    <div style={{
                      marginTop: 10, padding: '10px 12px', borderRadius: 6,
                      background: verifyResult.ok ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                      border: `1px solid ${verifyResult.ok ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                    }}>
                      <div style={{
                        fontFamily: 'var(--font-mono)', fontSize: 13,
                        color: verifyResult.ok ? '#22C55E' : '#EF4444',
                      }}>
                        {verifyResult.ok
                          ? `✓ ${verifyResult.events_checked} events · hash chain intact · all signatures valid`
                          : `✗ verification failed — ${verifyResult.errors.length} error(s) across ${verifyResult.events_checked} events`}
                      </div>
                      {!verifyResult.ok && verifyResult.errors.slice(0, 3).map((e, i) => (
                        <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                          #{e.sequence}: {e.error}
                        </div>
                      ))}
                    </div>
                  )}
                </StepCard>
              </div>

              {/* ── Right: vault state + event log ── */}
              <div>
                {/* Vault state */}
                <div style={{ ...cardStyle, marginBottom: 12 }}>
                  <SectionLabel>Vault state — ciphertext only</SectionLabel>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Identities</div>
                    {vault.identities.map(id => (
                      <div key={id.agent_id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 80 }}>
                          {id.name}{id.is_owner ? ' (you)' : ''}
                        </span>
                        <span style={monoSmall}>{truncId(id.agent_id)}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Credentials</div>
                    {vault.credentials.length === 0 && (
                      <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>None yet — run step 1.</div>
                    )}
                    {vault.credentials.map(cred => (
                      <div key={cred.credential_id}>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                          {cred.label}{' '}
                          <span style={{ ...monoSmall, color: 'var(--accent)' }}>{cred.env_var}</span>
                        </div>
                        <div style={{ marginTop: 4 }}>
                          {Object.entries(cred.sealed).map(([agentId, box]) => (
                            <div key={agentId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '1px 0 1px 12px', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', minWidth: 68 }}>
                                sealed[{vault.nameForPubkey(agentId.slice(3))}]
                              </span>
                              <span style={{ ...monoSmall, color: 'var(--text-secondary)' }}>{box.slice(0, 16)}…</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Grants</div>
                    {vault.grants.length === 0 && (
                      <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>None yet — run step 2.</div>
                    )}
                    {vault.grants.map(g => (
                      <div key={g.grant_id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                          {vault.nameForPubkey(g.agent_id.slice(3))}
                        </span>
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 4,
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                          background: g.status === 'active' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: g.status === 'active' ? '#22C55E' : '#EF4444',
                        }}>
                          {g.status}
                        </span>
                        <span style={monoSmall}>
                          uses {g.use_count}/{g.constraints.max_uses} · ttl ≤ {g.constraints.max_lease_ttl_seconds}s
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Event log */}
                <div style={cardStyle}>
                  <SectionLabel>Access log — signed, hash-chained, newest first</SectionLabel>
                  <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                    {events.map(e => {
                      const colors = EVENT_COLORS[e.event_type as DemoEventType] ?? EVENT_NEUTRAL;
                      const reason = e.detail && typeof e.detail.reason === 'string' ? e.detail.reason : null;
                      return (
                        <div key={e.event_id} style={{
                          display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
                          padding: '7px 0', borderBottom: '1px solid var(--border)',
                        }}>
                          <span style={{ ...monoSmall, minWidth: 24 }}>#{e.sequence}</span>
                          <span style={{
                            fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 4,
                            fontFamily: 'var(--font-mono)', background: colors.bg, color: colors.color,
                          }}>
                            {e.event_type}
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {vault.nameForPubkey(e.agent_pubkey)}
                          </span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--hash)' }}>
                            {e.entry_hash.slice(0, 10)}…
                          </span>
                          {(e.requesting_context || reason) && (
                            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                              {e.requesting_context}{e.requesting_context && reason ? ' · ' : ''}{reason}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── How it works ── */}
      <div style={{ padding: '48px 0', borderBottom: '1px solid var(--border)' }}>
        <div className="container">
          <h2 style={{ marginBottom: 24 }}>How it works</h2>
          <div className="keyring-three-col">
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>1. Add a secret</div>
              <CodeSnippet terminal>{'$ based init\n$ based add "Stripe secret (prod)"'}</CodeSnippet>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.55, margin: '10px 0 0' }}>
                Creates the vault and owner keypair, then seals the secret to the owner's key.
                The vault file holds ciphertext only.
              </p>
            </div>
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>2. Grant it to an identity</div>
              <CodeSnippet terminal>{'$ based grant STRIPE_SECRET_KEY ci-bot --max-ttl 600 --max-uses 5'}</CodeSnippet>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.55, margin: '10px 0 0' }}>
                Re-seals the secret to ci-bot's public key with constraints: expiry, max lease TTL, usage cap.
              </p>
            </div>
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>3. Run with leases, not .env</div>
              <CodeSnippet terminal>{'$ based run --agent ci-bot -- npm run deploy'}</CodeSnippet>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.55, margin: '10px 0 0' }}>
                Leases everything ci-bot holds, injects env vars, writes nothing to disk.
                Or lease over MCP with <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>keyring_lease</span>.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── MCP ── */}
      <div style={{ padding: '48px 0', borderBottom: '1px solid var(--border)' }}>
        <div className="container">
          <h2 style={{ marginBottom: 8 }}>MCP server</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 15, marginBottom: 20, maxWidth: 720 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>basedagents-keyring-mcp</span>{' '}
            gives Claude Code, Claude Desktop, Codex, and Cursor lease access under the agent's own identity.
          </p>
          <div style={{ marginBottom: 20 }}>
            {[
              ['keyring_list()', 'Credentials this agent holds grants for — labels and metadata only, never values.'],
              ['keyring_lease(ref, context?, ttl_seconds?)', 'Verifies the grant, signs an AccessEvent, returns the secret with TTL metadata and the access event ID.'],
              ['keyring_request(provider, scope?, note?)', 'Creates a pending grant request for the owner to approve.'],
            ].map(([tool, desc]) => (
              <div key={tool} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <code style={{
                  fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent)',
                  background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: 4,
                  border: '1px solid var(--border)', whiteSpace: 'nowrap',
                }}>
                  {tool}
                </code>
                <span style={{ color: 'var(--text-secondary)', fontSize: 14, flex: '1 1 300px' }}>{desc}</span>
              </div>
            ))}
          </div>
          <h3 style={{ fontSize: 14, color: 'var(--text-tertiary)', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            claude_desktop_config.json
          </h3>
          <CodeSnippet language="json">{mcpConfig}</CodeSnippet>
        </div>
      </div>

      {/* ── Honest revocation ── */}
      <div style={{ padding: '48px 0', borderBottom: '1px solid var(--border)' }}>
        <div className="container">
          <h2 style={{ marginBottom: 24 }}>Two revocations, never conflated</h2>
          <div className="keyring-two-col">
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, marginBottom: 8, color: '#22C55E' }}>Revoke grant — instant</div>
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>based revoke</span> blocks new
                leases immediately and deletes the identity's sealed copy from the vault file.
                Outstanding leases expire within their TTL — 15 minutes or less by default.
                The kill switch does this across every grant an identity holds.
              </p>
            </div>
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--status-pending)' }}>Burn key — v0.2 Provisioner</div>
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
                Revoking a grant does not rotate or delete the key at the provider — in v0.1 that step
                is manual. The v0.2 Provisioner mints, rotates, and burns keys at the provider itself,
                wiring the kill switch to real provider-side burns.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer CTA ── */}
      <div style={{ padding: '48px 0 16px' }}>
        <div className="container">
          <div style={{ ...cardStyle, textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Read the full design</div>
            <p style={{ color: 'var(--text-secondary)', fontSize: 15, marginBottom: 20 }}>
              The specification covers the object model, threat model, and revocation semantics in detail.
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <a href={SPEC_URL} target="_blank" rel="noopener noreferrer" className="btn btn-primary" style={{ textDecoration: 'none' }}>
                KEYRING_SPEC.md
              </a>
              <a href={README_URL} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ textDecoration: 'none' }}>
                Package README
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
