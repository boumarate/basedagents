/**
 * `basedagents wallet set / clear` (decision D8): the wallet must sign a bind
 * message. Stubbed fetch, process.exit throws, HOME in a temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateKeypair, serializeKeypair, publicKeyToAgentId, type AgentKeypair } from '../index.js';
import { signWalletBindMessage } from '../wallet-bind.js';
import { wallet, EXIT_SIGNATURE_REQUIRED, signPageUrl } from './wallet.js';

class ExitSignal extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, statusText: String(status), headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

/** Hardhat account #0 — a public test key. */
const WALLET_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

let dir: string; let keypairPath: string; let kp: AgentKeypair; let agentId: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ba-wallet-'));
  kp = await generateKeypair();
  agentId = publicKeyToAgentId(kp.publicKey);
  keypairPath = join(dir, 'k-keypair.json');
  writeFileSync(keypairPath, serializeKeypair(kp));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fetchMock: ReturnType<typeof vi.fn>;
let out: string[]; let err: string[];
beforeEach(() => {
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
  vi.stubEnv('BASEDAGENTS_WALLET_PRIVATE_KEY', '');
  fetchMock = vi.fn().mockResolvedValue(ok({ agent_id: 'x', wallet_address: WALLET_ADDR, wallet_network: 'eip155:8453', wallet_verified: true, signer_kind: 'eoa' }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitSignal(Number(c ?? 0)); }) as never);
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
});
afterEach(() => {
  expect((out.join('\n') + err.join('\n')).toLowerCase()).not.toContain(WALLET_KEY.slice(2).toLowerCase());
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  rmSync(join(dir, '.basedagents'), { recursive: true, force: true });
});

interface WalletBody { wallet_address: string | null; wallet_network?: string; wallet_proof: { message: string; signature: string } }
const pendingFiles = () => { const d = join(dir, '.basedagents', 'wallet-bind-pending'); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : []; };
const bodyOf = (call = 0) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as WalletBody;

