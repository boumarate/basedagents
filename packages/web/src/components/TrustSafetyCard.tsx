import React from 'react';
import type { ReputationBreakdown } from '../hooks/useReputation';
import type { Verification } from '../data/mockData';

interface TrustSafetyCardProps {
  rep: ReputationBreakdown;
  verifications: Verification[];
  /** Ratings posters gave this agent's deliveries (1-5, optional); the row is hidden when absent. */
  ratings?: { count: number; average: number | null };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      padding: '11px 0', borderBottom: '1px solid var(--border)', gap: 16,
    }}>
      <span style={{ fontSize: 14, color: 'var(--text-tertiary)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 14, color: 'var(--text-primary)', textAlign: 'right' }}>{children}</span>
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 12,
      background: ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
      border: `1px solid ${ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
      fontSize: 12, fontWeight: 500,
      color: ok ? 'var(--status-active)' : 'var(--status-suspended)',
    }}>
      <span style={{ fontSize: 9 }}>●</span>
      {label}
    </span>
  );
}

function CoherenceVerdict(score: number): { label: string; color: string; note: string } {
  if (score >= 0.85) return { label: 'High', color: 'var(--status-active)', note: 'Capabilities closely match observed behavior' };
  if (score >= 0.65) return { label: 'Moderate', color: '#f59e0b', note: 'Minor gaps between declared and observed behavior' };
  if (score >= 0.4)  return { label: 'Low', color: '#f97316', note: 'Notable discrepancies between declared and observed behavior' };
  return { label: 'Poor', color: 'var(--status-suspended)', note: 'Significant mismatch between declared and observed behavior' };
}

function PassRateVerdict(rate: number): { label: string; color: string } {
  if (rate >= 0.9) return { label: 'Excellent', color: 'var(--status-active)' };
  if (rate >= 0.7) return { label: 'Good', color: 'var(--status-active)' };
  if (rate >= 0.5) return { label: 'Fair', color: '#f59e0b' };
  return { label: 'Poor', color: 'var(--status-suspended)' };
}

export default function TrustSafetyCard({ rep, verifications, ratings }: TrustSafetyCardProps): React.ReactElement {
  const safetyOk = rep.safety_flags === 0;
  const penaltyOk = (rep.penalty ?? 0) === 0;
  const coherenceOk = (rep.breakdown.coherence ?? 0) >= 0.65;
  const passRateOk = (rep.breakdown.pass_rate ?? 0) >= 0.7;
  const hasVerifications = rep.verifications_received > 0;

  const overallOk = safetyOk && penaltyOk && coherenceOk && passRateOk;
  const noData = !hasVerifications;

  // Task record (Tasks P0): time-decayed counts from the reputation response;
  // absent on an older API, so both default to 0 and the row reads "—".
  const tasksAccepted = rep.tasks_accepted ?? 0;
  const tasksFailed = rep.tasks_failed ?? 0;
  const hasTasks = tasksAccepted + tasksFailed > 0;

  const coherence = CoherenceVerdict(rep.breakdown.coherence ?? 0);
  const passRate = PassRateVerdict(rep.breakdown.pass_rate ?? 0);

  // Recent outcome streak
  const recent = verifications.slice(0, 5);
  const passCount = recent.filter(v => v.result === 'pass').length;
  const failCount = recent.filter(v => v.result === 'fail').length;
  const timeoutCount = recent.filter(v => v.result === 'timeout').length;

  const overallBg    = noData ? 'rgba(255,255,255,0.03)' : overallOk ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)';
  const overallBorder = noData ? 'var(--border)' : overallOk ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)';
  const overallDot   = noData ? 'var(--text-tertiary)' : overallOk ? 'var(--status-active)' : 'var(--status-suspended)';
  const overallLabel = noData ? 'No verifications yet' : overallOk ? 'No issues detected' : 'Issues detected';
  const overallSub   = noData
    ? 'Trust signals will appear once this agent has been peer-verified.'
    : overallOk
      ? 'Peer verifications found no behavioral or safety concerns.'
      : 'One or more trust signals are below threshold. Review details below.';

  return (
    <div style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, padding: 24, marginBottom: 32,
    }}>
      {/* Header */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14 }}>🛡</span> Trust &amp; Safety
      </h2>

      {/* Overall verdict banner */}
      <div style={{
        background: overallBg, border: `1px solid ${overallBorder}`,
        borderRadius: 8, padding: '14px 18px',
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20,
      }}>
        <span style={{ color: overallDot, fontSize: 16, flexShrink: 0 }}>●</span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{overallLabel}</div>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 2 }}>{overallSub}</div>
        </div>
      </div>

      {/* Signals */}
      <div style={{ borderTop: '1px solid var(--border)' }}>
        <Row label="Safety flags">
          {safetyOk
            ? <StatusPill ok label="None" />
            : <StatusPill ok={false} label={`${rep.safety_flags} flag${rep.safety_flags > 1 ? 's' : ''}`} />}
        </Row>

        <Row label="Capability coherence">
          {hasVerifications ? (
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
              <StatusPill ok={coherenceOk} label={coherence.label} />
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{coherence.note}</span>
            </span>
          ) : <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>—</span>}
        </Row>

        <Row label="Verification pass rate">
          {hasVerifications ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusPill ok={passRateOk} label={passRate.label} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-tertiary)' }}>
                {Math.round((rep.breakdown.pass_rate ?? 0) * 100)}%
              </span>
            </span>
          ) : <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>—</span>}
        </Row>

        <Row label="Penalty score">
          {penaltyOk
            ? <StatusPill ok label="None" />
            : (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StatusPill ok={false} label="Active" />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#ef4444' }}>
                  -{Math.round((rep.penalty ?? 0) * 100)}%
                </span>
              </span>
            )}
        </Row>

        <Row label="Tasks">
          {hasTasks ? (
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
              <StatusPill ok={tasksFailed === 0} label={`${tasksAccepted} accepted · ${tasksFailed} failed`} />
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                Deliveries accepted by the buyer vs disputed and cancelled (recent work counts more)
              </span>
            </span>
          ) : <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>—</span>}
        </Row>

        {ratings && (
          <Row label="Ratings">
            {ratings.count > 0 && ratings.average !== null ? (
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                <StatusPill ok={ratings.average >= 3} label={`★ ${ratings.average.toFixed(1)} · ${ratings.count} rating${ratings.count === 1 ? '' : 's'}`} />
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  Optional 1–5 ratings from buyers when they accept or dispute a delivery
                </span>
              </span>
            ) : <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>—</span>}
          </Row>
        )}

        {hasVerifications && recent.length > 0 && (
          <Row label="Recent outcomes">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {recent.map((v, i) => (
                <span
                  key={i}
                  title={`${v.result} · coherence ${v.coherenceScore.toFixed(2)}`}
                  style={{
                    width: 22, height: 22, borderRadius: 4,
                    background: v.result === 'pass'
                      ? 'rgba(34,197,94,0.15)'
                      : v.result === 'fail'
                        ? 'rgba(239,68,68,0.15)'
                        : 'rgba(245,158,11,0.15)',
                    border: `1px solid ${
                      v.result === 'pass' ? 'rgba(34,197,94,0.3)'
                      : v.result === 'fail' ? 'rgba(239,68,68,0.3)'
                      : 'rgba(245,158,11,0.3)'
                    }`,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10,
                    color: v.result === 'pass' ? 'var(--status-active)'
                      : v.result === 'fail' ? 'var(--status-suspended)' : '#f59e0b',
                  }}
                >
                  {v.result === 'pass' ? '✓' : v.result === 'fail' ? '✗' : '~'}
                </span>
              ))}
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 4 }}>
                {passCount}p · {failCount}f · {timeoutCount}t
              </span>
            </span>
          </Row>
        )}

        <div style={{ paddingTop: 11, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
            Based on {rep.verifications_received} peer verification{rep.verifications_received !== 1 ? 's' : ''}
            {rep.verifications_received > 0 && (
              <> · confidence {Math.round((rep.confidence ?? 0) * 100)}%</>
            )}
          </span>
          <a
            href="#verifications"
            style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}
            onClick={e => {
              e.preventDefault();
              document.getElementById('verifications')?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            View verifications ↓
          </a>
        </div>
      </div>
    </div>
  );
}
