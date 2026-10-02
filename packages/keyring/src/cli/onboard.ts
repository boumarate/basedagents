/**
 * `npx @basedagents/keyring init` — the base-case onboarding (redesign Move 1+2).
 *
 * One command, run where the agent already lives (the terminal):
 *   1. create (or reuse) the local vault — the owner keypair never leaves here;
 *   2. create an agent identity, auto-named "Claude Code @ <hostname>";
 *   3. offer to register the MCP server with Claude Code (`claude mcp add`);
 *   4. create a link code at the control plane and open ONE browser page —
 *      "Take control of this agent" — where a single email field claims it;
 *   5. wait for the claim, then keep storing the page's connect-card tokens
 *      (sealed to the vault key) until the user is done in the browser.
 *
 * No signup form, no naming questions, no scope questions. Flags for the
 * advanced door: --name, --api, --no-link (vault+identity only), --no-browser,
 * --no-watch (exit right after the claim), --bare (the original vault-only
 * init), --yes (skip prompts), --start <code> (the browser-door hand-off: a
 * single-use code from app.basedagents.ai/start that pre-addresses the claim
 * email so the /link page needs one click, not re-typing — it carries no
 * authority, and a stale code silently falls back to the email field).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { Keyring } from '../keyring.js';
import { generateKeypair, signPayload } from '../crypto.js';
import { publicKeyToAgentId, base58Encode } from '../util.js';
import { runSweep } from '../sweep.js';
import { parseFlags, loadKeypairChecked } from './shared.js';
import { confirm } from './prompt.js';
import { ControlClient, DEFAULT_KEYRING_API, proxyHint } from './control-client.js';
import { processConnections, processPassportHandoffs, depositShelf } from './sync.js';
import { PASSPORT_ENV, parsePassportBlob, materializeVault, writeAgentKeypairFile } from '../cloud/passport.js';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // matches the link code's 30m TTL
const CONNECT_WATCH_MS = 15 * 60 * 1000; // post-claim window for the connect cards

function detectAgentName(): string {
  // The command is designed to be pasted into Claude Code; if another agent
  // runs it, --name is the override. Hostname keeps two machines distinct.
  return `Claude Code @ ${os.hostname()}`;
}

/** Best-effort browser open; silence is fine (the URL is printed regardless). */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // A missing opener (xdg-open in a container) surfaces as an ASYNC 'error'
    // event — unhandled, it crashes the whole process AFTER the link printed
    // (field-hit in a Codex task). Swallow it: the printed URL is the fallback.
    child.on('error', () => { /* printed URL is the fallback */ });
    child.unref();
  } catch {
    /* printed URL is the fallback */
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * Anonymous funnel ping (onboarding redesign instrumentation). Strictly an
 * event name plus a random per-run id — no hostname, no agent id, no email.
 * Sent only in link mode (init is already talking to this API for the link),
 * best-effort, and disabled entirely by BASEDAGENTS_NO_TELEMETRY=1.
 */
function funnelPing(api: string, funnelId: string, event: 'init_run' | 'mcp_config_written'): void {
  if (process.env.BASEDAGENTS_NO_TELEMETRY === '1') return;
  // AbortSignal.timeout bounds the request so a blackholed proxy can never keep
  // the Node event loop alive after `init` is otherwise done (a floating
  // keepalive fetch would hang the process for undici's full timeout).
  fetch(`${api}/v1/funnel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, funnel_id: funnelId }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
}

/**
 * Custody Fix 2: at init, show every way the agent can already act as the human
 * outside Keyring. Quiet when the environment is clean.
 */
function surfaceSweep(): void {
  const { findings } = runSweep();
  if (findings.length === 0) return;
  console.log('');
  console.log(`We found ${findings.length} way(s) your agent can already act as you, outside Keyring:`);
  for (const f of findings) console.log(`  • ${f.title}`);
  console.log('  Want Keyring to take custody? Run `based doctor` to review, then Absorb each one.');
}

export async function cmdInit(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, {
    value: ['owner-keypair', 'name', 'api', 'start', 'source', 'campaign', 'acquisition-id'],
    switch: ['bare', 'no-link', 'no-browser', 'no-watch', 'yes'],
  });
  const api = flags.values['api'] ?? DEFAULT_KEYRING_API;
  // Vault-less cloud mode (SANDBOX_SPEC §4b): a passport in the environment
  // means this container is a CACHE, not a home — same agent every task,
  // working set re-materialized from the control-plane shelf. No link, no
  // claim, nothing durable created here.
  if (process.env[PASSPORT_ENV]) {
    await cloudInit(process.env[PASSPORT_ENV], api, dir, flags.switches.has('yes'));
    return;
  }
  // Telemetry only makes sense when init talks to the control plane anyway.
  const telemetryOk = !flags.switches.has('bare') && !flags.switches.has('no-link');
  const funnelId = randomBytes(8).toString('hex');
  if (telemetryOk) funnelPing(api, funnelId, 'init_run');

  // 1. Vault — create, or quietly reuse an existing one (re-running the paste
  //    command must never destroy anything).
  let kr: Keyring;
  let vaultCreated = false;
  try {
    kr = Keyring.open(dir);
    console.log(`✓ Using your existing vault (${kr.store.dir})`);
  } catch {
    const ownerKeypairPath = flags.values['owner-keypair'];
    const ownerKeypair = ownerKeypairPath ? loadKeypairChecked(ownerKeypairPath) : undefined;
    kr = await Keyring.init({ dir, ownerKeypair });
    vaultCreated = true;
    console.log('✓ Vault created');
    console.log(`  Everything sensitive stays in ${kr.store.dir} — nothing secret ever leaves this machine.`);
  }
  const vault = kr.vault();

  if (flags.switches.has('bare')) {
    if (vaultCreated) {
      console.log('');
      console.log(`⚠ Back up ${kr.store.ownerKeyPath}`);
      console.log('  It is the only key that can open this vault.');
    }
    return;
  }

  // 2. Agent identity — auto-named, no questions.
  const agentName = flags.values['name'] ?? detectAgentName();
  const existing = Object.values(vault.identities).find((i) => i.name === agentName);
  let agentId: string;
  let keypairPath: string;
  if (existing?.keypair_path && fs.existsSync(existing.keypair_path)) {
    agentId = existing.agent_id;
    keypairPath = existing.keypair_path;
    console.log(`✓ Agent already set up: ${agentName}`);
  } else {
    const keypair = await generateKeypair();
    agentId = publicKeyToAgentId(keypair.publicKey);
    const keysDir = path.join(kr.store.dir, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    keypairPath = path.join(keysDir, `${agentId.slice(0, 14)}-keypair.json`);
    fs.writeFileSync(
      keypairPath,
      JSON.stringify(
        {
          agent_id: agentId,
          public_key_b58: base58Encode(keypair.publicKey),
          private_key_hex: Buffer.from(keypair.privateKey).toString('hex'),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    await kr.addIdentity(kr.ownerKeypair(), agentId, { name: agentName, keypairPath });
    console.log(`✓ Agent set up: ${agentName}`);
  }
  const agentPublicKeyB58 = agentId.slice(3); // ag_<base58 pub>

  // Custody Fix 2: the strongest activation moment we have — show the human
  // every way their agent can already act as them, outside Keyring.
  surfaceSweep();

  // Optional acquisition tags (--source pulsemcp --campaign …): carried into
  // the MCP config below as BASEDAGENTS_ACQUISITION_* env, so where this
  // onboarding came from survives into the installed configuration. Analytics
  // only — invalid values are dropped, and the same opt-outs as funnelPing
  // (BASEDAGENTS_NO_TELEMETRY=1 / BASEDAGENTS_TELEMETRY=off) silence it.
  const tagOk = telemetryOk && (process.env.BASEDAGENTS_TELEMETRY ?? '').toLowerCase() !== 'off';
  const acquisitionEnv: string[] = [];
  if (tagOk) {
    const label = /^[a-z0-9_-]{1,64}$/;
    const source = flags.values['source'] ?? '';
    const campaign = flags.values['campaign'] ?? '';
    const acqId = flags.values['acquisition-id'] ?? '';
    if (label.test(source)) acquisitionEnv.push('--env', `BASEDAGENTS_ACQUISITION_SOURCE=${source}`);
    if (label.test(campaign)) acquisitionEnv.push('--env', `BASEDAGENTS_ACQUISITION_CAMPAIGN=${campaign}`);
    if (/^acq_[A-Za-z0-9_-]{1,96}$/.test(acqId)) acquisitionEnv.push('--env', `BASEDAGENTS_ACQUISITION_ID=${acqId}`);
  }

  // 3. MCP config for Claude Code (with permission — we never edit config silently).
  const mcpArgs = [
    'mcp', 'add', 'basedagents-keyring',
    '--env', `BASEDAGENTS_KEYPAIR_PATH=${keypairPath}`,
    ...(dir ? ['--env', `BASEDAGENTS_KEYRING_DIR=${kr.store.dir}`] : []),
    ...acquisitionEnv,
    '--', 'npx', '-y', '@basedagents/keyring', 'mcp',
  ];
  const mcpCommand = `claude ${mcpArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  let mcpConfigured = false;
  const wantMcp = flags.switches.has('yes') || (await confirm('Add the keyring to Claude Code (writes MCP config)?', { nonTtyDefault: true }));
  if (wantMcp) {
    try {
      execFileSync('claude', mcpArgs, { stdio: 'ignore' });
      mcpConfigured = true;
      console.log('✓ Claude Code can now use the keyring (MCP configured)');
      if (telemetryOk) funnelPing(api, funnelId, 'mcp_config_written');
    } catch {
      console.log('· Could not run `claude` here — add it yourself with:');
      console.log(`    ${mcpCommand}`);
    }
  } else {
    console.log('· Skipped. Add it later with:');
    console.log(`    ${mcpCommand}`);
  }

  if (flags.switches.has('no-link')) return;

  // 4. The one browser page. The link request is SIGNED by the vault key so
  //    the control plane can prove we physically hold it (only the vault
  //    holder may mint a link code for this owner id). A network failure here
  //    is recoverable-by-design — never let it crash the whole `init`.
  console.log('');
  const vaultKeypair = kr.ownerKeypair();
  const linkCanonical = `keyring-link:v1:${vault.owner.public_key_b58}:${agentId}:${agentPublicKeyB58}`;
  const vaultSignature = await signPayload(vaultKeypair.privateKey, linkCanonical);
  let link: { status: number; json: Record<string, unknown> };
  try {
    link = await postJson(`${api}/v1/owner/link`, {
      vault_public_key: vault.owner.public_key_b58,
      agent_id: agentId,
      agent_public_key: agentPublicKeyB58,
      agent_name: agentName,
      vault_signature: vaultSignature,
      ...(flags.values['start'] ? { start_code: flags.values['start'] } : {}),
    });
  } catch {
    console.log(`⚠ Could not reach ${api}. Your vault and agent are saved — re-running init is safe.`);
    console.log('  On your own machine? Check the network and finish with:  based init');
    console.log('  In a cloud sandbox (Codex-style)? You cannot fix this from inside the task —');
    console.log('  the human must allow api.basedagents.ai and app.basedagents.ai in the');
    console.log('  environment settings (walkthrough: basedagents.ai/codex), then start a NEW task.');
    console.log(proxyHint().trimStart());
    return;
  }
  if (link.status !== 200 || typeof link.json.url !== 'string') {
    console.log(`⚠ Could not reach ${api} (${link.status}). Your vault and agent are saved — re-running init is safe.`);
    console.log('  Cloud sandbox? The human allows api.basedagents.ai + app.basedagents.ai in the');
    console.log('  environment settings (walkthrough: basedagents.ai/codex), then starts a NEW task.');
    if (link.status === 403 || link.status === 407) console.log(proxyHint().trimStart());
    return;
  }
  const url = link.json.url as string;
  const code = link.json.code as string;
  const emailHint = typeof link.json.email_hint === 'string' ? link.json.email_hint : undefined;

  console.log('Take control of this agent — open:');
  console.log('');
  console.log(`    ${url}`);
  console.log('');
  if (emailHint) {
    // Start-code hand-off worked: the page already knows where to send the
    // confirmation — say so, so an agent relaying this output can tell its
    // human exactly which inbox to watch.
    console.log(`  Your email is already filled in — the confirmation goes to ${emailHint}.`);
  } else if (flags.values['start']) {
    console.log('  (The code from the start page was stale — enter your email on the page instead.)');
  }
  if (!flags.switches.has('no-browser')) openBrowser(url);
  console.log('Waiting for you to finish in the browser (Ctrl-C is safe — nothing is lost)…');

  // 5. Wait for the claim.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let claimed = false;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${api}/v1/owner/link/${code}`);
      const status = ((await res.json()) as { status?: string }).status;
      if (status === 'claimed') {
        claimed = true;
        break;
      }
      if (status === 'expired') break;
    } catch {
      /* transient network — keep polling */
    }
  }

  console.log('');
  if (claimed) {
    console.log(`✓ ${agentName} is set up.`);

    // 6. Stay alive as the daemon while the browser page's connect cards are
    //    in flight: each pasted token arrives sealed to the vault key, is
    //    opened + validated + stored HERE, and the card flips to ✓ without
    //    the user ever returning to the terminal.
    if (!flags.switches.has('no-watch')) {
      console.log('');
      console.log('  Finish connecting things in the browser — they are stored here as they arrive.');
      console.log('  (Ctrl-C when the page says you are done.)');
      console.log('');
      let stopWatch = false;
      const onSig = (): void => { stopWatch = true; };
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);
      const client = new ControlClient(kr.ownerKeypair(), api);
      const watchDeadline = Date.now() + CONNECT_WATCH_MS;
      while (!stopWatch && Date.now() < watchDeadline) {
        try {
          const touched = await processConnections(kr, client);
          await processPassportHandoffs(kr, client);
          if (touched > 0) await depositShelf(kr, client);
        } catch {
          /* transient network — keep watching */
        }
        for (let i = 0; i < POLL_INTERVAL_MS / 1000 && !stopWatch; i++) {
          await new Promise<void>((r) => setTimeout(r, 1000));
        }
      }
      process.removeListener('SIGINT', onSig);
      process.removeListener('SIGTERM', onSig);
    }

    console.log('');
    console.log(`  Pull new approvals anytime with:  based sync --watch`);
    console.log(`  Cut it all off anytime:           based kill "${agentName}"`);
    if (!mcpConfigured) {
      console.log('');
      console.log('  (Remember to add the MCP config so Claude Code can use it.)');
    }
  } else {
    console.log('· The browser step was not finished. Run `based init` again for a fresh link —');
    console.log('  your vault and agent are saved and will be reused.');
  }
}

