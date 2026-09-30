/**
 * Payout wallet proof of control (decision D8). Setting or changing an agent's
 * payout wallet needs a signature FROM that wallet over a bind message. This
 * builds the exact message the registry expects (the API's wallets/bind.ts has
 * the same format and rejects anything else) and signs it with a local
 * secp256k1 key (EIP-191 personal_sign). The key is used in memory only; it is
 * never sent anywhere or printed.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export const WALLET_BIND_TITLE = 'BasedAgents payout wallet';
export const WALLET_BIND_FOOTER = "Signing proves you control this wallet and lets BasedAgents pay this agent's bounties to it. It moves no funds.";
/** The registry accepts a bind message for this long after its `Issued` time. */
export const WALLET_BIND_MAX_AGE_MS = 15 * 60 * 1000;

export interface WalletBindFields {
  agentId: string;
  address: string;
  /** CAIP-2 EVM network, e.g. 'eip155:8453' (Base). */
  network: string;
  /** Default: now, to the second. */
  issuedAt?: Date | string;
  /** Default: 16 random hex characters. */
  nonce?: string;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The bind message to sign for `address` as `agentId`'s payout wallet on `network`. */
export function walletBindMessage(f: WalletBindFields): string {
  const issued = f.issuedAt instanceof Date || f.issuedAt === undefined
    ? (f.issuedAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    : f.issuedAt;
  const nonce = f.nonce ?? toHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
  return [
    WALLET_BIND_TITLE,
    `Agent: ${f.agentId}`,
    `Wallet: ${f.address.toLowerCase()}`,
    `Network: ${f.network}`,
    `Issued: ${issued}`,
    `Nonce: ${nonce}`,
    '',
    WALLET_BIND_FOOTER,
  ].join('\n');
}

function keyBytes(privateKeyHex: string): Uint8Array {
  const h = privateKeyHex.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('A wallet private key is 32 bytes of hex (64 characters, optional 0x)');
  return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
}

/** EIP-55 checksummed address of a secp256k1 private key. */
export function walletAddressFromPrivateKey(privateKeyHex: string): string {
  const pub = secp256k1.getPublicKey(keyBytes(privateKeyHex), false);
  const lower = toHex(keccak_256(pub.slice(1)).slice(12));
  const hash = toHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** The EIP-191 digest a wallet signs for `message` (personal_sign). */
function personalDigest(message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const all = new Uint8Array(prefix.length + bytes.length);
  all.set(prefix, 0);
  all.set(bytes, prefix.length);
  return keccak_256(all);
}

/**
 * The address (lowercase) that signed `message` with a 65-byte personal_sign
 * signature, or null (not a plain-key signature, e.g. a smart wallet's).
 */
export function recoverWalletBindSigner(message: string, signature: string): string | null {
  const hex = signature.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;
  let v = parseInt(hex.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const pub = secp256k1.Signature.fromCompact(hex.slice(0, 128)).addRecoveryBit(v).recoverPublicKey(personalDigest(message)).toRawBytes(false);
    return '0x' + toHex(keccak_256(pub.slice(1)).slice(12));
  } catch {
    return null;
  }
}

/** EIP-191 personal_sign of `message`: 0x-prefixed r ‖ s ‖ v (v = 27/28), the format wallets return. */
export function signWalletBindMessage(message: string, privateKeyHex: string): string {
  const sig = secp256k1.sign(personalDigest(message), keyBytes(privateKeyHex), { lowS: true });
  return '0x' + toHex(sig.toCompactRawBytes()) + (27 + sig.recovery).toString(16);
}
