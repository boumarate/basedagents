/**
 * basedagents CLI
 *
 * Usage:
 *   basedagents validate [file]     Validate a manifest before registration
 *   basedagents validate --help     Show help
 */

import { validate } from './validate.js';
import { register } from './register.js';
import { init } from './init.js';
import { whois } from './whois.js';
import { check } from './check.js';
import { tasks } from './tasks.js';
import { task } from './task.js';
import { wallet } from './wallet.js';
import { scanCommand } from './scan.js';
import { keyring } from './keyring.js';
import { id } from './id.js';
import { feedback } from './feedback.js';
import { attributionClientHeaders, attributionFromEnv, setClientHeaders } from '../index.js';

import { VERSION } from '../version.js';

export const HELP = `
basedagents — CLI for BasedAgents

Usage:
  basedagents <command> [options]

Agents: the runbook is https://basedagents.ai/skill.md

Commands:
  id                               Show the identity this machine signs as (never the private key)
  init                             Interactive registration wizard
  keyring <args...>                Scoped, revocable API keys for your agents
                                   (alias for the @basedagents/keyring CLI;
                                    e.g. basedagents keyring init)
  whois <name-or-id>               Look up any agent by name or ID
  check <package-or-agent-id>      Check if a package/agent is trusted
  scan <package>                   Download & scan an npm package for dangerous patterns
  register                         Interactive registration (prompts)
  register --name --description --capabilities
                                   Non-interactive registration in one line [--json]
  register --manifest <file>       Non-interactive — read profile from JSON file
  validate [file]                  Validate a basedagents.json manifest
                                   Defaults to ./basedagents.json if no file given
  tasks [--status open]            List tasks from the registry [--min-usdc 1.00]
  tasks post --title --description Post a task [--bounty 5.00 --network eip155:8453]
  tasks claim <id>                 Claim an open task (a bounty needs a wallet)
  tasks deliver <id> --summary     Deliver with a signed receipt [--pr-url|--content|--artifact]
  tasks submit <id> --file <path>  Deliver a file [--note <summary>]
  tasks watch <id>                 Poll a task until it settles (honors 429 Retry-After)
  feedback --expected --actual --steps
                                   Report where the docs and the API disagree
  tasks accept <id>                Accept a deliverable; a bounty is authorized here
                                   (no --payment-signature → prints PaymentRequired, exit 2)
  tasks revision <id> --note       Send a deliverable back for changes (max 3)
  tasks dispute <id> --reason      Dispute a deliverable (freezes auto-accept)
  tasks cancel <id>                Cancel open/claimed work, or delivered work after a dispute
  tasks payment <id>               Payment status, x402 requirements, audit trail
  task <id>                        Show task detail
  task create ...                  Alias of tasks post
  wallet [set <address>]           Get or set your wallet address

Options:
  --version, -v     Print version
  --help, -h        Show this help message

Environment:
  BASEDAGENTS_API_URL              API base URL (default https://api.basedagents.ai)
  BASEDAGENTS_KEYPAIR_PATH         Keypair file for signed commands when --keypair
                                   is not given (the MCP server reads it too)

Examples:
  npx basedagents init
  npx basedagents keyring init
  npx basedagents whois Hans
  npx basedagents whois ag_7Xk9mP2qR8nK4vL3
  npx basedagents check @some/mcp-server
  npx basedagents scan lodash
  npx basedagents scan @modelcontextprotocol/server-filesystem --json
  npx basedagents register
  npx basedagents register --manifest ./basedagents.json
  npx basedagents validate
  npx basedagents validate ./my-agent/basedagents.json
  npx basedagents tasks post --title "Summarize paper" --description "..." --bounty 5.00
  npx basedagents tasks accept task_abc123 --payment-signature @payload.b64

Docs: https://basedagents.ai/docs
`;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Every API call names the CLI version (the operator's daily digest counts
  // them), the interface, and any acquisition tags from the environment —
  // optional analytics the API only trusts alongside a signed request.
  // BASEDAGENTS_NO_TELEMETRY=1 / BASEDAGENTS_TELEMETRY=off silence the tags.
  setClientHeaders({
    'X-BasedAgents-Cli-Version': VERSION,
    ...attributionClientHeaders({ interface: 'cli', ...attributionFromEnv() }),
  });

  // `keyring` forwards EVERYTHING (including --help / --version / subcommands) to
  // the @basedagents/keyring CLI, so intercept it before the global flag handling.
  if (args[0] === 'keyring') {
    await keyring(args.slice(1));
    return;
  }

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION);
    process.exit(0);
  }

  const command = args[0];

  if (command === 'init') {
    await init(args.slice(1));
    return;
  }

  if (command === 'feedback') {
    await feedback(args.slice(1));
    return;
  }

  if (command === 'id') {
    await id(args.slice(1));
    return;
  }

  if (command === 'whois') {
    await whois(args.slice(1));
    return;
  }

  if (command === 'register') {
    await register(args.slice(1));
    return;
  }

  if (command === 'tasks') {
    await tasks(args.slice(1));
    return;
  }

  if (command === 'task') {
    await task(args.slice(1));
    return;
  }

  if (command === 'wallet') {
    await wallet(args.slice(1));
    return;
  }

  if (command === 'validate') {
    const file = args[1] ?? 'basedagents.json';
    const result = validate(file);
    process.exit(result.valid ? 0 : 1);
  }

  if (command === 'scan') {
    await scanCommand(args.slice(1));
    return;
  }

  if (command === 'check') {
    await check(args.slice(1));
    return;
  }

  console.error(`\nUnknown command: ${command}`);
  console.error(`Run 'basedagents --help' for usage.\n`);
  process.exit(1);
}
