/**
 * Payout wallet proof of control (D8). Reference vectors come from viem
 * (hashMessage / signMessage with Hardhat account #0, a public test key).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  buildBindMessage, parseBindMessage, personalMessageDigest, recoverSigner, verifyBindProof, freshBindMessage,
  BIND_FOOTER, type BindFields,
} from './bind.js';

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
    const rpcStub = (code: string, callResult: string) => vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { method: string };
      const result = req.method === 'eth_getCode' ? code : callResult;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
    });

    it('asks a deployed contract wallet through isValidSignature', async () => {
      const f = rpcStub('0x6080', '0x1626ba7e' + '0'.repeat(56));
      vi.stubGlobal('fetch', f);
      const res = await verifyBindProof({ BASE_RPC_URL: 'https://rpc.test' }, { ...base, address: SMART, message: msg, signature: '0x' + 'cd'.repeat(200) });
      expect(res).toMatchObject({ ok: true, signerKind: 'erc1271' });
      expect(f.mock.calls[0][0]).toBe('https://rpc.test');
      const call = JSON.parse(String((f.mock.calls[1][1] as RequestInit).body)) as { params: Array<{ to: string; data: string }> };
      expect(call.params[0].to).toBe(SMART);
      expect(call.params[0].data.startsWith('0x1626ba7e' + hex(personalMessageDigest(msg)).slice(2))).toBe(true);
    });

    it('refuses when the contract says no, when there is no contract, and when the RPC is down', async () => {
      vi.stubGlobal('fetch', rpcStub('0x6080', '0xffffffff' + '0'.repeat(56)));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: '0x' + 'cd'.repeat(65) })).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', rpcStub('0x', '0x'));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: '0x' + 'cd'.repeat(65) })).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: '0x' + 'cd'.repeat(65) })).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
    });

    it('a wallet that reverts on a bad signature (e.g. a Safe) is a "no" (400), not an outage (503)', async () => {
      const reverting = (error: { code: number; message: string }) => vi.fn(async (_url: string, init: RequestInit) => {
        const req = JSON.parse(String(init.body)) as { method: string };
        const body = req.method === 'eth_getCode' ? { jsonrpc: '2.0', id: 1, result: '0x6080' } : { jsonrpc: '2.0', id: 1, error };
        return new Response(JSON.stringify(body), { status: 200 });
      });
      vi.stubGlobal('fetch', reverting({ code: 3, message: 'execution reverted: GS026' }));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: '0x' + 'cd'.repeat(65) })).toMatchObject({ ok: false, reason: 'bad_signature' });
      vi.stubGlobal('fetch', reverting({ code: -32000, message: 'execution reverted' }));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: '0x' + 'cd'.repeat(65) })).toMatchObject({ ok: false, reason: 'bad_signature' });
      // A node that is rate limiting us is an outage, not a verdict.
      vi.stubGlobal('fetch', reverting({ code: -32005, message: 'limit exceeded' }));
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: '0x' + 'cd'.repeat(65) })).toMatchObject({ ok: false, reason: 'rpc_unavailable' });
    });

    it('refuses a signature that is not whole bytes, without calling out', async () => {
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: '0x' + 'c'.repeat(141) })).toMatchObject({ ok: false, reason: 'bad_signature' });
      expect(f).not.toHaveBeenCalled();
    });

    it('explains a counterfactual (ERC-6492) signature instead of calling out', async () => {
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      const sig6492 = '0x' + 'cd'.repeat(100) + '6492649264926492649264926492649264926492649264926492649264926492';
      expect(await verifyBindProof({}, { ...base, address: SMART, message: msg, signature: sig6492 })).toMatchObject({ ok: false, reason: 'undeployed_smart_wallet' });
      expect(f).not.toHaveBeenCalled();
    });
  });
});
