/**
 * Payout wallet proof of control (D8). Reference vectors come from viem
 * (hashMessage / signMessage with Hardhat account #0, a public test key).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  buildBindMessage, parseBindMessage, personalMessageDigest, recoverSigner, verifyBindProof, freshBindMessage, rpcEndpoints, RPC_CALL_BUDGET_MS, RPC_HEDGE_MS,
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

  describe('smart wallets on Base (ERC-1271)', () => {
    const SMART = '0x' + 'ab'.repeat(20);
    const msg = buildBindMessage({ ...FIELDS, address: SMART });
    const MAGIC = '0x1626ba7e' + '0'.repeat(56);
    const sig65 = '0x' + 'cd'.repeat(65);
    const json = (body: object) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }), { status: 200 });
    /** fetch that answers per endpoint: a result, an RPC error, an HTTP status, a throw, or a delayed result. */
    type Plan = { result: string } | { error: { code: number; message: string } } | { status: number } | { fail: true } | { after: number; result: string } | { hang: true };
    const byUrl = (plans: Record<string, Plan>, fallback: Plan) => vi.fn((url: string, init: RequestInit) => {
      const plan = plans[url] ?? fallback;
      if ('fail' in plan) return Promise.reject(new Error('connection reset'));
      if ('status' in plan) return Promise.resolve(new Response('busy', { status: plan.status }));
      if ('error' in plan) return Promise.resolve(json({ error: plan.error }));
      if ('result' in plan && !('after' in plan)) return Promise.resolve(json({ result: plan.result }));
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        if ('after' in plan) setTimeout(() => resolve(json({ result: plan.result })), plan.after);
      });
    });
    const prove = (env: Record<string, string> = {}) => verifyBindProof(env, { ...base, address: SMART, message: msg, signature: sig65 });

    it('asks a deployed contract wallet through isValidSignature, in one eth_call', async () => {
      const f = byUrl({}, { result: MAGIC });
      vi.stubGlobal('fetch', f);
      expect(await prove({ BASE_RPC_URL: 'https://rpc.test' })).toMatchObject({ ok: true, signerKind: 'erc1271' });
      expect(f).toHaveBeenCalledTimes(1);
      expect(f.mock.calls[0][0]).toBe('https://rpc.test');
      const call = JSON.parse(String((f.mock.calls[0][1] as RequestInit).body)) as { method: string; params: Array<{ to: string; data: string }> };
      expect(call.method).toBe('eth_call');
      expect(call.params[0].to).toBe(SMART);
      expect(call.params[0].data.startsWith('0x1626ba7e' + hex(personalMessageDigest(msg)).slice(2))).toBe(true);
    });

    it('refuses when every node says no (wrong answer, or no code at the address), and is unavailable when none answers', async () => {
      const no = byUrl({}, { result: '0xffffffff' + '0'.repeat(56) });
      vi.stubGlobal('fetch', no);
      expect(await prove()).toMatchObject({ ok: false, reason: 'bad_signature' });
      expect(no).toHaveBeenCalledTimes(3); // a no needs every endpoint to agree
      vi.stubGlobal('fetch', byUrl({}, { result: '0x' }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', byUrl({}, { fail: true }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
    });

    it('a lagging node\'s "no code yet" never beats another node\'s yes (a wallet deployed seconds ago)', async () => {
      vi.useFakeTimers();
      try {
        // The configured node has the new wallet but is slow; the public ones haven't seen it yet.
        vi.stubGlobal('fetch', byUrl({ 'https://rpc.test': { after: 3_000, result: MAGIC } }, { result: '0x' }));
        const pending = prove({ BASE_RPC_URL: 'https://rpc.test' });
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await pending).toMatchObject({ ok: true, signerKind: 'erc1271' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('a wallet that reverts (e.g. a Safe) is a no (400), not an outage (503); a yes elsewhere still wins', async () => {
      vi.stubGlobal('fetch', byUrl({}, { error: { code: 3, message: 'execution reverted: GS026' } }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', byUrl({}, { error: { code: -32000, message: 'execution reverted' } }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', byUrl({ 'https://mainnet.base.org': { error: { code: 3, message: 'execution reverted' } } }, { result: MAGIC }));
      expect(await prove()).toMatchObject({ ok: true, signerKind: 'erc1271' });
      // A node that is rate limiting us is an outage, not a verdict.
      vi.stubGlobal('fetch', byUrl({}, { error: { code: -32005, message: 'limit exceeded' } }));
      expect(await prove()).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
    });

    it('moves on at once from a rate-limited or failing endpoint, configured ones first', async () => {
      const f = byUrl({ 'https://rpc.test': { status: 429 }, 'https://mainnet.base.org': { fail: true } }, { result: MAGIC });
      vi.stubGlobal('fetch', f);
      expect(await prove({ BASE_RPC_URL: 'https://rpc.test' })).toMatchObject({ ok: true, signerKind: 'erc1271' });
      expect(f.mock.calls.map((c) => c[0])).toEqual(['https://rpc.test', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com']);
    });

    it('a hanging endpoint never keeps a healthy one from being asked (hedged after RPC_HEDGE_MS)', async () => {
      vi.useFakeTimers();
      try {
        const f = byUrl({ 'https://rpc.test': { hang: true } }, { result: MAGIC });
        vi.stubGlobal('fetch', f);
        let settled = false;
        const pending = prove({ BASE_RPC_URL: 'https://rpc.test' }).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(RPC_HEDGE_MS);
        expect(settled).toBe(true);
        expect(await pending).toMatchObject({ ok: true, signerKind: 'erc1271' });
        expect(f.mock.calls.map((c) => c[0])).toEqual(['https://rpc.test', 'https://mainnet.base.org']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('when every endpoint hangs, every one is still asked and the proof gives up within its budget', async () => {
      vi.useFakeTimers();
      try {
        const f = byUrl({}, { hang: true });
        vi.stubGlobal('fetch', f);
        let settled = false;
        const pending = prove({ BASE_RPC_URL: 'https://rpc.test' }).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(RPC_CALL_BUDGET_MS);
        expect(settled).toBe(true);
        expect(await pending).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
        expect(f).toHaveBeenCalledTimes(4); // the configured node and all three public ones
        expect(RPC_CALL_BUDGET_MS).toBeLessThan(30_000); // the SDK's request timeout
      } finally {
        vi.useRealTimers();
      }
    });

    it('lists the configured endpoints (comma-separated) before the public ones, without repeats', () => {
      expect(rpcEndpoints({ BASE_RPC_URL: ' https://a.test, https://mainnet.base.org ,' }, 'eip155:8453'))
        .toEqual(['https://a.test', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']);
      expect(rpcEndpoints({}, 'eip155:84532')).toEqual(['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org']);
      expect(rpcEndpoints({}, 'eip155:1')).toEqual([]);
    });

    it('refuses a signature that is not whole bytes, without calling out', async () => {
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: '0x' + 'c'.repeat(141) })).toMatchObject({ ok: false, reason: 'bad_signature' });
      expect(f).not.toHaveBeenCalled();
    });

    it('checks an ERC-6492 signature (a smart wallet not deployed yet) with the reference validator, deployless', async () => {
      const sig6492 = '0x' + 'cd'.repeat(100) + '6492649264926492649264926492649264926492649264926492649264926492';
      const answer = (result: string) => vi.fn(async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }));

      const valid = answer('0x01');
      vi.stubGlobal('fetch', valid);
      expect(await verifyBindProof({ BASE_RPC_URL: 'https://rpc.test' }, { ...base, address: SMART, message: msg, signature: sig6492 }))
        .toMatchObject({ ok: true, signerKind: 'erc1271' });
      expect(valid).toHaveBeenCalledTimes(1); // one eth_call, no getCode: the validator handles both cases
      const req = JSON.parse(String((valid.mock.calls[0][1] as RequestInit).body)) as { method: string; params: [{ to?: string; data: string }, string] };
      expect(req.method).toBe('eth_call');
      expect(req.params[0].to).toBeUndefined();
      const data = req.params[0].data;
      expect(data.startsWith(ERC6492_VALIDATOR_BYTECODE)).toBe(true);
      const args = data.slice(ERC6492_VALIDATOR_BYTECODE.length);
      const sigHex = sig6492.slice(2);
      expect(args).toBe(
        SMART.slice(2).padStart(64, '0')
        + hex(personalMessageDigest(msg)).slice(2)
        + (96).toString(16).padStart(64, '0')
        + (sigHex.length / 2).toString(16).padStart(64, '0')
        + sigHex.padEnd(Math.ceil(sigHex.length / 64) * 64, '0'),
      );

      vi.stubGlobal('fetch', answer('0x00'));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: sig6492 })).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }), { status: 200 })));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: sig6492 })).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: sig6492 })).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
    });

    it('pins the validator bytecode (viem 2.57.2 erc6492SignatureValidatorByteCode)', () => {
      expect(createHash('sha256').update(ERC6492_VALIDATOR_BYTECODE).digest('hex'))
        .toBe('037d6b69e53bae264a9a752be534c6373b3f829fb606456f184d2ba841de6ea4');
    });
  });
});