/**
 * Vault-less cloud init: materialize the working set from the passport + the
 * control-plane shelf. Everything written is a disposable per-task cache.
 */
async function cloudInit(blob: string, api: string, dir: string | undefined, yes: boolean): Promise<void> {
  const passport = parsePassportBlob(blob);
  const client = new ControlClient(passport.owner, api);
  let shelf: { enabled: boolean; credentials: Array<{ credential_id: string; v: number; meta: string; sealed: string; grants: string }> } = { enabled: false, credentials: [] };
  try {
    shelf = await client.getShelf();
  } catch (err) {
    console.log(`· Could not reach ${api} (${(err as Error).message}) — starting with an empty cache; re-run when the network is back.`);
  }
  const kr = materializeVault(dir, passport, shelf.credentials);
  const keypairPath = writeAgentKeypairFile(kr.store.dir, passport);

  console.log(`✓ Same agent as always: ${passport.name} (${passport.agentId.slice(0, 14)}…)`);
  console.log(`✓ ${shelf.credentials.length} item(s) ready to use.`);
  console.log('  This container holds only a disposable copy — the durable keys live in your');
  console.log(`  environment's ${PASSPORT_ENV} secret and as locked boxes at the control plane.`);

  const mcpArgs = [
    'mcp', 'add', 'basedagents-keyring',
    '--env', `BASEDAGENTS_KEYPAIR_PATH=${keypairPath}`,
    ...(dir ? ['--env', `BASEDAGENTS_KEYRING_DIR=${kr.store.dir}`] : []),
    '--', 'npx', '-y', '@basedagents/keyring', 'mcp',
  ];
  const mcpCommand = `claude ${mcpArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  const wantMcp = yes || (await confirm('Add the keyring to this agent runtime (writes MCP config)?', { nonTtyDefault: true }));
  if (wantMcp) {
    try {
      execFileSync('claude', mcpArgs, { stdio: 'ignore' });
      console.log('✓ MCP configured');
    } catch {
      console.log('· Could not run `claude` here — add it yourself with:');
      console.log(`    ${mcpCommand}`);
    }
  } else {
    console.log('· Skipped. Add it later with:');
    console.log(`    ${mcpCommand}`);
  }
  console.log('');
  console.log('Already claimed by your human — nothing else to do. Ask for things with keyring_request.');
}
