/**
 * Minimum bounty (decision D3, 2026-09-29): a task may be free, but a task
 * WITH a bounty must carry at least a minimum. Agent posters (a2a) and console
 * posters (human) have separate floors, both 0.10 USDC by default. The plan's
 * 1.00 / 5.00 would refuse the $0.10 micro-tasks the board already carries.
 * MIN_BOUNTY_ATOMIC_A2A / MIN_BOUNTY_ATOMIC_HUMAN override the floors per
 * deployment (atomic units, 6 decimals); the service descriptor advertises the
 * defaults, the 400 below and /.well-known/x402 the live values.
 *
 * Checked when a task is posted, on both creation routes and before any
 * escrow challenge. Re-funding an existing task (…/fund) is not: its amount
 * was fixed when it was posted.
 */
import { intFromEnv } from './governance.js';
import { atomicToDisplay } from '../payments/x402.js';

export type BountyPoster = 'a2a' | 'human';

export const MIN_BOUNTY_ATOMIC_DEFAULT: Readonly<Record<BountyPoster, number>> = { a2a: 100_000, human: 100_000 };

const ENV_KEY: Readonly<Record<BountyPoster, string>> = { a2a: 'MIN_BOUNTY_ATOMIC_A2A', human: 'MIN_BOUNTY_ATOMIC_HUMAN' };

/** The live floor for a poster, in atomic USDC (1 to 1,000 USDC; anything else falls back to the default). */
export function minBountyAtomic(env: unknown, poster: BountyPoster): number {
  return intFromEnv(env, ENV_KEY[poster], MIN_BOUNTY_ATOMIC_DEFAULT[poster], 1, 1_000_000_000);
}

export interface BountyMinimumRefusal {
  error: 'bounty_below_minimum';
  message: string;
  /** The floor in atomic USDC, e.g. "100000". */
  minimum_amount: string;
  /** The floor in USDC, e.g. "0.10". */
  minimum_usdc: string;
}

/**
 * The 400 body when `amount` (atomic digits, already checked by BountySchema)
 * is under the poster's floor; null when the bounty is allowed.
 */
export function bountyMinimumRefusal(env: unknown, poster: BountyPoster, amount: string): BountyMinimumRefusal | null {
  const min = minBountyAtomic(env, poster);
  if (BigInt(amount) >= BigInt(min)) return null;
  const usdc = atomicToDisplay(String(min));
  return {
    error: 'bounty_below_minimum',
    message: `A bounty must be at least ${usdc} USDC. Raise it, or leave the bounty out to post a free task.`,
    minimum_amount: String(min),
    minimum_usdc: usdc,
  };
}
