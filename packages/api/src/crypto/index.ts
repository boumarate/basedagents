/**
 * Cryptographic utilities for BasedAgents.
 *
 * - Ed25519 signature verification
 * - Proof-of-Work validation
 * - Hash chain computation
 * - Base58 encoding/decoding
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { verifyAsync } from '@noble/ed25519';

export { sha256, bytesToHex, hexToBytes };

// ─── Base58 (Bitcoin alphabet) ───

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode bytes to base58 string.
 */
export function base58Encode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeros = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    zeros++;
  }

  // Convert to big integer
  let num = 0n;
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }

  // Convert to base58
  const chars: string[] = [];
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    chars.unshift(BASE58_ALPHABET[rem]);
  }

  // Add leading '1's for leading zero bytes
  for (let i = 0; i < zeros; i++) {
    chars.unshift('1');
  }

  return chars.join('');
}

/**
 * Decode base58 string to bytes.
 */
export function base58Decode(str: string): Uint8Array {
  // Count leading '1's
  let zeros = 0;
  for (const c of str) {
    if (c !== '1') break;
    zeros++;
  }

  // Convert from base58
  let num = 0n;
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert to bytes
  const hex = num === 0n ? '' : num.toString(16).padStart(2, '0');
  // Ensure even length
  const paddedHex = hex.length % 2 ? '0' + hex : hex;
  const byteArray = new Uint8Array(zeros + paddedHex.length / 2);

  // Fill leading zeros
  for (let i = 0; i < zeros; i++) {
    byteArray[i] = 0;
  }

  // Fill remaining bytes
  for (let i = 0; i < paddedHex.length; i += 2) {
    byteArray[zeros + i / 2] = parseInt(paddedHex.substring(i, i + 2), 16);
  }

  return byteArray;
}

// ─── Proof of Work ───

/** Default PoW difficulty (number of leading zero bits required).
 *  22 bits: ~4M hashes on average. Solvable in ~1-3s on modern hardware.
 *  20 bits was solvable in milliseconds — too cheap for anti-spam.
 */
export const DEFAULT_DIFFICULTY = 22;

/**
 * Count leading zero bits in a byte array.
 */
function countLeadingZeroBits(hash: Uint8Array): number {
  let count = 0;
  for (const byte of hash) {
    if (byte === 0) {
      count += 8;
    } else {
      // Count leading zeros in this byte
      for (let bit = 7; bit >= 0; bit--) {
        if ((byte >> bit) & 1) return count;
        count++;
      }
    }
  }
  return count;
}

/**
 * Verify that a proof-of-work nonce satisfies the difficulty requirement.
 * sha256(public_key || challenge || nonce) must have at least `difficulty` leading zero bits.
 * The challenge binds the PoW to a specific registration attempt (L3).
 */
export function verifyProofOfWork(
  publicKey: Uint8Array,
  nonce: string,
  difficulty: number,
  challenge?: string
): boolean {
  const nonceBytes = hexToBytes(nonce);
  const challengeBytes = challenge ? new TextEncoder().encode(challenge) : new Uint8Array(0);
  const data = new Uint8Array(publicKey.length + challengeBytes.length + nonceBytes.length);
  data.set(publicKey);
  data.set(challengeBytes, publicKey.length);
  data.set(nonceBytes, publicKey.length + challengeBytes.length);
  const hash = sha256(data);
  return countLeadingZeroBits(hash) >= difficulty;
}

// ─── Ed25519 Signature Verification ───

/**
 * Verify an Ed25519 signature.
 */
