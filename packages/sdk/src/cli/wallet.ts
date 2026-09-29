/**
 * basedagents wallet [set <address>] [--network eip155:8453]
 *
 * Get or set your agent's wallet address.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, openSync, closeSync, writeFileSync, linkSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { dirname, isAbsolute, join, win32 } from 'path';
import { RegistryClient, DEFAULT_API_URL, deserializeKeypair, publicKeyToAgentId, ApiError, type AgentKeypair, type WalletInfo } from '../index.js';
import { walletBindMessage, signWalletBindMessage, walletAddressFromPrivateKey } from '../wallet-bind.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;

const API_URL = DEFAULT_API_URL;

/**
 * Load the agent keypair the CLI signs with, from the file `resolveKeypairPath`
 * picks. Shared by every authenticated command.
 */
export function loadKeypair(keypairFile?: string): AgentKeypair {
  return deserializeKeypair(readFileSync(resolveKeypairPath(keypairFile), 'utf8'));
}

/**
 * Whether a --keypair value names a file by path rather than by name inside
 * ~/.basedagents/keys/: it has a directory part in either separator, or it is
 * absolute (POSIX, a Windows drive path, or a UNC path). A Windows path such as
 * `C:\Users\me\.basedagents\keys\me-keypair.json` has no `/` at all.
 */
export function isKeypairPath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || isAbsolute(value) || win32.isAbsolute(value);
}

/**
 * The file `loadKeypair` reads, in order:
 *   1. --keypair: a path, or a filename in ~/.basedagents/keys/;
 *   2. BASEDAGENTS_KEYPAIR_PATH, the variable the MCP server reads (and that
 *      `basedagents init` tells you to set);
 *   3. the last `*-keypair.json` in ~/.basedagents/keys/ (the order readdirSync
 *      returns, which is sorted).
 * Shared with `basedagents id` so the path it reports is the key it used.
 * Warnings go to stderr so a command's `--json` stdout stays one parseable object.
 */
export function resolveKeypairPath(keypairFile?: string, env: NodeJS.ProcessEnv = process.env): string {
  const keysDir = join(homedir(), '.basedagents', 'keys');
  if (keypairFile) return isKeypairPath(keypairFile) ? keypairFile : join(keysDir, keypairFile);
  const fromEnv = env.BASEDAGENTS_KEYPAIR_PATH?.trim();
  if (fromEnv) return fromEnv;
  let files: string[];
  try {
    // readdirSync already returns names sorted (libuv scandir, strcmp), so this is
    // the same "last alphabetical" file every earlier CLI picked; no re-sort, so
    // an upgrade can never switch which identity signs.
    files = readdirSync(keysDir).filter(f => f.endsWith('-keypair.json'));
  } catch {
    throw new Error(`No keypairs found in ${keysDir}. Register first: npx basedagents register`);
  }
  if (files.length === 0) {
    throw new Error(`No keypairs found in ${keysDir}. Register first: npx basedagents register`);
  }
  // Use the last alphabetical keypair; warn if multiple exist (NEW-2)
  if (files.length > 1) {
    console.error(yellow(`  ⚠ Multiple keypairs found. Using: ${files[files.length - 1]}`));
    console.error(yellow(`  To use a specific keypair, pass --keypair <file> or set BASEDAGENTS_KEYPAIR_PATH`));
  }
  return join(keysDir, files[files.length - 1]);
}

/**
 * Where a new registration saves its keypair, chosen before the proof-of-work
 * (its directory is created here, so an unwritable location fails before the
 * registration rather than after it). BASEDAGENTS_KEYPAIR_PATH wins when it is
 * set and names no file yet: that is where every signed command will look.
 * Otherwise ~/.basedagents/keys/<slug>-keypair.json, numbered past any existing
 * file. `envInUse` is set when the variable names an existing file; the new key
 * then goes to the keys directory, and signed commands keep using the
 * variable's key until it changes.
 */
