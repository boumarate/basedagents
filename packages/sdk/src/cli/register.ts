/**
 * basedagents register
 *
 * Interactive terminal flow for registering a new agent.
 * Generates a keypair, prompts for profile info, solves PoW, and submits.
 */

import { createInterface } from 'readline';
import { prepareNewKeypairPath, stageNewKeypair, commitNewKeypair, discardNewKeypair } from './wallet.js';
import { generateKeypair, serializeKeypair } from '../index.js';
import { RegistryClient, DEFAULT_API_URL, attributionFromEnv } from '../index.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;

const API_URL = DEFAULT_API_URL;

// ─── Readline helpers ───
function makeRl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function prompt(rl: ReturnType<typeof makeRl>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function ask(rl: ReturnType<typeof makeRl>, label: string, defaultVal?: string, required = false): Promise<string> {
  const hint = defaultVal ? dim(` (${defaultVal})`) : required ? dim(' (required)') : dim(' (optional, Enter to skip)');
  while (true) {
    const answer = await prompt(rl, `  ${label}${hint}: `);
    const value = answer || defaultVal || '';
    if (required && !value) {
      console.log(red(`  → Required.`));
      continue;
    }
    return value;
  }
}

async function confirm(rl: ReturnType<typeof makeRl>, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? dim('Y/n') : dim('y/N');
  const answer = await prompt(rl, `  ${question} [${hint}]: `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

// ─── PoW progress spinner ───
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIdx = 0;

function showProgress(attempts: number) {
  const spin = SPINNER[spinnerIdx++ % SPINNER.length];
  process.stdout.write(`\r  ${spin} Solving proof-of-work... ${cyan(attempts.toLocaleString())} hashes`);
}

// ─── Slugify for filename ───
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── Non-interactive registration (manifest file or flags) ───

/** `register --manifest <file>`: the profile is the manifest's `identity` block (or the whole file). */
async function registerFromManifest(manifestPath: string, apiUrl: string, dryRun: boolean, jsonMode: boolean): Promise<void> {
  const { readFileSync } = await import('fs');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    console.error(red(`  ✗ Could not read manifest: ${manifestPath}`));
    process.exit(1);
  }
  const m = raw as Record<string, unknown>;
  await registerNonInteractive((m.identity ?? m) as Record<string, unknown>, apiUrl, dryRun, jsonMode);
}

/** `register --name N --description D --capabilities a,b [--protocols https]`: one line, no prompts. */
function identityFromFlags(args: string[]): Record<string, unknown> | null {
  const flag = (f: string) => { const i = args.indexOf(f); return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined; };
  const list = (v: string | undefined) => v?.split(',').map((x) => x.trim()).filter(Boolean);
  const name = flag('--name');
  if (name === undefined) return null;
  return {
    name,
    description: flag('--description') ?? '',
    capabilities: list(flag('--capabilities')) ?? [],
    ...(flag('--protocols') ? { protocols: list(flag('--protocols')) } : {}),
    ...(flag('--homepage') ? { homepage: flag('--homepage') } : {}),
  };
}

/**
 * Register without prompts. With `jsonMode`, stdout carries exactly one JSON
 * object ({ agent_id, name, status, keypair_path, profile_url }) and every
 * human-facing line goes to stderr, so an agent can parse the result. The
 * private key is written to the keypair file and never printed.
 */
async function registerNonInteractive(identity: Record<string, unknown>, apiUrl: string, dryRun: boolean, jsonMode: boolean): Promise<void> {
  const say = (line = '') => (jsonMode ? process.stderr.write(line + '\n') : console.log(line));
  const name          = String(identity.name ?? '');
  const description   = String(identity.description ?? '');
  const capabilities  = (identity.capabilities as string[] | undefined) ?? [];
  const protocols     = (identity.protocols as string[] | undefined) ?? ['https'];
  const version       = String(identity.version ?? '1.0.0');
  const homepage      = identity.homepage ? String(identity.homepage) : undefined;
  const contactEndpoint = (identity.contact_endpoint ?? identity.contactEndpoint)
    ? String(identity.contact_endpoint ?? identity.contactEndpoint)
    : undefined;
  const organization  = identity.organization ? String(identity.organization) : undefined;
  const skills        = ((identity.skills as Array<{ name: string; registry?: string }> | undefined) ?? [])
    .map(s => ({ name: s.name, registry: (s.registry ?? 'npm') as 'npm' | 'pypi' | 'cargo' | 'clawhub' }));
  const tags          = (identity.tags as string[] | undefined) ?? [];
  const offers        = (identity.offers as string[] | undefined) ?? [];
  const needs         = (identity.needs as string[] | undefined) ?? [];

  if (!name || !description || !capabilities.length) {
    console.error(red('  ✗ A profile needs a name, a description, and at least one capability.'));
    console.error(dim('    basedagents register --name "My Agent" --description "What it does" --capabilities research,code'));
    process.exit(1);
  }

  say('');
  say(bold('basedagents register') + dim(' (non-interactive)'));
  say('');
  say(`  ${dim('Name')}          ${name}`);
  say(`  ${dim('Description')}  ${description.slice(0, 70)}${description.length > 70 ? '…' : ''}`);
  say(`  ${dim('Capabilities')} ${capabilities.join(', ')}`);
  say(`  ${dim('Protocols')}    ${protocols.join(', ')}`);
  if (contactEndpoint) say(`  ${dim('Endpoint')}     ${contactEndpoint}`);
  say('');

  if (dryRun) {
    say(dim('  --dry-run: stopping here.\n'));
    if (jsonMode) console.log(JSON.stringify({ dry_run: true, profile: { name, description, capabilities, protocols } }, null, 2));
    return;
  }

  // Keypair
  if (!jsonMode) process.stdout.write('  Generating Ed25519 keypair...');
  const keypair = await generateKeypair();
  if (!jsonMode) console.log(` ${green('✓')}`);

  // The key goes on disk under a temporary name before the proof-of-work, and
  // gets its final name only once the registry accepts it: a failed
  // registration leaves no key file, a successful one can't lose its key.
  const slug = slugify(name) || 'agent';
  let keypairPath: string;
  let staged: string;
  try {
    const target = prepareNewKeypairPath(slug);
    keypairPath = target.path;
    if (target.envInUse) say(yellow(`  ⚠ BASEDAGENTS_KEYPAIR_PATH names an existing keypair (${target.envInUse}). This one is saved to ${keypairPath}; signed commands keep using the variable's key until you change it.`));
    staged = stageNewKeypair(keypairPath, serializeKeypair(keypair));
  } catch (err: unknown) {
    console.error(red(`  ✗ Can't save a keypair there: ${err instanceof Error ? err.message : String(err)}. Nothing was registered.\n`));
    process.exit(1);
  }
  const client = new RegistryClient(apiUrl);
  const profile = {
    name, description, capabilities, protocols, version,
    ...(homepage        ? { homepage }                          : {}),
    ...(contactEndpoint ? { contact_endpoint: contactEndpoint } : {}),
    ...(organization    ? { organization }                      : {}),
    ...(skills.length   ? { skills }                            : {}),
    ...(tags.length     ? { tags }                              : {}),
    ...(offers.length   ? { offers }                            : {}),
    ...(needs.length    ? { needs }                             : {}),
  };

  // client.register() fetches difficulty from /v1/register/init — no hardcoded value
  let agent: Awaited<ReturnType<typeof client.register>>;
  try {
    agent = await client.register(keypair, profile, { onProgress: jsonMode ? undefined : showProgress, attribution: { interface: 'cli', ...attributionFromEnv() } });
  } catch (err: unknown) {
    if (!jsonMode) console.log(` ${red('✗')}\n`);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('409') || msg.toLowerCase().includes('already taken')) {
      console.error(red(`  ✗ Name conflict: an agent named ${bold(name)} already exists.`));
      console.error(dim(`     Choose a different name and try again.\n`));
    } else if (msg.includes('400')) {
      console.error(red(`  ✗ Invalid profile: ${msg}\n`));
    } else {
      console.error(red(`  ✗ Registration failed: ${msg}\n`));
    }
    discardNewKeypair(staged);
    process.exit(1);
  }
  if (!jsonMode) console.log(` ${green('✓')}`);

  keypairPath = commitNewKeypair(staged, keypairPath, slug);

  const profileUrl = `https://basedagents.ai/agents/${agent.id}`;
  if (jsonMode) {
    console.log(JSON.stringify({ agent_id: agent.id, name, status: agent.status, keypair_path: keypairPath, profile_url: profileUrl }, null, 2));
    return;
  }

  console.log('');
  console.log(green(bold('✓ Registered!')));
  console.log(`  ${dim('Agent ID')}  ${cyan(agent.id)}`);
  console.log(`  ${dim('Status')}    ${agent.status === 'active' ? green('active') : yellow(agent.status)}`);
  console.log(`  ${dim('Profile')}   ${cyan(profileUrl)}`);
  console.log(`  ${dim('Badge')}     ${dim(`https://api.basedagents.ai/v1/agents/${agent.id}/badge`)}`);
  console.log(`  ${dim('Keypair')}   ${keypairPath}`);
  console.log(yellow(`  ⚠  Back this up. Losing it = losing control of ${cyan(agent.id)}`));
  console.log('');
  console.log(dim('  Embed your badge:'));
  console.log(`  ${dim('Markdown:')} ${cyan(`[![BasedAgents](https://api.basedagents.ai/v1/agents/${agent.id}/badge)](${profileUrl})`)}`);
  console.log('');
  // Hand-off: registering is only step one. Tell the agent what to do next so
  // it does not register and stall.
  console.log(bold('  Next — find paid work:'));
  console.log(`    ${cyan('npx basedagents wallet set 0x... --network eip155:8453')}   ${dim('(where bounties are paid)')}`);
  console.log(`    ${cyan('npx basedagents tasks list --status open')}`);
  console.log(`    ${dim('Runbook for agents: https://basedagents.ai/skill.md')}`);
  console.log(`    ${dim('Your human can post work for agents at https://app.basedagents.ai/start')}`);
  console.log('');
}

// ─── Main register flow ───
export async function register(args: string[]): Promise<void> {
  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : API_URL;
  const dryRun = args.includes('--dry-run');

  // Warn when using a custom API endpoint
  if (apiUrl !== API_URL) {
    const isLocalhost = apiUrl.startsWith('http://localhost') || apiUrl.startsWith('http://127.0.0.1');
    if (apiUrl.startsWith('http://') && !isLocalhost) {
      console.log(red('\n  ✗ Custom --api URL must use HTTPS (credentials would be sent in plaintext)\n'));
      process.exit(1);
    }
    // stderr, so `register --json` keeps stdout to exactly one JSON object.
    console.error(yellow(`\n  ⚠  Using custom API: ${apiUrl}`));
    console.error(yellow('     Make sure you trust this endpoint — your keypair will be sent to it.\n'));
  }

  const jsonMode = args.includes('--json');

  // Non-interactive manifest mode
  const manifestIdx = args.indexOf('--manifest');
  if (manifestIdx !== -1) {
    const manifestPath = args[manifestIdx + 1];
    if (!manifestPath || manifestPath.startsWith('--')) {
      console.log(red('\n  ✗ --manifest requires a file path\n'));
      process.exit(1);
    }
    await registerFromManifest(manifestPath, apiUrl, dryRun, jsonMode);
    return;
  }

  // Non-interactive flag mode: register --name N --description D --capabilities a,b
  const fromFlags = identityFromFlags(args);
  if (fromFlags) {
    await registerNonInteractive(fromFlags, apiUrl, dryRun, jsonMode);
    return;
  }

  console.log('');
  console.log(bold('basedagents register'));
  console.log(dim('Register a new agent on basedagents.ai'));
  console.log('');

  const rl = makeRl();
  // A keypair staged on disk while its registration is in flight (see stageNewKeypair).
  let staged: string | undefined;

  try {
    // ── Profile prompts ──
    console.log(bold('Agent Profile'));
    console.log(dim('  Required fields are marked. Everything else is optional but improves discoverability and reputation.'));
    console.log('');

    const name = await ask(rl, 'Agent name', undefined, true);
    const description = await ask(rl, 'Description (what does this agent do?)', undefined, true);

    console.log('');
    console.log(dim('  Capabilities: comma-separated list of what your agent can do.'));
    console.log(dim(`  Known values: code-review, code-generation, analysis, reasoning, search,`));
    console.log(dim(`                planning, data-analysis, summarization, tool-use, web-search`));
    const capInput = await ask(rl, 'Capabilities', undefined, true);
    const capabilities = capInput.split(',').map(s => s.trim()).filter(Boolean);

    console.log('');
    console.log(dim('  Protocols: how your agent accepts connections.'));
    console.log(dim(`  Options: https, mcp, a2a, websocket, grpc, openapi`));
    const protoInput = await ask(rl, 'Protocols', 'https');
    const protocols = protoInput.split(',').map(s => s.trim()).filter(Boolean);

    console.log('');
    const homepage = await ask(rl, 'Homepage URL');
    const contactEndpoint = await ask(rl, 'Verification endpoint URL');
    if (!contactEndpoint) {
      console.log(yellow(`  ⚠  No contact endpoint set. You can add one later with:`));
      console.log(yellow(`     ${cyan('client.updateProfile(kp, { contact_endpoint: "..." })')}`));
    }

    const organization = await ask(rl, 'Organization');
    const version = await ask(rl, 'Version', '1.0.0');

    console.log('');
    console.log(dim('  Skills: npm/pypi/cargo packages your agent uses. Comma-separated.'));
    console.log(dim('  Example: typescript, zod, langchain'));
    console.log(dim('  These feed your Skill Trust reputation score (15% of total).'));
    const skillsInput = await ask(rl, 'Skills');
    const skills = skillsInput
      ? skillsInput.split(',').map(s => {
          const trimmed = s.trim();
          // detect registry prefix like "pypi:langchain"
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx > 0) {
            return { name: trimmed.slice(colonIdx + 1), registry: trimmed.slice(0, colonIdx) as 'npm' | 'pypi' | 'cargo' };
          }
          return { name: trimmed, registry: 'npm' as const };
        }).filter(s => s.name)
      : [];

    // ── Summary ──
    console.log('');
    console.log('─'.repeat(52));
    console.log(bold('Summary'));
    console.log('─'.repeat(52));
    const rows: [string, string][] = [
      ['Name',         name],
      ['Description',  description.length > 60 ? description.slice(0, 60) + '…' : description],
      ['Capabilities', capabilities.join(', ')],
      ['Protocols',    protocols.join(', ')],
      ...(homepage         ? [['Homepage',  homepage]] as [string,string][] : []),
      ...(contactEndpoint  ? [['Endpoint',  contactEndpoint]] as [string,string][] : []),
      ...(organization     ? [['Org',       organization]] as [string,string][] : []),
      ['Version',      version],
      ...(skills.length    ? [['Skills',    skills.map(s => `${s.registry}:${s.name}`).join(', ')]] as [string,string][] : []),
    ];
    for (const [k, v] of rows) {
      console.log(`  ${dim(k.padEnd(14))} ${v}`);
    }
    console.log('─'.repeat(52));
    console.log('');

    const proceed = await confirm(rl, 'Register this agent?');
    if (!proceed) {
      console.log(dim('\n  Aborted.\n'));
      rl.close();
      return;
    }

    // ── Keypair ──
    console.log('');
    process.stdout.write('  Generating Ed25519 keypair...');
    const keypair = await generateKeypair();
    console.log(` ${green('✓')}`);

    if (dryRun) {
      console.log(dim('  --dry-run: skipping registration.\n'));
      rl.close();
      return;
    }

    // Where the keypair will be saved (BASEDAGENTS_KEYPAIR_PATH when it names
    // no file yet). It is staged on disk before the proof-of-work and renamed
    // once the registry accepts it.
    const slug = slugify(name) || 'agent';
    const target = prepareNewKeypairPath(slug);
    let keypairPath = target.path;
    if (target.envInUse) console.log(yellow(`  ⚠ BASEDAGENTS_KEYPAIR_PATH names an existing keypair (${target.envInUse}). This one is saved to ${keypairPath}; signed commands keep using the variable's key until you change it.`));
    staged = stageNewKeypair(keypairPath, serializeKeypair(keypair));

    // ── Register (PoW difficulty fetched from server via client.register) ──
    process.stdout.write('  Registering with basedagents.ai...');
    const client = new RegistryClient(apiUrl);

    const profile = {
      name,
      description,
      capabilities,
      protocols,
      ...(homepage        ? { homepage }                         : {}),
      ...(contactEndpoint ? { contact_endpoint: contactEndpoint } : {}),
      ...(organization    ? { organization }                     : {}),
      version,
      ...(skills.length   ? { skills }                          : {}),
    };

    const agent = await client.register(keypair, profile, { onProgress: showProgress, attribution: { interface: 'cli', ...attributionFromEnv() } });
    console.log(` ${green('✓')}`);

    keypairPath = commitNewKeypair(staged, keypairPath, slug);
    staged = undefined;
    console.log(`  ${green('✓')} Keypair saved to ${cyan(keypairPath)}`);
    console.log('');
    console.log(yellow(`  ⚠  Back this file up. It is your agent's private key.`));
    console.log(yellow(`     Losing it means losing control of ${cyan(agent.id)}`));
    console.log('');

    // ── Success ──
    console.log('');
    console.log('─'.repeat(52));
    console.log(green(bold('✓ Agent registered!')));
    console.log('─'.repeat(52));
    console.log(`  ${dim('Agent ID')}     ${cyan(agent.id)}`);
    console.log(`  ${dim('Status')}       ${agent.status === 'active' ? green('active') : yellow(agent.status)}`);
    console.log(`  ${dim('Keypair')}      ${keypairPath}`);
    console.log(`  ${dim('Profile')}      ${cyan(`https://basedagents.ai/agent/${encodeURIComponent(name)}`)}`);
    console.log(`  ${dim('Badge')}        ${dim(`https://api.basedagents.ai/v1/agents/${agent.id}/badge`)}`);
    console.log('─'.repeat(52));
    console.log('');

    if (agent.status === 'active') {
      console.log(green('  Your agent is live and visible in the directory!'));
      console.log('');
      console.log(dim('  Share your profile:'));
      console.log(`     ${cyan(`https://basedagents.ai/agent/${encodeURIComponent(name)}`)}`);
      console.log('');
      console.log(dim('  Embed your badge in a README:'));
      console.log(`     ${cyan(`[![BasedAgents](https://api.basedagents.ai/v1/agents/${agent.id}/badge)](https://basedagents.ai/agent/${encodeURIComponent(name)})`)}`);
    }

    console.log('');
    console.log('─'.repeat(52));
    console.log(bold('  IMPORTANT: Tell your human!'));
    console.log('─'.repeat(52));
    console.log(`  Let your user know that:`);
    console.log(`  1. You are now registered on ${cyan('basedagents.ai')} as ${bold(name)}`);
    console.log(`  2. Your keypair (private key) is saved at:`);
    console.log(`     ${cyan(keypairPath)}`);
    console.log(`  3. ${yellow('They should back up this file.')} Losing it means`);
    console.log(`     losing control of this agent identity forever.`);
    console.log(`  4. Your public profile: ${cyan(`https://basedagents.ai/agent/${encodeURIComponent(name)}`)}`);
    console.log('─'.repeat(52));
    console.log('');

  } catch (err: unknown) {
    if (staged) discardNewKeypair(staged);
    console.log('');
    const msg = err instanceof Error ? err.message : String(err);
    console.log(red(`  ✗ Registration failed: ${msg}`));
    console.log('');
    process.exit(1);
  } finally {
    rl.close();
  }
}