export async function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  try {
    return await verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ─── Hash Chain ───

/**
 * The genesis hash (all zeros) for the first chain entry.
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Registry checkpoints: the points the public verification contract starts
 * from. The record below a checkpoint is never rewritten — a ledger whose
 * operator edits history has no verifiability story at all — the contract
 * is made explicit instead.
 *
 * The one seam, found by the independent agent Agent18 (2026-09-30) and
 * confirmed against the raw rows: sequences 1–2 predate the production
 * epoch. A pre-launch reset (March 2026) removed the rows they were minted
 * against, so seq 1's previous_hash (2599d769…) and seq 2's previous_hash
 * (7e45149e…) reference entries that no longer exist, and seq 1 does not
 * chain from GENESIS_HASH. Both entries' OWN entry_hashes still recompute
 * honestly from their public fields (v1 format), as does every entry after
 * them (v1 through the earliest entries, v2 after the length-prefix
 * migration), and every link from seq 3 to the head verifies.
 *
 * Verifiers therefore: recompute entry hashes everywhere, and hash-link
 * from the head DOWN TO the highest checkpoint; links whose child sequence
 * is at or below a checkpoint are attested by the registry via this
 * constant (served on /v1/chain and /v1/chain/latest) instead of linkage.
 * scripts/check-chain-integrity.mjs enforces exactly this on a schedule.
 */
export interface ChainCheckpoint {
  sequence: number;
  entry_hash: string;
  reason: string;
  documented_at: string;
}

export const CHAIN_CHECKPOINTS: ChainCheckpoint[] = [
  {
    sequence: 2,
    entry_hash: '1900d053ff9cd2a0dcd0402b22fd745d866505a52b5599ed4caea2291fb1880d',
    reason:
      'Dev-era reset seam: entries 1–2 were minted against pre-launch rows removed in a March 2026 reset, so their previous_hash values reference entries that no longer exist. Their contents still recompute from public fields; linkage verification starts here. Found by Agent18.',
    documented_at: '2026-10-01',
  },
];

/**
 * Compute a hash chain entry.
 *
 * NOTE: Breaking change from v1 format (raw concatenation without length delimiters).
 * v1: sha256(previousHash || publicKey || nonce || profileHash || timestamp)
 * v2: sha256(len(p0) || p0 || len(p1) || p1 || ...) — length-prefixed, big-endian uint32
 *
 * Chain verification must account for both formats during migration.
 * This is acceptable since the chain is small (height ~5).
 */
export function computeChainHash(
  previousHash: string,
  publicKey: Uint8Array,
  nonce: string,
  profileHash: string,
  timestamp: string
): string {
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(previousHash),
    publicKey,
    encoder.encode(nonce),
    encoder.encode(profileHash),
    encoder.encode(timestamp),
  ];
  // Length-delimited encoding: each part prefixed with 4-byte big-endian length.
  // Prevents collision when adjacent parts have ambiguous boundaries
  // (e.g. previousHash="ab"+nonce="cd" vs previousHash="abc"+nonce="d").
  const totalLength = parts.reduce((sum, p) => sum + 4 + p.length, 0);
  const data = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    // Write 4-byte big-endian length prefix
    const view = new DataView(data.buffer, offset, 4);
    view.setUint32(0, part.length, false); // big-endian
    offset += 4;
    data.set(part, offset);
    offset += part.length;
  }
  return bytesToHex(sha256(data));
}

/**
 * Canonical JSON serialization (RFC 8785 subset).
 * Recursively sorts object keys. Handles nested objects and arrays.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJsonStringify((value as Record<string, unknown>)[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Hash a profile object for chain inclusion.
 * Uses canonical JSON (RFC 8785 subset) for deterministic, recursive key sorting.
 */
export function hashProfile(profile: Record<string, unknown>): string {
  const json = canonicalJsonStringify(profile);
  return bytesToHex(sha256(new TextEncoder().encode(json)));
}

/**
 * Generate an agent ID from a public key.
 * Format: ag_<base58(public_key)>
 */
export function publicKeyToAgentId(publicKey: Uint8Array): string {
  return `ag_${base58Encode(publicKey)}`;
}

/**
 * Extract the base58-encoded public key from an agent ID.
 */
export function agentIdToPublicKey(agentId: string): Uint8Array {
  if (!agentId.startsWith('ag_')) {
    throw new Error('Invalid agent ID format');
  }
  return base58Decode(agentId.slice(3));
}
