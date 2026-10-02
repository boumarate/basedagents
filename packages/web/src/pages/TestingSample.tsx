/**
 * /testing/sample — sample audit report (spec §4.2).
 *
 * MODE: `illustrative` — a deterministic, clearly-labeled example of the
 * report FORMAT. It is not a real test result, names no real customer, and
 * shows no real success percentages. The `real` mode ships only through the
 * operator-approved export pipeline (see the runbook); a private report is
 * never rendered from a public route.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useRouteMeta } from '../hooks/useRouteMeta';
import { CONSOLE_URL } from '../content/positioning';

const S: Record<string, React.CSSProperties> = {
  h2: { fontSize: 21, fontWeight: 700, color: 'var(--text-primary)', margin: '36px 0 10px' },
  p: { fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 10px' },
  td: { border: '1px solid var(--border)', padding: '8px 12px', fontSize: 14, color: 'var(--text-secondary)', textAlign: 'left' as const },
  th: { border: '1px solid var(--border)', padding: '8px 12px', fontSize: 13.5, color: 'var(--text-primary)', textAlign: 'left' as const, background: 'var(--bg-secondary)' },
  card: { border: '1px solid var(--border)', borderRadius: 12, padding: '18px 22px', margin: '12px 0', background: 'var(--bg-secondary)' },
};

// Deterministic illustrative fixture — visibly labeled, never presented as
// completed customer work (spec §4.2).
const MATRIX = [
  { run: 'B0 (internal baseline)', env: 'internal · internal', result: 'completed', failure: '—', envSeen: 'n/a (internal)' },
  { run: 'E1', env: 'example-cli · mcp', result: 'completed', failure: '—', envSeen: 'demonstrated' },
  { run: 'E2', env: 'example-agent · http', result: 'product failure', failure: 'tool discovery', envSeen: 'demonstrated' },
  { run: 'E3', env: 'example-runner · http', result: 'completed', failure: '—', envSeen: 'demonstrated' },
];

export default function TestingSample(): React.ReactElement {
  useRouteMeta('/testing/sample');
  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 20px' }}>
      <div role="note" style={{
        border: '1px dashed var(--accent)', borderRadius: 10, padding: '10px 16px', margin: '0 0 24px',
        color: 'var(--text-primary)', fontWeight: 600, fontSize: 14.5,
      }}>
        Illustrative sample — not an actual test result. Product, environments and findings below are
        invented to show the report format. Real reports are private to the buyer.
      </div>

      <h1 style={{ fontSize: 30, fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 8px' }}>
        Agent Compatibility Audit — sample report
      </h1>
      <p style={{ ...S.p, fontSize: 13.5, color: 'var(--text-tertiary)' }}>
        Report v1 · scope hash <code>sha256:illustrative…</code> · workflow “create a sandbox record via the public API and read it back” ·
        release <code>example-2026-09</code> · observed 2026-09-XX
      </p>

      <h2 style={S.h2}>Executive summary</h2>
      <p style={S.p}>
        2 of 3 scoped external executions completed the workflow; 1 found a reproducible product failure at
        tool discovery. The internal baseline completed the workflow (internal — not an independent operator
        result). 1 finding (1 blocking), ordered by workflow impact below.
      </p>

      <h2 style={S.h2}>Coverage</h2>
      <ul style={{ paddingLeft: 20 }}>
        <li style={S.p as React.CSSProperties}>3 valid reviewed external runs of 3 planned</li>
        <li style={S.p as React.CSSProperties}>3 distinct environments observed · 2 reviewed operator groups</li>
      </ul>

      <h2 style={S.h2}>Execution matrix</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>
          <th style={S.th}>Run</th><th style={S.th}>Environment</th><th style={S.th}>Result</th>
          <th style={S.th}>First failure</th><th style={S.th}>Environment evidence</th>
        </tr></thead>
        <tbody>
          {MATRIX.map((r) => (
            <tr key={r.run}>
              <td style={S.td}>{r.run}</td><td style={S.td}>{r.env}</td>
              <td style={S.td}>{r.result === 'product failure' ? '✗ product failure' : '✓ ' + r.result}</td>
              <td style={S.td}>{r.failure}</td><td style={S.td}>{r.envSeen}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={S.h2}>Baseline comparison</h2>
      <p style={S.p}>
        The internal baseline completed the workflow, so finding F1 below was observed in external
        environments only — the kind of gap a single in-house test misses.
      </p>

      <h2 style={S.h2}>Findings</h2>
      <div style={S.card}>
        <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>F1 · BLOCKING · tool schema · observed</div>
        <p style={{ ...S.p, marginTop: 6 }}>
          tool discovery: the machine-readable endpoint listing omits the record-read operation, so the agent
          in E2 could not proceed past discovery even though the endpoint itself works when called directly.
        </p>
        <p style={{ ...S.p, fontSize: 13.5 }}>
          Affected runs: E2 · evidence: ev_1, ev_2 · vs baseline: external only · retest: available
        </p>
        <p style={{ ...S.p, fontSize: 13.5 }}>
          <strong>Reproduction:</strong> 1. read the public quickstart → 2. list available operations via the
          discovery endpoint → 3. observe the missing read operation.
        </p>
        <p style={{ ...S.p, fontSize: 13.5 }}>
          <strong>Suggested change</strong> (recommendation, distinct from the observation): include the read
          operation in the discovery document and add one worked read example to the quickstart.
        </p>
      </div>

      <h2 style={S.h2}>Limitations</h2>
      <ul style={{ paddingLeft: 20 }}>
        <li style={S.p as React.CSSProperties}>Scope covers exactly one workflow against a frozen scope; this is not a security audit, certification, or a universal compatibility score.</li>
        <li style={S.p as React.CSSProperties}>3 reviewed external executions cannot establish market-wide success rates.</li>
      </ul>

      <h2 style={S.h2}>Retest entitlement</h2>
      <p style={S.p}>1 included targeted retest, 0 used — request within 14 days of publication.</p>

      <h2 style={S.h2}>Evidence index</h2>
      <p style={{ ...S.p, fontSize: 13.5 }}>
        ev_1 (run E2, redacted tool output) sha256 <code>3fb2…</code> · ev_2 (run E2, redacted http exchange) sha256 <code>a4c9…</code>
      </p>

      <div style={{ ...S.card, textAlign: 'center', marginTop: 40 }}>
        <p style={{ ...S.p, fontWeight: 600, color: 'var(--text-primary)' }}>Want this for your own product’s key workflow?</p>
        <a href={`${CONSOLE_URL}/testing/request`} style={{ display: 'inline-block', padding: '12px 22px', borderRadius: 10, background: 'var(--accent)', color: '#fff', fontWeight: 600, textDecoration: 'none' }}>
          Request a scoped agent compatibility audit
        </a>
        <p style={{ ...S.p, fontSize: 13, marginTop: 8, color: 'var(--text-tertiary)' }}>
          Coverage is confirmed and the exact scope approved before any payment. <Link to="/testing" style={{ color: 'var(--accent)' }}>Back to Agent testing</Link>
        </p>
      </div>
    </div>
  );
}