describe('basedagents wallet set', () => {
  it('signs with BASEDAGENTS_WALLET_PRIVATE_KEY and sends the proof (the key is never printed)', async () => {
    vi.stubEnv('BASEDAGENTS_WALLET_PRIVATE_KEY', WALLET_KEY);
    await wallet(['set', WALLET_ADDR, '--keypair', keypairPath, '--json']);
    const body = bodyOf();
    expect(body.wallet_address).toBe(WALLET_ADDR);
    expect(body.wallet_proof.message).toContain(`Agent: ${agentId}`);
    expect(body.wallet_proof.signature).toBe(signWalletBindMessage(body.wallet_proof.message, WALLET_KEY));
  });

  it('refuses a key that belongs to another address', async () => {
    vi.stubEnv('BASEDAGENTS_WALLET_PRIVATE_KEY', WALLET_KEY);
    await expect(wallet(['set', '0x' + '11'.repeat(20), '--keypair', keypairPath])).rejects.toMatchObject({ code: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('without a key: prints the message and a signing link, exits 2; --signature then finishes it', async () => {
    await expect(wallet(['set', WALLET_ADDR, '--keypair', keypairPath, '--json'])).rejects.toMatchObject({ code: EXIT_SIGNATURE_REQUIRED });
    expect(fetchMock).not.toHaveBeenCalled();
    const printed = JSON.parse(out.join('\n')) as { message: string; sign_url: string };
    expect(printed.sign_url).toBe(signPageUrl(printed.message));
    expect(pendingFiles()).toHaveLength(1);

    out = [];
    const signature = signWalletBindMessage(printed.message, WALLET_KEY); // what the wallet app would return
    await wallet(['set', WALLET_ADDR, '--signature', signature, '--keypair', keypairPath, '--json']);
    expect(bodyOf().wallet_proof).toEqual({ message: printed.message, signature });
    expect(pendingFiles()).toHaveLength(0);
  });

  it('--json names a non-default network in the next step (the pending message is keyed by it)', async () => {
    await expect(wallet(['set', WALLET_ADDR, '--network', 'eip155:84532', '--keypair', keypairPath, '--json'])).rejects.toMatchObject({ code: EXIT_SIGNATURE_REQUIRED });
    const printed = JSON.parse(out.join('\n')) as { next: string };
    expect(printed.next).toMatch(new RegExp(`^basedagents wallet set ${WALLET_ADDR} --network eip155:84532 --nonce [0-9a-f]{16} --signature <0x\\.\\.\\.>$`));
  });

    it('a second unsigned `wallet set` keeps the first message: its signature still finishes the bind', async () => {
    await expect(wallet(['set', WALLET_ADDR, '--keypair', keypairPath, '--json'])).rejects.toMatchObject({ code: EXIT_SIGNATURE_REQUIRED });
    const first = (JSON.parse(out.join('\n')) as { message: string }).message;
    out = [];
    await expect(wallet(['set', WALLET_ADDR, '--keypair', keypairPath, '--json'])).rejects.toMatchObject({ code: EXIT_SIGNATURE_REQUIRED });
    const second = (JSON.parse(out.join('\n')) as { message: string }).message;
    expect(second).not.toBe(first);

    out = [];
    await wallet(['set', WALLET_ADDR, '--signature', signWalletBindMessage(first, WALLET_KEY), '--keypair', keypairPath, '--json']);
    expect(bodyOf().wallet_proof.message).toBe(first);
    expect(pendingFiles()).toHaveLength(0); // this wallet's messages are done
  });

  it('each unsigned `wallet set` parks its own file; a smart-wallet signature is paired by --nonce, never guessed', async () => {
    const printed: string[] = [];
    for (let i = 0; i < 2; i++) {
      out = [];
      await expect(wallet(['set', WALLET_ADDR, '--keypair', keypairPath, '--json'])).rejects.toMatchObject({ code: EXIT_SIGNATURE_REQUIRED });
      printed.push((JSON.parse(out.join('\n')) as { message: string }).message);
    }
    expect(pendingFiles()).toHaveLength(2);
    const smartSig = '0x' + 'cd'.repeat(200); // an ERC-1271 signature: nothing to recover locally

    out = [];
    await expect(wallet(['set', WALLET_ADDR, '--signature', smartSig, '--keypair', keypairPath])).rejects.toMatchObject({ code: 1 });
    expect(out.join('\n')).toContain('--nonce');
    expect(fetchMock).not.toHaveBeenCalled();

    const firstNonce = /^Nonce: (\S+)$/m.exec(printed[0])![1];
    await wallet(['set', WALLET_ADDR, '--nonce', firstNonce, '--signature', smartSig, '--keypair', keypairPath, '--json']);
    expect(bodyOf().wallet_proof).toEqual({ message: printed[0], signature: smartSig });
    expect(pendingFiles()).toHaveLength(0);
  });

  it('an unsigned `wallet set` sweeps pending files older than 15 minutes', async () => {
    const { mkdirSync } = await import('fs');
    const d = join(dir, '.basedagents', 'wallet-bind-pending');
    mkdirSync(d, { recursive: true });
    const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    writeFileSync(join(d, 'stalenonce01.json'), JSON.stringify({ agent_id: 'ag_other', address: '0x' + '11'.repeat(20), network: 'eip155:8453', message: 'x', created_at: old }));
    await expect(wallet(['set', WALLET_ADDR, '--keypair', keypairPath, '--json'])).rejects.toMatchObject({ code: EXIT_SIGNATURE_REQUIRED });
    expect(pendingFiles()).toHaveLength(1);
    expect(pendingFiles()[0]).not.toBe('stalenonce01.json');
  });

  it('reads a pending message left by an older CLI (one object, not a list)', async () => {
    const message = ['BasedAgents payout wallet', `Agent: ${agentId}`, `Wallet: ${WALLET_ADDR.toLowerCase()}`, 'Network: eip155:8453', `Issued: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`, 'Nonce: 0123456789abcdef', '', "Signing proves you control this wallet and lets BasedAgents pay this agent's bounties to it. It moves no funds."].join('\n');
    const { mkdirSync } = await import('fs');
    mkdirSync(join(dir, '.basedagents'), { recursive: true });
    writeFileSync(join(dir, '.basedagents', 'wallet-bind-pending.json'), JSON.stringify({ agent_id: agentId, address: WALLET_ADDR, network: 'eip155:8453', message, created_at: new Date().toISOString() }));
    await wallet(['set', WALLET_ADDR, '--signature', signWalletBindMessage(message, WALLET_KEY), '--keypair', keypairPath, '--json']);
    expect(bodyOf().wallet_proof.message).toBe(message);
  });

  it('--signature with no pending message for that address asks for one', async () => {
    await expect(wallet(['set', WALLET_ADDR, '--signature', '0x' + 'ab'.repeat(65), '--keypair', keypairPath])).rejects.toMatchObject({ code: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('No bind message');
  });

  it('--message @file supplies the signed message explicitly', async () => {
    const msgFile = join(dir, 'bind.txt');
    const message = ['BasedAgents payout wallet', `Agent: ${agentId}`, `Wallet: ${WALLET_ADDR.toLowerCase()}`, 'Network: eip155:8453', 'Issued: 2026-09-29T01:52:00Z', 'Nonce: 3f9c1a7e0b5d4c2a', '', "Signing proves you control this wallet and lets BasedAgents pay this agent's bounties to it. It moves no funds."].join('\n');
    writeFileSync(msgFile, message + '\n');
    await wallet(['set', WALLET_ADDR, '--message', `@${msgFile}`, '--signature', '0x' + 'cd'.repeat(65), '--keypair', keypairPath, '--json']);
    expect(bodyOf().wallet_proof.message).toBe(message);
    expect(readFileSync(msgFile, 'utf8')).toBe(message + '\n');
  });
});

describe('basedagents wallet clear', () => {
  it('PATCHes wallet_address null', async () => {
    await wallet(['clear', '--keypair', keypairPath, '--json']);
    expect(bodyOf()).toEqual({ wallet_address: null });
  });
});
