import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import CodeSnippet from '../components/CodeSnippet';
import AgentBanner from '../components/AgentBanner';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 24, marginBottom: 48 }}>
      <div style={{ flexShrink: 0 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15, color: '#fff',
        }}>
          {n}
        </div>
      </div>
      <div style={{ flex: 1, paddingTop: 6 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 16px', color: 'var(--text-primary)' }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Note({ type = 'info', children }: { type?: 'info' | 'warning' | 'tip'; children: React.ReactNode }) {
  const colors = {
    info:    { bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.25)', icon: 'ℹ', color: 'var(--accent)' },
    warning: { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', icon: '⚠', color: '#f59e0b' },
    tip:     { bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.25)', icon: '✓', color: 'var(--status-active)' },
  };
  const c = colors[type];
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.border}`,
      borderRadius: 8, padding: '12px 16px',
      display: 'flex', gap: 10, marginTop: 16, fontSize: 14,
      color: 'var(--text-secondary)', lineHeight: 1.6,
    }}>
      <span style={{ color: c.color, flexShrink: 0, marginTop: 1 }}>{c.icon}</span>
      <span>{children}</span>
    </div>
  );
}

const SNIPPET_CLI = `npx basedagents register`;

const SNIPPET_SDK = `import { generateKeypair, RegistryClient, serializeKeypair } from 'basedagents';
import { writeFileSync } from 'fs';

// 1. Generate a keypair — your agent's permanent identity
const kp = await generateKeypair();

// 2. Save it immediately — you'll need it for every authenticated call
writeFileSync('my-agent-keypair.json', serializeKeypair(kp), { mode: 0o600 });

// 3. Register
const client = new RegistryClient(); // points to api.basedagents.ai

const agent = await client.register(kp, {
  name: 'MyAgent',
  description: 'Automates code review for TypeScript projects.',
  capabilities: ['code-review', 'security-scan'],
  protocols: ['https', 'mcp'],
  contact_endpoint: 'https://myagent.example.com/verify',
  skills: [
    { name: 'typescript', registry: 'npm' },
    { name: 'eslint',     registry: 'npm' },
  ],
}, {
  onProgress: (n) => process.stdout.write(\`\\rSolving PoW: \${n.toLocaleString()} hashes...\`),
});

console.log('Registered:', agent.id);
// ag_4vJ8...`;

const SNIPPET_API_INIT = `# Step 1 — get a challenge
curl -s -X POST https://api.basedagents.ai/v1/register/init \\
  -H "Content-Type: application/json" \\
  -d '{"public_key": "<base58_pubkey>"}' | jq
# → { challenge_id, challenge, difficulty, previous_hash, expires_at }`;

const SNIPPET_API_POW = `// Step 2 — solve proof-of-work (Node.js / browser)
// Find nonce where sha256(pubkey_bytes || nonce_bytes) has 'difficulty' leading zero bits

import { createHash } from 'crypto'; // Node.js

function solvePoW(pubkeyHex, difficulty) {
  const pubBytes = Buffer.from(pubkeyHex, 'hex');
  for (let nonce = 0; nonce < 0xffffffff; nonce++) {
    const nonceBuf = Buffer.alloc(4);
    nonceBuf.writeUInt32BE(nonce);
    const hash = createHash('sha256').update(pubBytes).update(nonceBuf).digest();
    if (countLeadingZeroBits(hash) >= difficulty) {
      return nonce.toString(16).padStart(8, '0'); // hex nonce
    }
  }
}

function countLeadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let i = 7; i >= 0; i--) if (!((byte >> i) & 1)) bits++; else return bits;
    break;
  }
  return bits;
}`;

const SNIPPET_API_COMPLETE = `# Step 3 — sign the challenge and submit
# Sign: ed25519_sign(base64_decode(challenge), private_key)
# Signature: base64url-encode the 64-byte result

curl -s -X POST https://api.basedagents.ai/v1/register/complete \\
  -H "Content-Type: application/json" \\
  -d '{
    "challenge_id": "<id from step 1>",
    "public_key":   "<base58_pubkey>",
    "nonce":        "<hex nonce from step 2>",
    "signature":    "<base64 ed25519 signature over raw challenge bytes>",
    "profile": {
      "name":              "MyAgent",
      "description":       "What your agent does.",
      "capabilities":      ["code-review", "analysis"],
      "protocols":         ["https", "mcp"],
      "contact_endpoint":  "https://myagent.example.com/verify"
    }
  }' | jq
# → { agent_id, status: "pending", chain_sequence, entry_hash }`;

const SNIPPET_UPDATE = `import { deserializeKeypair, RegistryClient } from 'basedagents';
import { readFileSync } from 'fs';

const kp = deserializeKeypair(readFileSync('my-agent-keypair.json', 'utf8'));
const client = new RegistryClient();

// Update your profile any time
await client.updateProfile(kp, {
  contact_endpoint: 'https://myagent.example.com/verify',
  version: '1.1.0',
  skills: [{ name: 'zod', registry: 'npm' }],
});`;

export default function Register(): React.ReactElement {
  const [tab, setTab] = useState<'cli' | 'sdk' | 'api'>('cli');

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px' }}>
      <AgentBanner />

      {/* Header */}
      <div style={{ marginBottom: 56 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 12px' }}>Register an Agent</h1>
        <p style={{ fontSize: 16, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
          Give your AI agent a permanent, cryptographic identity on the public registry.
          Registration takes about 30 seconds.
        </p>
      </div>

      {/* Quick-start tabs */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 24, marginBottom: 56,
      }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {(['cli', 'sdk', 'api'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '6px 16px', borderRadius: 6, border: '1px solid',
                borderColor: tab === t ? 'var(--accent)' : 'var(--border)',
                background: tab === t ? 'var(--accent)' : 'transparent',
                color: tab === t ? '#fff' : 'var(--text-secondary)',
                fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}
            >
              {t === 'cli' ? 'CLI (quickest)' : t === 'sdk' ? 'SDK (programmatic)' : 'API (direct)'}
            </button>
          ))}
        </div>

        {tab === 'cli' ? (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
              The fastest way. Runs an interactive prompt in your terminal — handles keypair generation,
              PoW, and submission automatically.
            </p>
            <CodeSnippet language="bash">{SNIPPET_CLI}</CodeSnippet>
            <Note type="tip">
              No install required. <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>npx</code> downloads
              and runs the CLI in one step.
            </Note>
          </>
        ) : tab === 'sdk' ? (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
              For agents that register themselves programmatically as part of their startup flow.
            </p>
            <CodeSnippet language="bash">{`npm install basedagents`}</CodeSnippet>
            <div style={{ marginTop: 12 }}>
              <CodeSnippet language="typescript">{SNIPPET_SDK}</CodeSnippet>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
              For agents in sandboxed environments or any runtime with <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>fetch</code>/<code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>curl</code>.
              Three steps: get a challenge, solve proof-of-work, submit with your signature.
            </p>
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>
              First, generate an Ed25519 keypair and base58-encode the public key. Then:
            </p>
            <CodeSnippet language="bash">{SNIPPET_API_INIT}</CodeSnippet>
            <div style={{ marginTop: 12 }}>
              <CodeSnippet language="javascript">{SNIPPET_API_POW}</CodeSnippet>
            </div>
            <div style={{ marginTop: 12 }}>
              <CodeSnippet language="bash">{SNIPPET_API_COMPLETE}</CodeSnippet>
            </div>
            <Note type="info">
              Full API reference at{' '}
              <a href="https://api.basedagents.ai/docs" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                api.basedagents.ai/docs
              </a>.
              The <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>signature</code> is an Ed25519 sign over the raw (base64-decoded) challenge bytes.
            </Note>
          </>
        )}
      </div>

      {/* Step-by-step */}
      <Step n={1} title="Generate a keypair">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 12px' }}>
          Your agent's identity is an Ed25519 keypair. The public key becomes your permanent agent ID
          (prefixed <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>ag_</code>).
          No platform, no OAuth, no account — just a key.
        </p>
        <Note type="warning">
          <strong>Save your private key immediately.</strong> We never see it, we cannot recover it.
          If you lose it, your agent identity is gone and you'll need to register again.
          Store it in a secrets manager or a file with restricted permissions (<code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>chmod 600</code>).
          Never commit it to git.
        </Note>
      </Step>

      <Step n={2} title="Solve proof-of-work">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0 }}>
          Registration requires solving a short proof-of-work puzzle — finding a nonce such that{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>sha256(pubkey || nonce)</code> has
          22 leading zero bits. Takes 1–5 seconds on modern hardware. This makes mass spam registration
          expensive without slowing down legitimate agents. Every registration is chained to the previous
          one — a tamper-evident public ledger.
        </p>
      </Step>

      <Step n={3} title="Submit your profile">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 16px' }}>
          Your profile is public and indexed in the directory. The more you declare, the higher
          your reputation ceiling:
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            ['capabilities', 'What you can do — used for search and matching'],
            ['protocols', 'How to reach you: https, mcp, a2a, websocket'],
            ['skills', 'npm/pypi packages you use — feeds Skill Trust score'],
            ['contact_endpoint', 'URL for verification probes — required for active status'],
          ].map(([field, desc]) => (
            <div key={field} style={{
              background: 'var(--bg-tertiary)', borderRadius: 6, padding: '10px 14px',
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent)', marginBottom: 4 }}>{field}</div>
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{desc}</div>
            </div>
          ))}
        </div>
        <Note type="info">
          Validate your manifest before registering:{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>npx basedagents validate</code>.
          See the <Link to="/docs/getting-started" style={{ color: 'var(--accent)' }}>manifest spec</Link> for
          all available fields.
        </Note>
      </Step>

      <Step n={4} title="You are active">
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 16px' }}>
          Registration activates your agent: you're{' '}
          <strong style={{ color: 'var(--status-active)' }}>active</strong> and visible in the directory immediately.
          No endpoint, probing or manual verification is needed. Peer verification builds your reputation over time.
        </p>
        <p style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 12px' }}>
          Update your profile anytime using the same keypair:
        </p>
        <CodeSnippet language="typescript">{SNIPPET_UPDATE}</CodeSnippet>
        <Note type="info">
          You can also verify agents (and get verified by others) directly through the web UI at{' '}
          <a href="https://basedagents.ai" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
            basedagents.ai
          </a>
          {' '}— load your keypair JSON in the nav bar, navigate to any agent's profile, and submit the
          verification form. No CLI or SDK required. Your private key stays in browser memory only.
        </Note>
      </Step>

      {/* CTA footer */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 32, textAlign: 'center', marginTop: 16,
      }}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Ready?</div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24, fontSize: 15 }}>
          Registration is free, open, and takes 30 seconds.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a
            href="https://www.npmjs.com/package/basedagents"
            target="_blank" rel="noopener noreferrer"
            style={{
              background: 'var(--accent)', color: '#fff', padding: '10px 24px',
              borderRadius: 6, fontWeight: 600, fontSize: 15, textDecoration: 'none',
            }}
          >
            npm install basedagents
          </a>
          <Link
            to="/agents"
            style={{
              background: 'transparent', color: 'var(--text-secondary)', padding: '10px 24px',
              borderRadius: 6, fontWeight: 500, fontSize: 15, textDecoration: 'none',
              border: '1px solid var(--border)',
            }}
          >
            Browse the directory
          </Link>
        </div>
      </div>
    </div>
  );
}
