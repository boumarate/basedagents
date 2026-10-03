import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * "Total paid to task runners" — the all-time settled payout figure that leads
 * the task board (see Task_Board_Payout_Spec.md).
 *
 * Source of truth: `GET /v1/tasks/settled` → `stats.usdc_paid_all_time` /
 * `tasks_paid_all_time`, computed server-side over EVERY settled task
 * (settled, mainnet, not refunded, valid tx — the same population behind the
 * "Recently paid" section and /v1/status). This hook used to re-derive the
 * total client-side from the first page of `GET /v1/tasks?status=verified`,
 * which silently undercounts once more than `limit` tasks are verified: older
 * settled tasks fall off the page and their payouts vanish from the figure.
 *
 * If the API cannot be reached we surface `failed` ("unavailable") rather
 * than showing 0 — a genuine 0.00 is reserved for a verified-empty history.
 */

export type PaidTotal =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; atomic: bigint; display: string; count: number; token: string; snapshot: string };

/** Format USDC atomic base units (6 decimals) as an exact 2-decimal string with grouping. */
export function formatUsdcAtomic(atomic: bigint): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  let whole = a / 1_000_000n;
  // Round the remaining base units to 2 decimals.
  let cents = ((a % 1_000_000n) * 100n + 500_000n) / 1_000_000n;
  if (cents === 100n) {
    whole += 1n;
    cents = 0n;
  }
  const wStr = whole.toLocaleString('en-US');
  const cStr = cents.toString().padStart(2, '0');
  return `${neg ? '-' : ''}${wStr}.${cStr}`;
}

/** Parse a server USDC display string ("32.90", "1,234.5") into atomic base units (6 decimals). */
export function usdcDisplayToAtomic(display: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(display.replace(/,/g, ''));
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(6, '0');
  try {
    return BigInt(m[1]) * 1_000_000n + BigInt(frac);
  } catch {
    return null;
  }
}

export function usePaidTotal(): PaidTotal {
  const [total, setTotal] = useState<PaidTotal>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    api
      .getSettledTasks({ limit: 1 })
      .then(({ stats }) => {
        if (cancelled) return;
        const atomic = usdcDisplayToAtomic(stats.usdc_paid_all_time);
        if (atomic === null) {
          setTotal({ kind: 'failed' });
          return;
        }
        setTotal({
          kind: 'ready',
          atomic,
          display: formatUsdcAtomic(atomic),
          count: stats.tasks_paid_all_time,
          token: 'USDC',
          snapshot: stats.computed_at,
        });
      })
      .catch(() => {
        if (!cancelled) setTotal({ kind: 'failed' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return total;
}
