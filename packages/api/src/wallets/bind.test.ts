/**
 * Payout wallet proof of control (D8). Reference vectors come from viem
 * (hashMessage / signMessage with Hardhat account #0, a public test key).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  buildBindMessage, parseBindMessage, personalMessageDigest, recoverSigner, verifyBindProof, freshBindMessage, rpcEndpoints, RPC_CALL_BUDGET_MS, RPC_HEAD_BUDGET_MS, RPC_HEDGE_MS, RPC_RETRY_MS,
  BIND_FOOTER, ERC6492_VALIDATOR_BYTECODE, type BindFields,
} from './bind.js';
import { createHash } from 'node:crypto';

const hex = (b: Uint8Array) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** Hardhat account #0 — a public test key. */
const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const AGENT = 'ag_7Xk9mP2qR8nK4vL3aB5cD6eF7gH8jK9mN2pQ3rS4tU5v';
const FIELDS: BindFields = { agentId: AGENT, address: ADDR.toLowerCase(), network: 'eip155:8453', issuedAt: '2026-09-29T01:52:00Z', nonce: '3f9c1a7e0b5d4c2a' };
const MESSAGE = buildBindMessage(FIELDS);
/** viem: privateKeyToAccount(PK).signMessage({ message: MESSAGE }) */
const VIEM_SIG = '0xe9089ec26c28e784120cbf852cd3efee0e99dd34a51fb1b7f63ba73120cd53b438db0c4441a597f7e44b812a729a963f9fc3bfc8bbefc68e0c1ca7f07869e11a1b';
const AT = new Date('2026-09-29T01:53:00Z');

