/**
 * Payout wallet proof (D8): the SDK must build the registry's exact bind
 * message and sign it like any wallet's personal_sign. Vectors from viem with
 * Hardhat account #0 (a public test key); the API's wallets/bind.test.ts uses
 * the same ones.
 */
import { describe, it, expect } from 'vitest';
import { walletBindMessage, signWalletBindMessage, walletAddressFromPrivateKey, recoverWalletBindSigner } from './wallet-bind.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT = 'ag_7Xk9mP2qR8nK4vL3aB5cD6eF7gH8jK9mN2pQ3rS4tU5v';
const EXPECTED = [
  'BasedAgents payout wallet',
  `Agent: ${AGENT}`,
  'Wallet: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  'Network: eip155:8453',
  'Issued: 2026-09-29T01:52:00Z',
  'Nonce: 3f9c1a7e0b5d4c2a',
  '',
  "Signing proves you control this wallet and lets BasedAgents pay this agent's bounties to it. It moves no funds.",
].join('\n');
const VIEM_SIG = '0xe9089ec26c28e784120cbf852cd3efee0e99dd34a51fb1b7f63ba73120cd53b438db0c4441a597f7e44b812a729a963f9fc3bfc8bbefc68e0c1ca7f07869e11a1b';

describe('wallet bind (D8)', () => {
  it('derives the checksummed address of a key', () => {
    expect(walletAddressFromPrivateKey(PK)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(() => walletAddressFromPrivateKey('0x1234')).toThrow('32 bytes');
  });

  it('builds the registry\'s canonical message (address lowercased, no milliseconds)', () => {
    const msg = walletBindMessage({
      agentId: AGENT, address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', network: 'eip155:8453',
      issuedAt: new Date('2026-09-29T01:52:00.789Z'), nonce: '3f9c1a7e0b5d4c2a',
    });
    expect(msg).toBe(EXPECTED);
    expect(walletBindMessage({ agentId: AGENT, address: '0xAB', network: 'eip155:1' })).toMatch(/\nNonce: [0-9a-f]{16}\n/);
  });

  it('signs like personal_sign (byte-identical to viem, deterministic)', () => {
    expect(signWalletBindMessage(EXPECTED, PK)).toBe(VIEM_SIG);
    expect(signWalletBindMessage(EXPECTED, PK.slice(2))).toBe(VIEM_SIG);
  });
  it('recovers the signer of a plain-key signature; a smart-wallet signature recovers to nothing', () => {
    const message = EXPECTED;
    expect(recoverWalletBindSigner(message, signWalletBindMessage(message, PK))).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
    expect(recoverWalletBindSigner(message + ' ', signWalletBindMessage(message, PK))).not.toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
    expect(recoverWalletBindSigner(message, '0x' + 'cd'.repeat(200))).toBeNull();
  });
});
