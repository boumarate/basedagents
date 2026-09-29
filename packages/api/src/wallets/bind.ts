/**
 * Payout wallet proof of control (decision D8, 2026-09-29).
 *
 * An agent brings its own payout address, but setting or changing it needs a
 * signature FROM that address over a bind message, alongside the AgentSig on
 * the request (which covers the body, so the agent consents too). The message
 * is plain text a wallet shows before signing (EIP-191 personal_sign):
 *
 *   BasedAgents payout wallet
 *   Agent: ag_…
 *   Wallet: 0x…
 *   Network: eip155:8453
 *   Issued: 2026-09-29T01:52:00Z
 *   Nonce: 3f9c1a7e0b5d4c2a
 *
 *   Signing proves you control this wallet and lets BasedAgents pay this agent's bounties to it. It moves no funds.
 *
 * The format is exact (buildBindMessage is the canonical form): the server
 * parses the fields, rebuilds the message and requires byte equality. A proof
 * is accepted for BIND_MAX_AGE_MS after `Issued` and each nonce once per agent.
 *
 * Verification: an EOA signature is recovered with secp256k1 (no network).
 * Otherwise, on Base (eip155:8453 / 84532), a deployed smart-contract wallet
 * is asked through ERC-1271 isValidSignature over JSON-RPC (BASE_RPC_URL /
 * BASE_SEPOLIA_RPC_URL; public endpoints by default). A counterfactual
 * (ERC-6492-wrapped) signature is refused with a clear reason: deploy the
 * wallet first.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { toChecksumAddress, sameAddress } from '../payments/house-wallet.js';

export const BIND_TITLE = 'BasedAgents payout wallet';
export const BIND_FOOTER = "Signing proves you control this wallet and lets BasedAgents pay this agent's bounties to it. It moves no funds.";
/** How long a signed bind message is accepted after its `Issued` time. */
export const BIND_MAX_AGE_MS = 15 * 60 * 1000;
/** Clock skew tolerated for an `Issued` time in the future. */
export const BIND_MAX_SKEW_MS = 2 * 60 * 1000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ISSUED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const AGENT_RE = /^ag_[1-9A-HJ-NP-Za-km-z]{20,60}$/;
/** ERC-6492 wrapper suffix: a signature from a smart wallet that isn't deployed yet. */
const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';
const ERC1271_MAGIC = '1626ba7e';

export interface BindFields {
  agentId: string;
  address: string;
  network: string;
  /** ISO-8601 UTC, e.g. 2026-09-29T01:52:00Z. */
  issuedAt: string;
  nonce: string;
}

/** The canonical bind message for these fields. */
export function buildBindMessage(f: BindFields): string {
  return [
    BIND_TITLE,
    `Agent: ${f.agentId}`,
    `Wallet: ${f.address}`,
    `Network: ${f.network}`,
    `Issued: ${f.issuedAt}`,
    `Nonce: ${f.nonce}`,
    '',
    BIND_FOOTER,
  ].join('\n');
}

/** A fresh message for the caller to sign (the 400 wallet_proof_required hands one back). */
export function freshBindMessage(agentId: string, address: string, network: string, now: Date = new Date()): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  return buildBindMessage({ agentId, address: address.toLowerCase(), network, issuedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), nonce });
}

/** True when an ISO timestamp names a real instant (Date.parse rolls Feb 30 over and gives NaN for month 13). */
function isRealTime(iso: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19) === iso.slice(0, 19);
}

/** The fields of a bind message, or null unless it is exactly in canonical form. */
export function parseBindMessage(message: string): BindFields | null {
  // The digest covers the bytes as sent, so only the canonical LF form parses (a CRLF copy would not re-verify).
  if (message.includes('\r')) return null;
  const lines = message.split('\n');
  if (lines.length !== 8 || lines[0] !== BIND_TITLE || lines[6] !== '' || lines[7] !== BIND_FOOTER) return null;
  const field = (line: string, key: string) => (line.startsWith(`${key}: `) ? line.slice(key.length + 2) : null);
  const agentId = field(lines[1], 'Agent');
  const address = field(lines[2], 'Wallet');
  const network = field(lines[3], 'Network');
  const issuedAt = field(lines[4], 'Issued');
  const nonce = field(lines[5], 'Nonce');
  if (!agentId || !AGENT_RE.test(agentId) || !address || !ADDRESS_RE.test(address) || !network || !/^eip155:\d{1,12}$/.test(network)
    || !issuedAt || !ISSUED_RE.test(issuedAt) || !isRealTime(issuedAt) || !nonce || !NONCE_RE.test(nonce)) return null;
  const fields = { agentId, address, network, issuedAt, nonce };
  return buildBindMessage(fields) === message ? fields : null;
}

/** EIP-191 personal_sign digest: keccak256("\x19Ethereum Signed Message:\n" + len + message). */
export function personalMessageDigest(message: string): Uint8Array {
  const bytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const all = new Uint8Array(prefix.length + bytes.length);
  all.set(prefix, 0);
  all.set(bytes, prefix.length);
  return keccak_256(all);
}

