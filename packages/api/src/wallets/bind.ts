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
 * Otherwise, on Base (eip155:8453 / 84532), over JSON-RPC (BASE_RPC_URL /
 * BASE_SEPOLIA_RPC_URL first, then public endpoints; a yes from any node wins, a no needs
 * every node that answers to agree, since a lagging node can miss a just-deployed wallet):
 *  - a deployed smart-contract wallet is asked through ERC-1271 isValidSignature;
 *  - a signature wrapped per ERC-6492 (a smart wallet not deployed yet, such as
 *    a fresh Coinbase Smart Wallet) is checked counterfactually by the ERC-6492
 *    reference validator, run as a deployless eth_call: nothing is deployed and
 *    no gas is spent.
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
/**
 * Creation code of the ERC-6492 reference validator (ValidateSigOffchain),
 * taken verbatim from viem 2.57.2, constants/contracts.js
 * `erc6492SignatureValidatorByteCode` (MIT). Run with constructor args
 * (address signer, bytes32 hash, bytes signature) as a deployless eth_call, it
 * deploys the wallet in the call's sandbox when needed, asks it ERC-1271
 * isValidSignature, and returns 0x01 for a valid signature. bind.test.ts pins
 * its sha256.
 */
export const ERC6492_VALIDATOR_BYTECODE = '0x608060405234801561001057600080fd5b5060405161069438038061069483398101604081905261002f9161051e565b600061003c848484610048565b9050806000526001601ff35b60007f64926492649264926492649264926492649264926492649264926492649264926100748361040c565b036101e7576000606080848060200190518101906100929190610577565b60405192955090935091506000906001600160a01b038516906100b69085906105dd565b6000604051808303816000865af19150503d80600081146100f3576040519150601f19603f3d011682016040523d82523d6000602084013e6100f8565b606091505b50509050876001600160a01b03163b60000361016057806101605760405162461bcd60e51b815260206004820152601e60248201527f5369676e617475726556616c696461746f723a206465706c6f796d656e74000060448201526064015b60405180910390fd5b604051630b135d3f60e11b808252906001600160a01b038a1690631626ba7e90610190908b9087906004016105f9565b602060405180830381865afa1580156101ad573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906101d19190610633565b6001600160e01b03191614945050505050610405565b6001600160a01b0384163b1561027a57604051630b135d3f60e11b808252906001600160a01b03861690631626ba7e9061022790879087906004016105f9565b602060405180830381865afa158015610244573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906102689190610633565b6001600160e01b031916149050610405565b81516041146102df5760405162461bcd60e51b815260206004820152603a602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e6174757265206c656e6774680000000000006064820152608401610157565b6102e7610425565b5060208201516040808401518451859392600091859190811061030c5761030c61065d565b016020015160f81c9050601b811480159061032b57508060ff16601c14155b1561038c5760405162461bcd60e51b815260206004820152603b602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e617475726520762076616c756500000000006064820152608401610157565b60408051600081526020810180835289905260ff83169181019190915260608101849052608081018390526001600160a01b0389169060019060a0016020604051602081039080840390855afa1580156103ea573d6000803e3d6000fd5b505050602060405103516001600160a01b0316149450505050505b9392505050565b600060208251101561041d57600080fd5b508051015190565b60405180606001604052806003906020820280368337509192915050565b6001600160a01b038116811461045857600080fd5b50565b634e487b7160e01b600052604160045260246000fd5b60005b8381101561048c578181015183820152602001610474565b50506000910152565b600082601f8301126104a657600080fd5b81516001600160401b038111156104bf576104bf61045b565b604051601f8201601f19908116603f011681016001600160401b03811182821017156104ed576104ed61045b565b60405281815283820160200185101561050557600080fd5b610516826020830160208701610471565b949350505050565b60008060006060848603121561053357600080fd5b835161053e81610443565b6020850151604086015191945092506001600160401b0381111561056157600080fd5b61056d86828701610495565b9150509250925092565b60008060006060848603121561058c57600080fd5b835161059781610443565b60208501519093506001600160401b038111156105b357600080fd5b6105bf86828701610495565b604086015190935090506001600160401b0381111561056157600080fd5b600082516105ef818460208701610471565b9190910192915050565b828152604060208201526000825180604084015261061e816060850160208701610471565b601f01601f1916919091016060019392505050565b60006020828403121561064557600080fd5b81516001600160e01b03198116811461040557600080fd5b634e487b7160e01b600052603260045260246000fdfe5369676e617475726556616c696461746f72237265636f7665725369676e6572';

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
  | 'expired' | 'issued_in_future' | 'bad_signature';