function sign(message: string, pk = PK): string {
  const sig = secp256k1.sign(personalMessageDigest(message), pk, { lowS: true });
  return hex(sig.toCompactRawBytes()) + (27 + sig.recovery).toString(16);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('EIP-191 digest and recovery match viem', () => {
  it('hashes like hashMessage', () => {
    expect(hex(personalMessageDigest('hello world'))).toBe('0xd9eba16ed0ecae432b71fe008c98cc872bb4cc214d3220a36f365326cf807d68');
    expect(hex(personalMessageDigest(MESSAGE))).toBe('0x6ab8d995ad8925992c42e1724ca6b762e219c814fafc14545ab4b18f6021c345');
  });

  it('recovers the signer of a viem signature, and of our own', () => {
    expect(recoverSigner(personalMessageDigest(MESSAGE), VIEM_SIG)).toBe(ADDR);
    expect(recoverSigner(personalMessageDigest(MESSAGE), sign(MESSAGE))).toBe(ADDR);
    expect(recoverSigner(personalMessageDigest(MESSAGE), '0x1234')).toBeNull();
  });
});

describe('bind message', () => {
  it('round-trips the canonical form; anything else is refused', () => {
    expect(parseBindMessage(MESSAGE)).toEqual(FIELDS);
    expect(parseBindMessage(MESSAGE.replace(/\n/g, '\r\n'))).toBeNull(); // the digest covers the bytes as sent
    expect(parseBindMessage(MESSAGE + '\n')).toBeNull();
    expect(parseBindMessage(MESSAGE.replace(BIND_FOOTER, 'Sure, take my money.'))).toBeNull();
    expect(parseBindMessage(MESSAGE.replace('Nonce: 3f9c1a7e0b5d4c2a', 'Nonce: short'))).toBeNull();
    expect(parseBindMessage(MESSAGE.replace('Network: eip155:8453', 'Network: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'))).toBeNull();
    expect(parseBindMessage(MESSAGE.replace('Agent: ', 'Agent:  '))).toBeNull();
  });

  it('freshBindMessage is canonical, lowercases the address and drops milliseconds', () => {
    const msg = freshBindMessage(AGENT, ADDR, 'eip155:8453', new Date('2026-09-29T01:52:00.456Z'));
    expect(parseBindMessage(msg)).toMatchObject({ agentId: AGENT, address: ADDR.toLowerCase(), issuedAt: '2026-09-29T01:52:00Z' });
  });
});

describe('verifyBindProof', () => {
  const base = { agentId: AGENT, address: ADDR, network: 'eip155:8453', message: MESSAGE, signature: VIEM_SIG, now: AT };

  it('accepts the wallet\'s own signature (EOA, no network call)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await verifyBindProof({}, base)).toMatchObject({ ok: true, signerKind: 'eoa' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a message for another agent, wallet or network, or out of its time window', async () => {
    expect(await verifyBindProof({}, { ...base, agentId: 'ag_' + 'z'.repeat(44) })).toMatchObject({ ok: false, reason: 'agent_mismatch' });
    expect(await verifyBindProof({}, { ...base, address: '0x' + '11'.repeat(20) })).toMatchObject({ ok: false, reason: 'address_mismatch' });
    expect(await verifyBindProof({}, { ...base, network: 'eip155:84532' })).toMatchObject({ ok: false, reason: 'network_mismatch' });
    expect(await verifyBindProof({}, { ...base, now: new Date('2026-09-29T02:08:00Z') })).toMatchObject({ ok: false, reason: 'expired' });
    expect(await verifyBindProof({}, { ...base, now: new Date('2026-09-29T01:48:00Z') })).toMatchObject({ ok: false, reason: 'issued_in_future' });
    expect(await verifyBindProof({}, { ...base, message: 'sign here' })).toMatchObject({ ok: false, reason: 'malformed_message' });
  });

  it('refuses an impossible Issued time (it would never expire) and a CRLF copy (it would not re-verify)', async () => {
    for (const issuedAt of ['2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-09-29T25:00:00Z', '2026-09-32T00:00:00Z']) {
      const bad = buildBindMessage({ ...FIELDS, issuedAt });
      expect(parseBindMessage(bad), issuedAt).toBeNull();
      expect(await verifyBindProof({}, { ...base, message: bad, signature: sign(bad) }), issuedAt).toMatchObject({ ok: false, reason: 'malformed_message' });
    }
    const crlf = MESSAGE.replace(/\n/g, '\r\n');
    expect(parseBindMessage(crlf)).toBeNull();
    expect(await verifyBindProof({}, { ...base, message: crlf, signature: sign(crlf) })).toMatchObject({ ok: false, reason: 'malformed_message' });
  });

  it('a signature from another key is refused (off Base: no network call)', async () => {
    const other = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // Hardhat #1
    const msg = buildBindMessage({ ...FIELDS, network: 'eip155:1' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await verifyBindProof({}, { ...base, network: 'eip155:1', message: msg, signature: sign(msg, other) })).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('smart wallets on Base (ERC-1271 / ERC-6492)', () => {
    const SMART = '0x' + 'ab'.repeat(20);
    const msg = buildBindMessage({ ...FIELDS, address: SMART });
    const sig65 = '0x' + 'cd'.repeat(65);
    const HEAD = '0x10';
    const PUBLIC = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'];
    const word = (n: number) => n.toString(16).padStart(64, '0');
    type Answer = { result: string } | { error: { code: number; message: string } } | { status: number } | { fail: true } | { hang: true };
    type Node = { head?: Answer; call?: Answer };
    const json = (body: object) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }), { status: 200 });
    /** A fake set of nodes: per endpoint, how it answers eth_blockNumber (head) and eth_call (call). */
    const net = (nodes: Record<string, Node>, fallback: Node = {}) => vi.fn((url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { method: string };
      const node = nodes[url] ?? {};
      const plan: Answer = (req.method === 'eth_blockNumber' ? node.head ?? fallback.head : node.call ?? fallback.call)
        ?? { result: req.method === 'eth_blockNumber' ? HEAD : '0x01' };
      if ('fail' in plan) return Promise.reject(new Error('connection reset'));
      if ('status' in plan) return Promise.resolve(new Response('busy', { status: plan.status }));
      if ('error' in plan) return Promise.resolve(json({ error: plan.error }));
      if ('result' in plan) return Promise.resolve(json({ result: plan.result }));
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    type Sent = { url: string; method: string; params: [{ to?: string; data: string }, string] };
    const sent = (f: ReturnType<typeof net>): Sent[] => f.mock.calls.map(([url, init]) => ({ url, ...(JSON.parse(String((init as RequestInit).body)) as Omit<Sent, 'url'>) }));
    const ethCalls = (f: ReturnType<typeof net>) => sent(f).filter((c) => c.method === 'eth_call');
    const prove = (env: Record<string, string> = {}, signature = sig65) => verifyBindProof(env, { ...base, address: SMART, message: msg, signature });

    it('checks any smart wallet with the reference validator: one deployless eth_call, pinned to the freshest block', async () => {
      const f = net({ 'https://mainnet.base.org': { head: { result: '0x12' } } });
      vi.stubGlobal('fetch', f);
      expect(await prove({ BASE_RPC_URL: 'https://rpc.test' })).toMatchObject({ ok: true, signerKind: 'erc1271' });
      expect(sent(f).filter((c) => c.method === 'eth_blockNumber').map((c) => c.url)).toEqual(['https://rpc.test', ...PUBLIC]);
      const [call, ...more] = ethCalls(f);
      expect(more).toHaveLength(0);
      expect(call.params[0].to).toBeUndefined(); // no contract (or precompile) can answer in the wallet's place
      expect(call.params[1]).toBe('0x12'); // the highest head any node reported
      expect(call.params[0].data).toBe(ERC6492_VALIDATOR_BYTECODE + SMART.slice(2).padStart(64, '0') + hex(personalMessageDigest(msg)).slice(2)
        + word(96) + word(65) + sig65.slice(2).padEnd(192, '0'));
    });

    it('only an exact 0x01 is a yes: 0x00, an echo of the call data or a revert is a no; no answer at all is an outage', async () => {
      vi.stubGlobal('fetch', net({}, { call: { result: '0x00' } }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'bad_signature' });
      // What the identity precompile (0x…04) would return for an isValidSignature call.
      vi.stubGlobal('fetch', net({}, { call: { result: '0x1626ba7e' + '0'.repeat(56) + 'ab'.repeat(32) } }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', net({}, { call: { error: { code: 3, message: 'execution reverted: GS026' } } }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', net({}, { call: { error: { code: -32000, message: 'execution reverted' } } }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', net({}, { head: { fail: true } }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
      // A node that is rate limiting us is an outage, not a verdict: rounds repeat until the budget runs out.
      vi.useFakeTimers();
      try {
        const limited = net({}, { call: { error: { code: -32005, message: 'limit exceeded' } } });
        vi.stubGlobal('fetch', limited);
        const pending = prove();
        await vi.advanceTimersByTimeAsync(RPC_CALL_BUDGET_MS);
        expect(await pending).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
        expect(ethCalls(limited).length).toBeGreaterThan(3); // more than one round
      } finally {
        vi.useRealTimers();
      }
    });

    it('when the node with the freshest block fails the call and the rest are a block behind, it asks again a block later', async () => {
      vi.useFakeTimers();
      try {
        // mainnet.base.org reported 0x12 but is rate limiting the call; the others are at 0x11
        // and don't have 0x12 yet on the first round, then do on the next.
        const seen: Record<string, number> = {};
        const behind = (url: string, init: RequestInit) => {
          const req = JSON.parse(String(init.body)) as { method: string };
          if (req.method === 'eth_blockNumber') return Promise.resolve(json({ result: url === 'https://mainnet.base.org' ? '0x12' : '0x11' }));
          if (url === 'https://mainnet.base.org') return Promise.resolve(new Response('busy', { status: 429 }));
          seen[url] = (seen[url] ?? 0) + 1;
          return Promise.resolve(seen[url] === 1 ? json({ error: { code: -32000, message: 'block not found: 0x12' } }) : json({ result: '0x01' }));
        };
        const f = vi.fn(behind);
        vi.stubGlobal('fetch', f);
        let settled = false;
        const pending = prove().finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(RPC_RETRY_MS);
        expect(settled).toBe(true);
        expect(await pending).toMatchObject({ ok: true, signerKind: 'erc1271' });
        expect(ethCalls(f as never).every((c) => c.params[1] === '0x12')).toBe(true); // never an older block
      } finally {
        vi.useRealTimers();
      }
    });

    it('a lagging node is asked at the fresh block, which it lacks, so it is skipped, never believed', async () => {
      // The configured node is behind (head 0x10): from its old state it could miss a wallet
      // deployed seconds ago, or still accept a signer the wallet has since removed.
      const lagging: Node = { head: { result: '0x10' }, call: { error: { code: -32000, message: 'block not found: 0x12' } } };
      const fresh = (answer: string): Node => ({ head: { result: '0x12' }, call: { result: answer } });
      // A wallet deployed seconds ago: the fresh node sees it and says yes.
      let f = net({ 'https://rpc.test': lagging, 'https://mainnet.base.org': fresh('0x01') });
      vi.stubGlobal('fetch', f);
      expect(await prove({ BASE_RPC_URL: 'https://rpc.test' })).toMatchObject({ ok: true });
      expect(ethCalls(f).map((c) => [c.url, c.params[1]])).toEqual([['https://rpc.test', '0x12'], ['https://mainnet.base.org', '0x12']]);
      // A signer removed seconds ago: the fresh node says no, and that is the answer.
      f = net({ 'https://rpc.test': lagging, 'https://mainnet.base.org': fresh('0x00') });
      vi.stubGlobal('fetch', f);
      expect(await prove({ BASE_RPC_URL: 'https://rpc.test' })).toMatchObject({ ok: false, reason: 'bad_signature' });
      expect(ethCalls(f).every((c) => c.params[1] === '0x12')).toBe(true);
    });

    it('moves on at once from a rate-limited or failing endpoint, configured ones first', async () => {
      const f = net({ 'https://rpc.test': { call: { status: 429 } }, 'https://mainnet.base.org': { call: { fail: true } } });
      vi.stubGlobal('fetch', f);
      expect(await prove({ BASE_RPC_URL: 'https://rpc.test' })).toMatchObject({ ok: true, signerKind: 'erc1271' });
      expect(ethCalls(f).map((c) => c.url)).toEqual(['https://rpc.test', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com']);
    });

    it('a hanging endpoint never keeps a healthy one from being asked (hedged after RPC_HEDGE_MS)', async () => {
      vi.useFakeTimers();
      try {
        const f = net({ 'https://rpc.test': { head: { hang: true }, call: { hang: true } } });
        vi.stubGlobal('fetch', f);
        let settled = false;
        const pending = prove({ BASE_RPC_URL: 'https://rpc.test' }).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(2 * RPC_HEDGE_MS); // the head window, then one hedge
        expect(settled).toBe(true);
        expect(await pending).toMatchObject({ ok: true, signerKind: 'erc1271' });
        expect(ethCalls(f).map((c) => c.url)).toEqual(['https://rpc.test', 'https://mainnet.base.org']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('when every endpoint hangs, each is still asked and the proof gives up within its budget', async () => {
      vi.useFakeTimers();
      try {
        let f = net({}, { head: { hang: true } });
        vi.stubGlobal('fetch', f);
        let pending = prove({ BASE_RPC_URL: 'https://rpc.test' });
        await vi.advanceTimersByTimeAsync(RPC_HEAD_BUDGET_MS);
        expect(await pending).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
        expect(f).toHaveBeenCalledTimes(4);

        f = net({}, { call: { hang: true } });
        vi.stubGlobal('fetch', f);
        let settled = false;
        pending = prove({ BASE_RPC_URL: 'https://rpc.test' }).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(RPC_CALL_BUDGET_MS);
        expect(settled).toBe(true);
        expect(await pending).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
        expect(ethCalls(f)).toHaveLength(4); // the configured node and all three public ones
        expect(RPC_HEAD_BUDGET_MS + RPC_CALL_BUDGET_MS).toBeLessThan(30_000); // the SDK's request timeout
      } finally {
        vi.useRealTimers();
      }
    });

    it('lists the configured endpoints (comma-separated) before the public ones, without repeats', () => {
      expect(rpcEndpoints({ BASE_RPC_URL: ' https://a.test, https://mainnet.base.org ,' }, 'eip155:8453'))
        .toEqual(['https://a.test', ...PUBLIC]);
      expect(rpcEndpoints({}, 'eip155:84532')).toEqual(['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org']);
      expect(rpcEndpoints({}, 'eip155:1')).toEqual([]);
    });

    it('refuses a signature that is not whole bytes, without calling out', async () => {
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      expect(await prove({}, '0x' + 'c'.repeat(141))).toMatchObject({ ok: false, reason: 'bad_signature' });
      expect(f).not.toHaveBeenCalled();
    });

    it('checks an ERC-6492 signature (a smart wallet not deployed yet) the same way, deployless', async () => {
      const sig6492 = '0x' + 'cd'.repeat(100) + '6492649264926492649264926492649264926492649264926492649264926492';
      const f = net({});
      vi.stubGlobal('fetch', f);
      expect(await prove({}, sig6492)).toMatchObject({ ok: true, signerKind: 'erc1271' });
      const [call] = ethCalls(f);
      expect(call.params[0].to).toBeUndefined();
      expect(call.params[1]).toBe(HEAD);
      const sigHex = sig6492.slice(2);
      expect(call.params[0].data).toBe(ERC6492_VALIDATOR_BYTECODE + SMART.slice(2).padStart(64, '0') + hex(personalMessageDigest(msg)).slice(2)
        + word(96) + word(sigHex.length / 2) + sigHex.padEnd(Math.ceil(sigHex.length / 64) * 64, '0'));

      vi.stubGlobal('fetch', net({}, { call: { result: '0x00' } }));
      expect(await prove({}, sig6492)).toMatchObject({ ok: false, reason: 'bad_signature', detail: expect.stringContaining('ERC-6492') });
      vi.stubGlobal('fetch', net({}, { head: { fail: true } }));
      expect(await prove({}, sig6492)).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
    });

    it('pins the validator bytecode (viem 2.57.2 erc6492SignatureValidatorByteCode)', () => {
      expect(createHash('sha256').update(ERC6492_VALIDATOR_BYTECODE).digest('hex'))
        .toBe('037d6b69e53bae264a9a752be534c6373b3f829fb606456f184d2ba841de6ea4');
    });
  });
});
