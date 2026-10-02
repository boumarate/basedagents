/**
 * basedagents init
 *
 * Interactive wizard for registering a new agent — like `npm init`.
 * Asks questions, shows a summary, generates a keypair, and registers.
 */

import { createInterface } from 'readline';
import { prepareNewKeypairPath, stageNewKeypair, commitNewKeypair, discardNewKeypair } from './wallet.js';
import { generateKeypair, serializeKeypair } from '../index.js';
import { RegistryClient, DEFAULT_API_URL, attributionFromEnv } from '../index.js';

// ─── ANSI ───
const R = '\x1b[0m';
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;

const DEFAULT_API = 'https://api.basedagents.ai';
const API_URL = DEFAULT_API_URL;

// ─── Readline helpers ───
function makeRl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function prompt(rl: ReturnType<typeof makeRl>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function askRequired(rl: ReturnType<typeof makeRl>, question: string): Promise<string> {
  while (true) {
    const answer = await prompt(rl, `  ${question} `);
    if (answer) return answer;
    console.log(red('  → This field is required.'));
  }
}

async function askOptional(rl: ReturnType<typeof makeRl>, question: string, defaultVal?: string): Promise<string> {
  const answer = await prompt(rl, `  ${question} `);
  return answer || defaultVal || '';
}

async function confirm(rl: ReturnType<typeof makeRl>, question: string): Promise<boolean> {
  const answer = await prompt(rl, `  ${question} `);
  if (!answer) return true; // default yes
  return answer.toLowerCase().startsWith('y');
}

// ─── PoW progress spinner ───
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIdx = 0;

function showProgress(attempts: number) {
  const spin = SPINNER[spinnerIdx++ % SPINNER.length];
  process.stdout.write(`\r    ${spin} Solving proof-of-work... ${cyan(attempts.toLocaleString())} hashes`);
}

// ─── Slugify for filename ───
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── Main init flow ───
export async function init(args: string[]): Promise<void> {
  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : API_URL;

  // Non-interactive guard
  if (!process.stdin.isTTY) {
    console.error(red('\n  ✗ basedagents init requires an interactive terminal.'));
    console.error(dim('    Use `basedagents register --manifest <file>` for non-interactive registration.\n'));
    process.exit(1);
  }

  // ── Banner ──
  console.log('');
  console.log(bold('🤖 basedagents init'));
  console.log(dim('Register your AI agent in 60 seconds.'));
  console.log('');

  const rl = makeRl();
  // A keypair staged on disk while its registration is in flight (see stageNewKeypair).
  let staged: string | undefined;

  // Graceful Ctrl+C
  rl.on('close', () => {});
  process.on('SIGINT', () => {
    console.log(dim('\n\n  Cancelled.\n'));
    rl.close();
    process.exit(0);
  });

  try {
    // ── Questions ──
    let name = await askRequired(rl, "What is your agent's name?");
    const description = await askRequired(rl, 'Describe what your agent does (1-2 sentences):');

    const capInput = await askOptional(rl, 'Capabilities? (e.g. code, research, content) [skip]:');
    const capabilities = capInput ? capInput.split(',').map(s => s.trim()).filter(Boolean) : [];

    const protoInput = await askOptional(rl, 'Protocols? (e.g. mcp, rest, openclaw) [skip]:');
    const ALLOWED_PROTOCOLS = ['mcp', 'rest', 'grpc', 'websocket', 'openclaw', 'a2a', 'http', 'https'];
    const rawProtocols = protoInput ? protoInput.split(',').map(s => s.trim()).filter(Boolean) : [];
    const invalidProtocols = rawProtocols.filter(p => !ALLOWED_PROTOCOLS.includes(p));
    if (invalidProtocols.length > 0) {
      console.log(`  ⚠ Unknown protocols ignored: ${invalidProtocols.join(', ')}`);
      console.log(`  Allowed: ${ALLOWED_PROTOCOLS.join(', ')}`);
    }
    const protocols = rawProtocols.filter(p => ALLOWED_PROTOCOLS.includes(p));

    const homepage = await askOptional(rl, 'Homepage URL? [skip]:');

    const apiEndpoint = await askOptional(rl, `Where should the API be? (default: ${DEFAULT_API}):`, DEFAULT_API);

    // ── Summary ──
    console.log('');
    console.log(bold('Ready to register:'));
    const rows: [string, string][] = [
      ['Name',         name],
      ['Description',  description.length > 60 ? description.slice(0, 60) + '…' : description],
      ...(capabilities.length ? [['Capabilities', capabilities.join(', ')]] as [string, string][] : []),
      ...(protocols.length    ? [['Protocols',    protocols.join(', ')]] as [string, string][] : []),
      ...(homepage            ? [['Homepage',     homepage]] as [string, string][] : []),
    ];
    for (const [k, v] of rows) {
      console.log(`  ${dim(k.padEnd(14))} ${v}`);
    }

    console.log('');
    console.log(dim('This will:'));
    console.log(dim('  • Generate an Ed25519 keypair'));
    console.log(dim('  • Solve a proof-of-work challenge (~3 seconds)'));
    console.log(dim('  • Register on basedagents.ai'));
    console.log(dim('  • Save your keypair locally'));
    console.log('');

    const proceed = await confirm(rl, 'Continue? (Y/n)');
    if (!proceed) {
      console.log('');
      console.log(dim('No problem. Run `basedagents init` when ready.'));
      console.log('');
      rl.close();
      return;
    }

    // ── Generate keypair ──
    console.log('');
    process.stdout.write('  Generating Ed25519 keypair...');
    const keypair = await generateKeypair();
    console.log(` ${green('✓')}`);

    // ── Register ──
    const effectiveApi = apiEndpoint || apiUrl;
    const client = new RegistryClient(effectiveApi);

    const profile = {
      name,
      description,
      capabilities: capabilities.length ? capabilities : ['general'],
      protocols: protocols.length ? protocols : ['https'],
      ...(homepage ? { homepage } : {}),
    };

    // Prepare keypair path (BASEDAGENTS_KEYPAIR_PATH when it names no file yet)
    let slug = slugify(name) || 'agent';
    const target = prepareNewKeypairPath(slug);
    let keypairPath = target.path;
    if (target.envInUse) console.log(yellow(`  ⚠ BASEDAGENTS_KEYPAIR_PATH names an existing keypair (${target.envInUse}). This one is saved to ${keypairPath}; signed commands keep using the variable's key until you change it.`));
    // On disk under a temporary name before the proof-of-work; renamed once registered.
    staged = stageNewKeypair(keypairPath, serializeKeypair(keypair));

    let agent: Awaited<ReturnType<typeof client.register>>;
    while (true) {
      process.stdout.write('  Registering...');
      try {
        agent = await client.register(keypair, profile, { onProgress: showProgress, attribution: { interface: 'cli', ...attributionFromEnv() } });
        console.log(` ${green('✓')}`);
        break;
      } catch (err: unknown) {
        console.log(` ${red('✗')}`);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('409') || msg.toLowerCase().includes('already taken')) {
          console.log(red(`  Name "${name}" is already taken.`));
          name = await askRequired(rl, 'Pick another name:');
          profile.name = name;
          // Recalculate keypair path for new name
          slug = slugify(name) || 'agent';
          keypairPath = prepareNewKeypairPath(slug).path;
          continue;
        }
        throw err;
      }
    }

    keypairPath = commitNewKeypair(staged, keypairPath, slug);
    staged = undefined;

    // ── Success ──
    console.log('');
    console.log(green(bold('✅ Registered!')));
    console.log('');
    console.log(`  ${dim('Agent ID:')}  ${cyan(agent.id)}`);
    console.log(`  ${dim('Profile:')}   ${cyan(`https://basedagents.ai/agent/${encodeURIComponent(name)}`)}`);
    console.log(`  ${dim('Keypair:')}   ${cyan(keypairPath)}`);
    console.log('');
    console.log(bold('Next steps:'));
    console.log(`  • View your profile: ${cyan(`npx basedagents whois ${name}`)}`);
    console.log(`  • Add MCP server:    ${cyan('npx -y @basedagents/mcp')}`);
    console.log(`  • Set ${cyan('BASEDAGENTS_KEYPAIR_PATH')} for authenticated operations`);
    console.log('');

  } catch (err: unknown) {
    if (staged) discardNewKeypair(staged);
    console.log('');
    const msg = err instanceof Error ? err.message : String(err);
    console.log(red(`  ✗ ${msg}`));
    console.log('');
    process.exit(1);
  } finally {
    rl.close();
  }
}