export type ProofResult =
  | { ok: true; signerKind: 'eoa' | 'erc1271'; fields: BindFields }
  | { ok: false; reason: ProofFailure; detail: string }
  | { ok: false; reason: 'rpc_unavailable'; detail: string };

// Public endpoints, tried in order after any configured in the env var (a comma-separated
// list). Each was checked for eth_getCode, eth_call and a deployless eth_call (ERC-6492).
// Public nodes rate-limit, and Workers share egress IPs, so one 429 must not fail a bind.
const RPC_DEFAULTS: Record<string, { env: string; urls: string[] }> = {
  'eip155:8453': { env: 'BASE_RPC_URL', urls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'] },
  'eip155:84532': { env: 'BASE_SEPOLIA_RPC_URL', urls: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org'] },
};

/** The endpoints to try for a chain: the configured ones first, then the public defaults. */
export function rpcEndpoints(env: unknown, network: string): string[] {
  const chain = RPC_DEFAULTS[network];
  if (!chain) return [];
  const configured = (((env ?? {}) as Record<string, string | undefined>)[chain.env] ?? '')
    .split(',').map((u) => u.trim()).filter(Boolean);
  return [...new Set([...configured, ...chain.urls])];
}

/** The node processed the call and refused it (e.g. the wallet's isValidSignature reverted): a "no", not an outage. */
class RpcRejected extends Error {}

/**
 * The one RPC call a smart-wallet proof makes settles within this, well inside the SDK's
 * 30 s request timeout.
 */
export const RPC_CALL_BUDGET_MS = 9_000;
/** A call that hasn't answered by then also goes to the next endpoint (a hedged request). */
export const RPC_HEDGE_MS = 1_500;

async function rpcOnce(url: string, method: string, params: unknown[], timeoutMs: number, cancel: AbortSignal): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onCancel = () => ctrl.abort();
  cancel.addEventListener('abort', onCancel);
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
    cancel.removeEventListener('abort', onCancel);
  }
}

/**
 * Ask the endpoints whether the wallet accepts the signature. Nodes can lag (a wallet
 * deployed seconds ago may have no code yet on one of them), and lag only ever hides a
 * "yes", so a yes from any node wins at once, while a no counts only when every endpoint
 * has answered (or the budget ran out) and none said yes. A failure (429, 5xx, a node that
 * lacks the method) starts the next endpoint at once, and so does RPC_HEDGE_MS of silence,
 * so a hanging node never keeps a healthy one from being asked. Rejects only when no node
 * answered at all.
 */