export function prepareNewKeypairPath(slug: string, env: NodeJS.ProcessEnv = process.env): { path: string; envInUse?: string } {
  const fromEnv = env.BASEDAGENTS_KEYPAIR_PATH?.trim();
  if (fromEnv && !existsSync(fromEnv)) {
    mkdirSync(dirname(fromEnv), { recursive: true });
    return { path: fromEnv };
  }
  const keysDir = join(homedir(), '.basedagents', 'keys');
  mkdirSync(keysDir, { recursive: true });
  let path = join(keysDir, `${slug}-keypair.json`);
  for (let i = 2; existsSync(path); i++) path = join(keysDir, `${slug}-${i}-keypair.json`);
  return fromEnv ? { path, envInUse: fromEnv } : { path };
}

/**
 * Create `target` (mode 0600) holding `contents`, never replacing a file and
 * never leaving a partial one: the create is exclusive (EEXIST if the name is
 * taken), and a write that fails midway (disk full) removes the file it made.
 */
function writeNewFile(target: string, contents: string): void {
  const fd = openSync(target, 'wx', 0o600);
  let written = false;
  try {
    writeFileSync(fd, contents);
    written = true;
  } finally {
    closeSync(fd);
    if (!written) { try { unlinkSync(target); } catch { /* already gone */ } }
  }
}

/**
 * Put a new keypair on disk BEFORE registering it, so a registration that
 * succeeds can never lose its key. The file (mode 0600) sits next to `path`
 * under a temporary name that no keypair lookup matches
 * (`<path>.pending-<pid>-<random>`). After the API accepts the key,
 * commitNewKeypair gives it its final name; if registration fails,
 * discardNewKeypair removes it. Throws, before anything is registered, when
 * the location can't be written.
 */
export function stageNewKeypair(path: string, contents: string): string {
  const staged = `${path}.pending-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeNewFile(staged, contents);
  return staged;
}

/**
 * Give a staged keypair its final name without ever replacing a file or
 * exposing a partial one, and return where it ended up: `path` when it is
 * still free; else a fresh numbered file in ~/.basedagents/keys/; else the
 * staged file itself, which already holds the key. A hard link is tried first
 * (atomic: the whole file appears at once, or nothing does); where links
 * aren't supported, or across filesystems, the file is written anew.
 */
export function commitNewKeypair(staged: string, path: string, slug: string): string {
  const contents = readFileSync(staged, 'utf8');
  const candidates: Array<() => string> = [() => path, () => prepareNewKeypairPath(slug, {}).path];
  for (const next of candidates) {
    try {
      const target = next();
      try {
        linkSync(staged, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err;
        writeNewFile(target, contents);
      }
      discardNewKeypair(staged);
      if (target !== path) console.error(yellow(`  ⚠ Could not write ${path}; the keypair was saved to ${target} instead.`));
      return target;
    } catch { /* try the next location */ }
  }
  console.error(yellow(`  ⚠ Could not write ${path} or ~/.basedagents/keys/; the keypair stays at ${staged}. Rename it to end in -keypair.json, or pass it with --keypair.`));
  return staged;
}

/** Remove a staged keypair whose registration failed (never registered, so nothing is lost). */
export function discardNewKeypair(staged: string): void {
  try { unlinkSync(staged); } catch { /* already gone */ }
}

/** Exit code when a signature is needed before the wallet can be set (same convention as the payment flows). */
export const EXIT_SIGNATURE_REQUIRED = 2;
/** Where a bind message waits between `wallet set` printing it and the signed rerun. No secrets: message text only. */
function pendingBindPath(): string {
  return join(homedir(), '.basedagents', 'wallet-bind-pending.json');
}
/** The browser page that asks a wallet to sign a bind message (the message rides in the URL fragment, never sent to a server). */
export function signPageUrl(message: string): string {
  return `https://app.basedagents.ai/sign-wallet#m=${Buffer.from(message, 'utf8').toString('base64url')}`;
}
/** Read --message: literal text, @file, or - for stdin. */
function readMessageFlag(value: string): string {
  if (value === '-') return readFileSync(0, 'utf8').replace(/\n$/, '');
  if (value.startsWith('@')) return readFileSync(value.slice(1), 'utf8').replace(/\n$/, '');
  return value;
}

