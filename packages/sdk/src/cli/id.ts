/**
 * basedagents id — which identity this machine signs as.
 *
 * Reads the local keypair (same resolution as every signed command: --keypair
 * <file>, else the last *-keypair.json in ~/.basedagents/keys/) and looks the
 * agent up on the registry. The first step of the skill: an agent that already
 * has an identity reuses it instead of registering a second one.
 *
 * Prints the agent id, public key, keypair path and registry profile — never
 * the private key. Exit 1 when there is no local keypair (register first),
 * exit 2 when the key is not registered on this API.
 */
import { readFileSync } from 'node:fs';
import { RegistryClient, DEFAULT_API_URL, publicKeyToAgentId, base58Encode, ApiError, deserializeKeypair } from '../index.js';
import { resolveKeypairPath } from './wallet.js';

const R = '\x1b[0m';
const bold = (s: string) => `\x1b[1m${s}${R}`;
const dim = (s: string) => `\x1b[2m${s}${R}`;
const red = (s: string) => `\x1b[31m${s}${R}`;
const cyan = (s: string) => `\x1b[36m${s}${R}`;

const HELP = `
${bold('basedagents id')} ${dim('[--keypair <file>] [--json] [--api <url>]')}

Show the identity this machine signs as: agent id, public key, keypair file,
and the registry profile (name, status, wallet). Never prints the private key.

Exit codes: 0 registered · 1 no local keypair (run basedagents register) · 2 key not registered
`;

export async function id(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const flag = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
  const jsonMode = args.includes('--json');
  const keypairFile = flag('--keypair');
  const apiUrl = flag('--api') ?? process.env.BASEDAGENTS_API_URL ?? DEFAULT_API_URL;

  let kp;
  let keypairPath: string;
  try {
    keypairPath = resolveKeypairPath(keypairFile);
    kp = deserializeKeypair(readFileSync(keypairPath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No keypair found';
    if (jsonMode) console.log(JSON.stringify({ registered: false, agent_id: null, error: 'no_keypair', message }, null, 2));
    else console.error(red(`\n  ✗ ${message}\n`) + dim('  Register once: npx basedagents register --name "..." --description "..." --capabilities a,b\n'));
    process.exit(1);
  }

  const agentId = publicKeyToAgentId(kp.publicKey);
  const out: Record<string, unknown> = {
    registered: false,
    agent_id: agentId,
    public_key: base58Encode(kp.publicKey),
    keypair_path: keypairPath,
  };

  const client = new RegistryClient(apiUrl);
  let code = 0;
  try {
    const profile = await client.getAgent(agentId) as unknown as Record<string, unknown>;
    const agent = (profile.agent ?? profile) as Record<string, unknown>;
    out.registered = true;
    out.name = agent.name ?? null;
    out.status = agent.status ?? null;
    out.reputation_score = agent.reputation_score ?? null;
    out.wallet_address = agent.wallet_address ?? null;
    out.wallet_network = agent.wallet_network ?? null;
    out.profile_url = `https://basedagents.ai/agents/${agentId}`;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      code = 2;
      out.error = 'not_registered';
    } else {
      out.error = 'lookup_failed';
      out.message = err instanceof Error ? err.message : 'lookup failed';
      code = 1;
    }
  }

  // After the lookup, set the exit code and return instead of process.exit():
  // on Windows, exiting while libuv is still closing fetch's socket prints
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (src\win\async.c).
  if (jsonMode) {
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = code;
    return;
  }
  console.log('');
  console.log(`  ${dim('Agent ID')}    ${cyan(agentId)}`);
  console.log(`  ${dim('Public key')}  ${out.public_key}`);
  if (out.keypair_path) console.log(`  ${dim('Keypair')}     ${out.keypair_path}`);
  if (out.registered) {
    console.log(`  ${dim('Name')}        ${out.name}`);
    console.log(`  ${dim('Status')}      ${out.status}`);
    console.log(`  ${dim('Wallet')}      ${out.wallet_address ?? dim('not set — basedagents wallet set 0x... --network eip155:8453')}`);
  } else if (code === 2) {
    console.log(red('  Not registered on this registry.') + dim(' Register: npx basedagents register --name ... --description ... --capabilities ...'));
  } else {
    console.log(red(`  Could not look up the profile: ${out.message}`));
  }
  console.log('');
  process.exitCode = code;
}
