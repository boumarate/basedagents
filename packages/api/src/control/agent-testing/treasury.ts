/**
 * Agent Testing — the platform's SEPARATE worker-payment treasury (spec §10).
 *
 * PROPRIETARY control-plane code — see ../LICENSE and LICENSING.md.
 *
 * Worker bounties are funded from a dedicated treasury wallet
 * (TESTING_TREASURY_PRIVATE_KEY), never from customer card money, customer
 * credentials, or the registry's custodial ESCROW wallet balance: the escrow
 * wallet holds worker liabilities in custody; this treasury is the platform's
 * own operating money that DEPOSITS into escrow through the exact same
 * EIP-3009 handshake a human buyer's browser wallet performs. Missing key →
 * publication fails with a clear reason; nothing fakes success.
 */
import {
  houseWalletFromPrivateKey,
  parseHousePrivateKey,
  type HouseWallet,
} from '../../payments/house-wallet.js';
import { encodeB64Json, type PaymentRequirementsV2 } from '../../payments/x402.js';
import { testingEnv } from './catalog.js';

export interface TreasurySigner {
  address: `0x${string}`;
  /** The PAYMENT-SIGNATURE header for an escrow deposit of exactly `requirements.amount`. */
  signDepositHeader(requirements: PaymentRequirementsV2, nowSec: number, nonce?: string): string;
}

let testOverride: TreasurySigner | null | undefined;
let memo: { raw: string; signer: TreasurySigner } | null = null;

function fromWallet(wallet: HouseWallet): TreasurySigner {
  return {
    address: wallet.address,
    signDepositHeader(requirements, nowSec, nonce) {
      return encodeB64Json(wallet.signTransfer(requirements, nowSec, nonce));
    },
  };
}

/** The treasury signer, or null when not configured (publication then fails closed). */
export function treasuryFor(env: unknown): TreasurySigner | null {
  if (testOverride !== undefined) return testOverride;
  const raw = testingEnv(env).TESTING_TREASURY_PRIVATE_KEY;
  if (!raw) return null;
  if (memo && memo.raw === raw) return memo.signer;
  try {
    const signer = fromWallet(houseWalletFromPrivateKey(parseHousePrivateKey(raw)));
    memo = { raw, signer };
    return signer;
  } catch (err) {
    console.error('[testing] treasury disabled:', (err as Error).message);
    return null;
  }
}

/** Test hook — `undefined` restores env-derived behaviour. */
export function setTestingTreasuryForTests(t: TreasurySigner | null | undefined): void {
  testOverride = t;
  memo = null;
}