export async function wallet(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${bold('basedagents wallet')} ${dim('[set <address> | clear]')}

Show, set or clear your agent's payout wallet (bounties are paid there in USDC).
Setting it needs a signature from the wallet, which proves it is yours.

${bold('Usage:')}
  basedagents wallet                          Show the current wallet
  basedagents wallet set 0x1234...abcd        Set it. Signs with the key in
                                              $BASEDAGENTS_WALLET_PRIVATE_KEY when set
                                              (read locally, never sent or printed);
                                              otherwise prints a link and the message
                                              to sign in your wallet, and exits ${EXIT_SIGNATURE_REQUIRED}
  basedagents wallet set 0x1234...abcd --signature 0x...
                                              Finish with the wallet's signature
  basedagents wallet clear                    Remove the wallet

${bold('Options:')}
  --network <chain>   eip155 chain (default: eip155:8453 = Base mainnet)
  --signature <0x..>  The wallet's personal_sign signature of the bind message
  --message <v>       The signed bind message (text, @file or - for stdin);
                      default: the one the last 'wallet set' printed
  --keypair <file>    Path to keypair file (or filename in ~/.basedagents/keys/);
                      default $BASEDAGENTS_KEYPAIR_PATH, else the last key there
  --json              Output raw JSON
  --api <url>         Custom API endpoint
`);
    process.exit(0);
  }

  const flag = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
  const apiUrl = flag('--api') ?? API_URL;
  const jsonMode = args.includes('--json');
  const keypairFile = flag('--keypair');
  const client = new RegistryClient(apiUrl);
  const subcommand = args[0];

  let kp: AgentKeypair;
  try { kp = loadKeypair(keypairFile); } catch (err) {
    console.log(red(`\n  ${err instanceof Error ? err.message : 'Failed to load keypair'}\n`));
    process.exit(1);
  }
  const agentId = publicKeyToAgentId(kp.publicKey);

  const printWallet = (result: WalletInfo, heading?: string) => {
    if (jsonMode) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log('');
    if (heading) console.log(`  ${green('✓')} ${heading}`);
    console.log(`  ${dim('Agent ID')}   ${cyan(result.agent_id)}`);
    if (result.wallet_address) {
      console.log(`  ${dim('Address')}    ${result.wallet_address}`);
      console.log(`  ${dim('Network')}    ${result.wallet_network ?? 'eip155:8453'}`);
      console.log(`  ${dim('Verified')}   ${result.wallet_verified ? green('yes (signed by the wallet)') : yellow('no — set it again to prove control')}`);
    } else {
      console.log(`  ${dim('No wallet set. Use:')} basedagents wallet set 0x...`);
    }
    console.log('');
  };

  if (subcommand === 'clear') {
    try {
      printWallet(await client.clearWallet(kp), 'Wallet removed');
    } catch (err) {
      console.log(red(`\n  Failed to clear wallet: ${err instanceof Error ? err.message : 'unknown error'}\n`));
      process.exit(1);
    }
    return;
  }

  if (subcommand !== 'set') {
    try {
      printWallet(await client.getWallet(agentId));
    } catch (err) {
      console.log(red(`\n  Failed to fetch wallet: ${err instanceof Error ? err.message : 'unknown error'}\n`));
      process.exit(1);
    }
    return;
  }

  const address = args[1];
  if (!address || !(/^0x[a-fA-F0-9]{40}$/.test(address))) {
    console.log(red('\n  Invalid wallet address. Must be a 0x-prefixed 40-hex-char EVM address.\n'));
    process.exit(1);
  }
  const network = flag('--network') ?? 'eip155:8453';
  if (!/^eip155:\d+$/.test(network)) {
    console.log(red(`\n  --network must be an EVM chain like eip155:8453 (got ${network}).\n`));
    process.exit(1);
  }

  // The proof: an explicit signature (with the message it signs), a local key, or neither yet.
  let proof: { message: string; signature: string } | null = null;
  const signature = flag('--signature');
  const walletKey = process.env.BASEDAGENTS_WALLET_PRIVATE_KEY?.trim();
  if (signature) {
    let message: string | undefined;
    const messageFlag = flag('--message');
    if (messageFlag) {
      message = readMessageFlag(messageFlag);
    } else if (existsSync(pendingBindPath())) {
      const pending = JSON.parse(readFileSync(pendingBindPath(), 'utf8')) as { agent_id: string; address: string; network: string; message: string };
      if (pending.agent_id === agentId && pending.address.toLowerCase() === address.toLowerCase() && pending.network === network) message = pending.message;
    }
    if (!message) {
      console.log(red(`\n  No bind message for ${address} on ${network}. Run: basedagents wallet set ${address}${network !== 'eip155:8453' ? ` --network ${network}` : ''} (it prints one to sign), or pass --message.\n`));
      process.exit(1);
    }
    proof = { message, signature };
  } else if (walletKey) {
    let keyAddress: string;
    try { keyAddress = walletAddressFromPrivateKey(walletKey); } catch {
      console.log(red('\n  BASEDAGENTS_WALLET_PRIVATE_KEY is not a 32-byte hex secp256k1 key.\n'));
      process.exit(1);
    }
    if (keyAddress.toLowerCase() !== address.toLowerCase()) {
      console.log(red(`\n  BASEDAGENTS_WALLET_PRIVATE_KEY is the key of ${keyAddress}, not ${address}.\n`));
      process.exit(1);
    }
    const message = walletBindMessage({ agentId, address, network });
    proof = { message, signature: signWalletBindMessage(message, walletKey) };
  }

  if (!proof) {
    const message = walletBindMessage({ agentId, address, network });
    mkdirSync(dirname(pendingBindPath()), { recursive: true });
    writeFileSync(pendingBindPath(), JSON.stringify({ agent_id: agentId, address, network, message, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    const url = signPageUrl(message);
    if (jsonMode) {
      console.log(JSON.stringify({ signature_required: true, message, sign_url: url, next: `basedagents wallet set ${address}${network !== 'eip155:8453' ? ` --network ${network}` : ''} --signature <0x...>` }, null, 2));
    } else {
      console.error('');
      console.error(`  ${bold('Sign to prove this wallet is yours.')} It costs nothing and moves no funds.`);
      console.error(`  Open this link and sign with the wallet (MetaMask, Coinbase Wallet, Rabby...):`);
      console.error(`    ${cyan(url)}`);
      console.error(`  ${dim('Or sign this exact message with personal_sign anywhere (it is valid for 15 minutes):')}`);
      console.error('');
      console.log(message);
      console.error('');
      console.error(`  Then run: ${cyan(`basedagents wallet set ${address}${network !== 'eip155:8453' ? ` --network ${network}` : ''} --signature 0x...`)}`);
      console.error(`  ${dim('An agent with the wallet key can instead set BASEDAGENTS_WALLET_PRIVATE_KEY and rerun.')}`);
      console.error('');
    }
    process.exit(EXIT_SIGNATURE_REQUIRED);
  }

  try {
    const result = await client.setWallet(kp, { address, network, proof });
    try { unlinkSync(pendingBindPath()); } catch { /* none pending */ }
    printWallet(result, 'Wallet set and verified');
  } catch (err) {
    const body = err instanceof ApiError ? (err.body as { error?: string; reason?: string; message?: string } | undefined) : undefined;
    if (body?.error === 'wallet_proof_invalid' && body.reason === 'expired') {
      console.log(red(`\n  The signed message expired (15 minutes). Run basedagents wallet set ${address} again for a fresh one.\n`));
    } else {
      console.log(red(`\n  Failed to set wallet: ${err instanceof Error ? err.message : 'unknown error'}\n`));
    }
    process.exit(1);
  }
}