/** The EOA that produced a 65-byte signature over `digest`, or null when it isn't a valid one. */
export function recoverSigner(digest: Uint8Array, signatureHex: string): `0x${string}` | null {
  const hex = signatureHex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;
  let v = parseInt(hex.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const pub = secp256k1.Signature.fromCompact(hex.slice(0, 128)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
    return toChecksumAddress(keccak_256(pub.slice(1)).slice(12));
  } catch {
    return null;
  }
}

export type ProofFailure =
  | 'malformed_message' | 'agent_mismatch' | 'address_mismatch' | 'network_mismatch'
  | 'expired' | 'issued_in_future' | 'bad_signature' | 'undeployed_smart_wallet';

export type ProofResult =
  | { ok: true; signerKind: 'eoa' | 'erc1271'; fields: BindFields }
  | { ok: false; reason: ProofFailure; detail: string }
  | { ok: false; reason: 'rpc_unavailable'; detail: string };

const RPC_DEFAULTS: Record<string, { env: string; url: string }> = {
  'eip155:8453': { env: 'BASE_RPC_URL', url: 'https://mainnet.base.org' },
  'eip155:84532': { env: 'BASE_SEPOLIA_RPC_URL', url: 'https://sepolia.base.org' },
};

/** The node processed the call and refused it (e.g. the wallet's isValidSignature reverted): a "no", not an outage. */
class RpcRejected extends Error {}

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`RPC ${method} answered ${res.status}`);
    const body = await res.json() as { result?: string; error?: { code?: number; message?: string } };
    if (typeof body.result === 'string') return body.result;
    const reason = body.error?.message ?? 'no result';
    // Execution reverted (geth code 3, or -32000 "…revert…"): the contract said no.
    if (body.error && (body.error.code === 3 || /revert/i.test(reason))) throw new RpcRejected(`RPC ${method}: ${reason}`);
    throw new Error(`RPC ${method}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** ABI-encode isValidSignature(bytes32 hash, bytes signature). */
function isValidSignatureCall(digest: Uint8Array, signatureHex: string): string {
  const sig = signatureHex.replace(/^0x/, '');
  const hex = (n: number) => n.toString(16).padStart(64, '0');
  const padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, '0');
  const digestHex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return `0x${ERC1271_MAGIC}${digestHex}${hex(64)}${hex(sig.length / 2)}${padded}`;
}

/**
 * Check a bind proof for `agentId` binding `address` on `network`. The message
 * must be canonical and name exactly those three, be fresh, and be signed by
 * the address (EOA, or ERC-1271 on Base). Nonce reuse is the caller's check
 * (it needs the database).
 */
export async function verifyBindProof(
  env: unknown,
  args: { agentId: string; address: string; network: string; message: string; signature: string; now?: Date },
): Promise<ProofResult> {
  const fields = parseBindMessage(args.message);
  if (!fields) return { ok: false, reason: 'malformed_message', detail: 'The message is not a BasedAgents bind message in the exact format (sign the sign_this text you were given, unchanged).' };
  if (fields.agentId !== args.agentId) return { ok: false, reason: 'agent_mismatch', detail: `The message names ${fields.agentId}, not ${args.agentId}.` };
  if (!sameAddress(fields.address, args.address)) return { ok: false, reason: 'address_mismatch', detail: `The message names wallet ${fields.address}, not ${args.address}.` };
  if (fields.network !== args.network) return { ok: false, reason: 'network_mismatch', detail: `The message names network ${fields.network}, not ${args.network}.` };
  const now = (args.now ?? new Date()).getTime();
  const issued = Date.parse(fields.issuedAt);
  if (issued > now + BIND_MAX_SKEW_MS) return { ok: false, reason: 'issued_in_future', detail: 'The message is dated in the future; check your clock.' };
  if (now - issued > BIND_MAX_AGE_MS) return { ok: false, reason: 'expired', detail: `The message was issued more than ${BIND_MAX_AGE_MS / 60000} minutes ago; sign a fresh one.` };

  const digest = personalMessageDigest(args.message);
  const signer = recoverSigner(digest, args.signature);
  if (signer && sameAddress(signer, args.address)) return { ok: true, signerKind: 'eoa', fields };

  const sig = args.signature.replace(/^0x/, '').toLowerCase();
  if (sig.length % 2 !== 0 || !/^[0-9a-f]+$/.test(sig)) return { ok: false, reason: 'bad_signature', detail: 'The signature is not whole bytes of hex.' };
  const chain = RPC_DEFAULTS[args.network];
  if (!chain) return { ok: false, reason: 'bad_signature', detail: 'The signature was not made by this wallet.' };
  if (sig.endsWith(ERC6492_SUFFIX)) {
    return { ok: false, reason: 'undeployed_smart_wallet', detail: 'This is a smart wallet that is not deployed yet. Send one transaction from it (or use a regular wallet), then sign again.' };
  }
  const url = ((env ?? {}) as Record<string, string | undefined>)[chain.env] || chain.url;
  try {
    const code = await rpc(url, 'eth_getCode', [args.address, 'latest']);
    if (!code || code === '0x') return { ok: false, reason: 'bad_signature', detail: 'The signature was not made by this wallet.' };
    const result = await rpc(url, 'eth_call', [{ to: args.address, data: isValidSignatureCall(digest, args.signature) }, 'latest']);
    if (result.replace(/^0x/, '').slice(0, 8).toLowerCase() === ERC1271_MAGIC) return { ok: true, signerKind: 'erc1271', fields };
    return { ok: false, reason: 'bad_signature', detail: 'The smart wallet did not accept this signature (ERC-1271).' };
  } catch (err) {
    if (err instanceof RpcRejected) return { ok: false, reason: 'bad_signature', detail: 'The smart wallet did not accept this signature (ERC-1271).' };
    return { ok: false, reason: 'rpc_unavailable', detail: `Could not reach ${args.network} to check the smart-wallet signature: ${err instanceof Error ? err.message : String(err)}` };
  }
}
