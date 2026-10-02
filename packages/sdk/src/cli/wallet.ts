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
import { walletBindMessage, signWalletBindMessage, walletAddressFromPrivateKey, recoverWalletBindSigner, WALLET_BIND_MAX_AGE_MS } from '../wallet-bind.js';

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
/**
 * Where bind messages wait between `wallet set` printing them and the signed
 * rerun: one file per message, named by its nonce, so concurrent commands never
 * rewrite each other's (no secrets: message text only). 0.9.4 kept a single
 * file, wallet-bind-pending.json, which is still read.
 */
function pendingBindDir(): string {
  return join(homedir(), '.basedagents', 'wallet-bind-pending');
}
function legacyPendingBindPath(): string {
  return join(homedir(), '.basedagents', 'wallet-bind-pending.json');
}
interface PendingBind { agent_id: string; address: string; network: string; message: string; created_at: string; file: string }
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** The `Nonce:` of a bind message (the name of its pending file). */
export function bindMessageNonce(message: string): string | null {
  const m = /^Nonce: ([A-Za-z0-9_-]{8,64})$/m.exec(message);
  return m ? m[1] : null;
}
/** Park a freshly printed bind message under its own nonce (exclusive create: nothing else is touched). */
function savePendingBind(p: Omit<PendingBind, 'file'>): void {
  const nonce = bindMessageNonce(p.message);
  if (!nonce) return;
  mkdirSync(pendingBindDir(), { recursive: true });
  writeFileSync(join(pendingBindDir(), `${nonce}.json`), JSON.stringify(p, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
/** The waiting bind messages for this agent, wallet and network that are still fresh; stale files are swept on the way. */
function pendingBinds(agentId: string, address: string, network: string, now = Date.now()): PendingBind[] {
  const files = existsSync(pendingBindDir())
    ? readdirSync(pendingBindDir()).filter((f) => f.endsWith('.json')).map((f) => join(pendingBindDir(), f))
    : [];
  if (existsSync(legacyPendingBindPath())) files.push(legacyPendingBindPath());
  const out: PendingBind[] = [];
  for (const file of files) {
    let p: Omit<PendingBind, 'file'>;
    try { p = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    if (typeof p?.message !== 'string' || !(now - Date.parse(p.created_at) <= WALLET_BIND_MAX_AGE_MS)) {
      try { unlinkSync(file); } catch { /* already gone */ }
      continue;
    }
    if (p.agent_id === agentId && p.address.toLowerCase() === address.toLowerCase() && p.network === network) out.push({ ...p, file });
  }
  return out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}
/** Best effort: never turns a finished command into a failure. */
function dropPendingBinds(list: PendingBind[]): void {
  for (const p of list) { try { unlinkSync(p.file); } catch { /* already gone */ } }
}
/** Circle's chain names (circle wallet ... --chain) for the networks a payout wallet can bind on. */
const CIRCLE_CHAINS: Record<string, string> = { 'eip155:8453': 'BASE', 'eip155:84532': 'BASE-SEPOLIA' };
/**
 * The Circle CLI command that signs a bind message with a Circle agent wallet,
 * or null off the networks Circle names. The message goes hex-encoded (--hex)
 * so its line breaks reach the signer exactly as the registry rebuilds them.
 */
export function circleSignCommand(message: string, address: string, network: string): string | null {
  const chain = CIRCLE_CHAINS[network];
  if (!chain) return null;
  return `circle wallet sign message 0x${Buffer.from(message, 'utf8').toString('hex')} --hex --address ${address} --chain ${chain}`;
}
/**
 * Circle's own fix when its CLI answers "Wallet not deployed": a zero-amount transfer
 * to itself deploys the wallet (Circle's paymaster covers the gas). The deployed
 * wallet then signs and is checked per ERC-1271.
 */
export function circleDeployCommand(address: string, network: string): string | null {
  const chain = CIRCLE_CHAINS[network];
  if (!chain) return null;
  return `circle wallet transfer ${address} --amount 0 --address ${address} --chain ${chain} --token usdc`;
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
                                              otherwise prints a link, the message to
                                              sign in your wallet, and the matching
                                              'circle wallet sign message' command for a
                                              Circle agent wallet, and exits ${EXIT_SIGNATURE_REQUIRED}
  basedagents wallet set 0x1234...abcd --signature 0x...
                                              Finish with the wallet's signature
  basedagents wallet clear                    Remove the wallet

${bold('Options:')}
  --network <chain>   eip155 chain (default: eip155:8453 = Base mainnet)
  --signature <0x..>  The wallet's personal_sign signature of the bind message
  --nonce <nonce>     Which printed message the signature is for (the signing
                      page's command includes it)
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
    const nonceFlag = flag('--nonce');
    const setCmd = `basedagents wallet set ${address}${network !== 'eip155:8453' ? ` --network ${network}` : ''}`;
    if (messageFlag) {
      message = readMessageFlag(messageFlag);
    } else {
      // The message this signature signed: named by --nonce, else the one a
      // plain-key signature recovers to, else the only one waiting.
      const waiting = pendingBinds(agentId, address, network);
      if (nonceFlag) {
        if (!NONCE_RE.test(nonceFlag)) {
          console.log(red(`\n  --nonce ${nonceFlag} is not a bind-message nonce.\n`));
          process.exit(1);
        }
        message = waiting.find((p) => bindMessageNonce(p.message) === nonceFlag)?.message;
      } else {
        message = waiting.find((p) => recoverWalletBindSigner(p.message, signature) === address.toLowerCase())?.message;
        if (!message && waiting.length > 1) {
          const nonces = waiting.map((p) => bindMessageNonce(p.message)).join(', ');
          console.log(red(`\n  ${waiting.length} bind messages are waiting for ${address} (nonces ${nonces}). Say which one was signed: ${setCmd} --nonce <nonce> --signature 0x... (the signing page's command includes it), or pass --message.\n`));
          process.exit(1);
        }
        if (!message) message = waiting[0]?.message;
      }
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
    try { pendingBinds(agentId, address, network); } catch { /* sweeping stale files is best effort */ }
    savePendingBind({ agent_id: agentId, address, network, message, created_at: new Date().toISOString() });
    const url = signPageUrl(message);
    const next = `basedagents wallet set ${address}${network !== 'eip155:8453' ? ` --network ${network}` : ''} --nonce ${bindMessageNonce(message)} --signature`;
    const circle = circleSignCommand(message, address, network);
    const circleDeploy = circleDeployCommand(address, network);
    if (jsonMode) {
      console.log(JSON.stringify({ signature_required: true, message, sign_url: url, circle_sign_command: circle, circle_deploy_command: circleDeploy, next: `${next} <0x...>` }, null, 2));
    } else {
      console.error('');
      console.error(`  ${bold('Sign to prove this wallet is yours.')} It costs nothing and moves no funds.`);
      console.error(`  Open this link and sign with the wallet (MetaMask, Coinbase Wallet, Rabby...):`);
      console.error(`    ${cyan(url)}`);
      console.error(`  ${dim('Or sign this exact message with personal_sign anywhere (it is valid for 15 minutes):')}`);
      console.error('');
      console.log(message);
      console.error('');
      if (circle && circleDeploy) {
        console.error(`  ${dim('With a Circle agent wallet, sign it with the Circle CLI:')}`);
        console.error(`    ${cyan(circle)}`);
        console.error(`  ${dim('If it answers "Wallet not deployed", deploy the wallet with a zero-amount transfer to itself, then sign again:')}`);
        console.error(`    ${cyan(circleDeploy)}`);
      }
      console.error(`  Then run: ${cyan(`${next} 0x...`)}`);
      console.error(`  ${dim('An agent with the wallet key can instead set BASEDAGENTS_WALLET_PRIVATE_KEY and rerun.')}`);
      console.error('');
    }
    process.exit(EXIT_SIGNATURE_REQUIRED);
  }

  try {
    const result = await client.setWallet(kp, { address, network, proof });
    // This wallet is bound: its waiting messages are done (best effort); others stay.
    try { dropPendingBinds(pendingBinds(agentId, address, network)); } catch { /* the bind stands */ }
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