function askEndpoints(urls: string[], method: string, params: unknown[], isYes: (result: string) => boolean): Promise<'yes' | 'no'> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + RPC_CALL_BUDGET_MS;
    const queue = [...urls];
    const cancel = new AbortController();
    let inFlight = 0;
    let done = false;
    let answeredNo = false;
    let hedge: ReturnType<typeof setTimeout> | undefined;
    let last: unknown = new Error(`RPC ${method}: no endpoint answered within ${RPC_CALL_BUDGET_MS / 1000} s`);
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(hedge);
      cancel.abort();
      settle();
    };
    const launch = (): void => {
      clearTimeout(hedge);
      if (done) return;
      const left = deadline - Date.now();
      const url = left > 0 ? queue.shift() : undefined;
      if (!url) {
        if (inFlight === 0) finish(() => (answeredNo ? resolve('no') : reject(last)));
        return;
      }
      inFlight++;
      rpcOnce(url, method, params, left, cancel.signal).then(
        (result) => {
          inFlight--;
          if (isYes(result)) { finish(() => resolve('yes')); return; }
          answeredNo = true;
          launch();
        },
        (err: unknown) => {
          inFlight--;
          if (err instanceof RpcRejected) answeredNo = true; // the wallet reverted: a no
          else last = err;
          launch();
        },
      );
      if (queue.length > 0) hedge = setTimeout(launch, RPC_HEDGE_MS);
    };
    launch();
  });
}

/** ABI-encode isValidSignature(bytes32 hash, bytes signature). */
function isValidSignatureCall(digest: Uint8Array, signatureHex: string): string {
  const sig = signatureHex.replace(/^0x/, '');
  const hex = (n: number) => n.toString(16).padStart(64, '0');
  const padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, '0');
  const digestHex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return `0x${ERC1271_MAGIC}${digestHex}${hex(64)}${hex(sig.length / 2)}${padded}`;
}

/** ABI-encode the validator's constructor args: (address signer, bytes32 hash, bytes signature). */
function erc6492ValidatorCall(address: string, digest: Uint8Array, signatureHex: string): string {
  const sig = signatureHex.replace(/^0x/, '').toLowerCase();
  const word = (n: number) => n.toString(16).padStart(64, '0');
  const addr = address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const digestHex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  const padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, '0');
  return `${ERC6492_VALIDATOR_BYTECODE}${addr}${digestHex}${word(96)}${word(sig.length / 2)}${padded}`;
}

/**
 * Check a bind proof for `agentId` binding `address` on `network`. The message
 * must be canonical and name exactly those three, be fresh, and be signed by
 * the address (EOA, or ERC-1271 / ERC-6492 on Base). Nonce reuse is the caller's check
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
  const urls = rpcEndpoints(env, args.network);
  if (urls.length === 0) return { ok: false, reason: 'bad_signature', detail: 'The signature was not made by this wallet.' };
  const unavailable = (err: unknown): ProofResult => ({ ok: false, reason: 'rpc_unavailable', detail: `Could not reach ${args.network} to check the smart-wallet signature: ${err instanceof Error ? err.message : String(err)}` });
  if (sig.endsWith(ERC6492_SUFFIX)) {
    // A smart wallet's signature wrapped per ERC-6492 (deployed or not yet): the
    // reference validator answers 0x01 for a valid one, in a deployless call.
    try {
      const verdict = await askEndpoints(urls, 'eth_call', [{ data: erc6492ValidatorCall(args.address, digest, args.signature) }, 'latest'], (r) => /^0x0*1$/i.test(r));
      if (verdict === 'yes') return { ok: true, signerKind: 'erc1271', fields };
      return { ok: false, reason: 'bad_signature', detail: 'The smart wallet did not accept this signature (checked per ERC-6492).' };
    } catch (err) {
      return unavailable(err);
    }
  }
  // ERC-1271: ask the wallet. An address with no code answers empty, which is a no too.
  try {
    const verdict = await askEndpoints(urls, 'eth_call', [{ to: args.address, data: isValidSignatureCall(digest, args.signature) }, 'latest'],
      (r) => r.replace(/^0x/, '').slice(0, 8).toLowerCase() === ERC1271_MAGIC);
    if (verdict === 'yes') return { ok: true, signerKind: 'erc1271', fields };
    return { ok: false, reason: 'bad_signature', detail: 'The signature was not made by this wallet (an EOA key did not sign it, and no smart wallet at this address accepted it per ERC-1271).' };
  } catch (err) {
    return unavailable(err);
  }
}
