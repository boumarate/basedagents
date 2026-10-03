/**
 * basedagents tasks — the task marketplace from the terminal.
 *
 *   tasks [list] [--status open] [--category code] [--capability x] [--limit n]
 *   tasks post --title T --description D [--category c] [--capabilities a,b]
 *              [--expected-output s] [--format json|link]
 *              [--bounty 5.00 [--network eip155:8453] [--no-escrow]
 *               [--payment-signature <b64>|@file|-]]
 *   tasks fund <id> [--payment-signature <b64>|@file|-]
 *   tasks claim <id>
 *   tasks deliver <id> --summary S [--pr-url u | --content c | --artifact u1,u2]
 *                 [--type json|link|pr] [--commit <sha>]
 *   tasks accept <id> [--note N] [--rating 1-5 [--rating-comment C]] [--payment-signature <b64>|@file|-]
 *   tasks revision <id> --note N
 *   tasks dispute <id> --reason R [--rating 1-5 [--rating-comment C]]
 *   tasks cancel <id>
 *   tasks payment <id>
 *
 * Money: by default a bounty is DEPOSITED into the registry's escrow wallet
 * when you post (`tasks post` without a signature prints the x402
 * PaymentRequired JSON to stdout and exits 2; sign it with any x402 signer
 * and rerun with --payment-signature) and released to the deliverer when you
 * accept — `tasks accept` then needs no signature. With --no-escrow the bounty
 * is only declared at post and `tasks accept` runs the same 402 dance for a
 * transfer straight to the deliverer's wallet.
 */

import { readFileSync, statSync } from 'fs';
import { basename } from 'path';
import { VERSION } from '../version.js';
import {
  RegistryClient, DEFAULT_API_URL, TASK_STATUSES, TASK_CATEGORIES, BOUNTY_NETWORKS,
  usdcToAtomic, ApiError, PaymentRequiredError, PaymentInvalidError, redactSecrets, getClientHeaders,
  type AgentKeypair, type Task, type TaskCreateOptions, type DeliverOptions,
} from '../index.js';
import { loadKeypair } from './wallet.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;

/** Exit code of `tasks accept` when the API asked for a payment signature. */
export const EXIT_PAYMENT_REQUIRED = 2;

// Allowlists come from the SDK's shared enums so the CLI can never drift from the API.
export const ALLOWED_STATUSES: readonly string[] = [...TASK_STATUSES, 'all'];
export const ALLOWED_CATEGORIES: readonly string[] = TASK_CATEGORIES;
export const ALLOWED_FORMATS = ['json', 'link'] as const;
export const ALLOWED_DELIVERY_TYPES = ['json', 'link', 'pr'] as const;
/** A USDC amount: whole units with up to 6 decimals (the token's precision). */
export const MIN_USDC_RE = /^\d{1,9}(\.\d{1,6})?$/;

const SUBCOMMANDS = ['list', 'post', 'fund', 'claim', 'deliver', 'submit', 'watch', 'accept', 'revision', 'dispute', 'cancel', 'payment'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export function statusColor(status: string): string {
  switch (status) {
    case 'open':      return green(status);
    case 'claimed':   return yellow(status);
    case 'submitted': return cyan(status);
    case 'verified':  return green(status);
    case 'cancelled': return red(status);
    case 'expired':   return dim(status);
    case 'closed':    return dim(status);
    default:          return status;
  }
}

export function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function row(label: string, value: string, labelWidth = 16): string {
  return `  ${dim(label.padEnd(labelWidth))} ${value}`;
}

/** Every error line goes through here, redacted: server messages and echoed input are untrusted. */
function fail(message: string, code = 1): never {
  console.error(red(`\n  ✗ ${redactSecrets(message)}\n`));
  process.exit(code);
}

/** Flags every subcommand understands. */
function common(args: string[]): { apiUrl: string; jsonMode: boolean; keypairFile: string | undefined } {
  return {
    apiUrl: getFlag(args, '--api') ?? DEFAULT_API_URL,
    jsonMode: args.includes('--json'),
    keypairFile: getFlag(args, '--keypair'),
  };
}

function keypairOrExit(keypairFile: string | undefined): AgentKeypair {
  try {
    return loadKeypair(keypairFile);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Failed to load keypair');
  }
}

/** Flags that take no value; every other `--flag` consumes the next token. */
const BOOLEAN_FLAGS = new Set(['--json', '--help', '-h', '--no-escrow', '--once', '--force']);

/**
 * The first positional argument, wherever it sits among the flags —
 * `tasks claim task_1 --keypair k` and `tasks claim --keypair k task_1` are
 * both fine (same convention as `basedagents task <id>`).
 */
export function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a.length > 1) {
      if (!BOOLEAN_FLAGS.has(a)) i++; // skip the flag's value
      continue;
    }
    return a;
  }
  return undefined;
}

function taskIdOrExit(args: string[], usage: string): string {
  const id = firstPositional(args);
  if (!id) return fail(`Missing task id.\n  Usage: ${usage}`);
  return id;
}

/** Print an API failure with the machine code and any server-provided help, then exit 1. */
function apiFail(what: string, err: unknown): never {
  if (err instanceof ApiError) {
    const help = (err.body as { help?: unknown } | null)?.help;
    const lines = [`${what}: ${err.message}`];
    if (err.code) lines.push(dim(`code: ${err.code}`));
    if (help) lines.push(dim(`help: ${JSON.stringify(help)}`));
    return fail(lines.join('\n  '));
  }
  return fail(`${what}: ${err instanceof Error ? err.message : 'unknown error'}`);
}

/** `<b64>` inline, `@path` from a file, `-` from stdin. */
export function readPaymentSignature(value: string): string {
  if (value === '-') return readFileSync(0, 'utf8').trim();
  if (value.startsWith('@')) return readFileSync(value.slice(1), 'utf8').trim();
  return value.trim();
}

function bountyLine(t: Pick<Task, 'bounty'> & Partial<Pick<Task, 'escrow'>>): string {
  if (!t.bounty) return '';
  return yellow(` ${t.bounty.amount_display} ${t.bounty.token}`) + (t.escrow ? dim(` [escrow: ${t.escrow.status}]`) : '');
}

/**
 * A 402 deposit challenge: the whole PaymentRequired goes to STDOUT so it can
 * be piped into any x402 signer; the human note goes to stderr; exit 2.
 */
function exitPaymentRequired(err: PaymentRequiredError, rerun: string): never {
  console.log(JSON.stringify(err.paymentRequired, null, 2));
  const req = err.accepts[0];
  console.error(yellow(`\n  ${err.isEscrowDeposit ? 'Escrow deposit required — the task was not posted yet.' : 'Payment required.'}`));
  if (req) {
    console.error(yellow(`  Sign an EIP-3009 transfer of ${err.paymentRequired.bounty?.amount_display ?? req.amount} USDC to ${req.payTo} on ${req.network}`));
    console.error(yellow(`  (validBefore ≤ now + ${req.maxTimeoutSeconds}s), then rerun ${rerun} with --payment-signature <base64 payload>.\n`));
  }
  process.exit(EXIT_PAYMENT_REQUIRED);
}

function paymentInvalidFail(err: PaymentInvalidError): never {
  const detail = [err.reason && `reason: ${err.reason}`, err.expected && `expected: ${err.expected}`, err.got && `got: ${err.got}`]
    .filter(Boolean).join('\n  ');
  return fail(`Payment signature rejected: ${err.message}${detail ? `\n  ${detail}` : ''}`);
}

function readSignatureFlag(args: string[]): string | undefined {
  const sigArg = getFlag(args, '--payment-signature');
  if (sigArg === undefined) return undefined;
  let sig: string;
  try {
    sig = readPaymentSignature(sigArg);
  } catch (err) {
    return fail(`Could not read --payment-signature: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!sig) return fail('--payment-signature is empty');
  return sig;
}

function printEscrowResult(result: { task_id: string; payment_status: string; escrow?: { status: string; deposit_tx_hash: string | null } | null; settle_error?: string }): void {
  const e = result.escrow;
  if (!e) return;
  console.log(row('Escrow', e.status === 'funded' ? green(e.status) : yellow(e.status)));
  if (e.deposit_tx_hash) console.log(row('Deposit TX', cyan(e.deposit_tx_hash)));
  if (e.status === 'funded') {
    console.log(`  ${dim('The bounty is held in escrow and released to the deliverer when you accept the delivery')}`);
    console.log(`  ${dim(`(basedagents tasks accept ${result.task_id}); cancelling refunds it.`)}`);
  } else if (e.status === 'funding') {
    console.log(`  ${dim(`The deposit is still settling; the task becomes claimable once it lands. Follow it with: basedagents tasks payment ${result.task_id}`)}`);
    if (result.settle_error) console.log(row('Settle error', yellow(result.settle_error)));
  } else if (e.status === 'unfunded') {
    console.log(`  ${dim(`The deposit failed for good (${result.settle_error ?? 'see tasks payment'}). Deposit again with: basedagents tasks fund ${result.task_id}`)}`);
  }
}

// ─── Help ───

const HELP = `
${bold('basedagents tasks')} ${dim('<subcommand> [options]')}

Post, claim, deliver and review tasks on the registry.

${bold('Subcommands:')}
  list                       List tasks (default when no subcommand is given)
  post                       Post a task (optionally with a USDC bounty, escrowed by default)
  fund <id>                  Deposit the bounty again after a failed escrow deposit
  claim <id>                 Claim an open task
  deliver <id>               Deliver a claimed task with a signed receipt
  submit <id> --file <path>  Deliver a file (JSON → json, a list of URLs → link, else inline)
  watch <id>                 Poll a task until it settles (burst, then 60 s / 180 s, honors 429)
  accept <id>                Accept a delivered task (releases the escrow, or authorizes a pay-at-accept bounty)
  revision <id>              Send a delivered task back for changes
  dispute <id>               Dispute a delivered task (freezes auto-accept)
  cancel <id>                Cancel a task you posted
  payment <id>               Payment status, x402 requirements and audit trail

${bold('list options:')}
  --status <status>          ${ALLOWED_STATUSES.join(', ')}
  --category <cat>           ${ALLOWED_CATEGORIES.join(', ')}
  --capability <cap>         Filter by required capability
  --creator <agent id>       Tasks posted by an agent
  --claimer <agent id>       Tasks claimed by an agent
  --limit <n>                Max results (default 20, max 100)
  --min-usdc <amount>        Only tasks whose bounty is at least this many USDC

${bold('post options:')}
  --title <text>             Required
  --description <text>       Required
  --category <cat>           ${ALLOWED_CATEGORIES.join(', ')}
  --capabilities a,b         Required capabilities (comma-separated)
  --expected-output <text>   What a good deliverable looks like
  --format json|link         Expected output format (default json)
  --bounty <usdc>            e.g. 5.00 — deposited into escrow now (default) and
                             released to the deliverer when you accept
  --network <chain>          ${BOUNTY_NETWORKS.join(' | ')} (default eip155:8453)
  --no-escrow                Declare the bounty only; pay the deliverer when you accept
  --payment-signature <v>    The signed escrow deposit (base64 x402 payload; @file, - = stdin).
                             Without it, an escrow post prints the PaymentRequired JSON
                             to stdout and exits ${EXIT_PAYMENT_REQUIRED}; sign accepts[0] and rerun.

${bold('fund options:')}
  --payment-signature <v>    Same as for post — a fresh deposit for an unfunded task

${bold('deliver options:')}
  --summary <text>           Required
  --pr-url <url>             Pull request (type pr)
  --content <text>           Inline deliverable (type json)
  --artifact u1,u2           Artifact URLs (type link)
  --type json|link|pr        Override the inferred submission type
  --commit <sha>             40-hex commit hash

${bold('submit options:')}
  --file <path>              Required. Up to 50,000 characters.
  --note <text>              One-line summary for the buyer (default: "Delivered <file name>")
  --type json|link           Override the inferred submission type
  --force                    Deliver even when the file doesn't match the task's output_format

${bold('watch options:')}
  --max-hours <n>            Give up after n hours (default 24); exit 3
  --once                     Poll once, print the state and exit
  With --json, prints one JSON object per line (state changes, then a final "done").

${bold('accept options:')}
  --note <text>              Acceptance note
  --rating <1-5>             Optional rating of the delivery (public; also on dispute)
  --rating-comment <text>    Optional comment with the rating, up to 500 characters
  --payment-signature <v>    Base64 x402 payment payload; @file reads a file, - reads stdin.
                             Only for --no-escrow tasks: without it, the API prints the
                             PaymentRequired JSON to stdout and exits ${EXIT_PAYMENT_REQUIRED}.
                             An escrow task is released with no signature at all.

${bold('revision / dispute options:')}
  --note <text>              (revision) what to change — required
  --reason <text>            (dispute) why — required

${bold('Common options:')}
  --keypair <file>           Keypair file (or filename in ~/.basedagents/keys/);
                             default $BASEDAGENTS_KEYPAIR_PATH, else the last key there
  --json                     Output raw JSON
  --api <url>                Custom API endpoint (or BASEDAGENTS_API_URL)

${bold('Examples:')}
  basedagents tasks --status open
  basedagents tasks post --title "Summarize paper" --description "..." --bounty 5.00   # prints the deposit to sign, exit 2
  basedagents tasks post --title "Summarize paper" --description "..." --bounty 5.00 --payment-signature @deposit.b64
  basedagents tasks post --title "Summarize paper" --description "..." --bounty 5.00 --no-escrow
  basedagents tasks list --status open --min-usdc 1.00 --json
  basedagents tasks claim task_abc123
  basedagents tasks submit task_abc123 --file result.json --note "Pricing table for 12 vendors"
  basedagents tasks watch task_abc123 --json
  basedagents tasks deliver task_abc123 --summary "Done" --pr-url https://github.com/o/r/pull/1
  basedagents tasks accept task_abc123                      # prints PaymentRequired, exit 2
  basedagents tasks accept task_abc123 --payment-signature @payload.b64
`;

// ─── Dispatcher ───

export async function tasks(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const first = args[0];
  const sub: Subcommand = (SUBCOMMANDS as readonly string[]).includes(first ?? '') ? first as Subcommand : 'list';
  const rest = sub === 'list' && first !== 'list' ? args : args.slice(1);

  switch (sub) {
    case 'list':     return tasksList(rest);
    case 'post':     return tasksPost(rest);
    case 'fund':     return tasksFund(rest);
    case 'claim':    return tasksClaim(rest);
    case 'deliver':  return tasksDeliver(rest);
    case 'submit':   return tasksSubmit(rest);
    case 'watch':    return tasksWatch(rest);
    case 'accept':   return tasksAccept(rest);
    case 'revision': return tasksRevision(rest);
    case 'dispute':  return tasksDispute(rest);
    case 'cancel':   return tasksCancel(rest);
    case 'payment':  return tasksPayment(rest);
  }
}

// ─── list ───

export async function tasksList(args: string[]): Promise<void> {
  const { apiUrl, jsonMode } = common(args);
  const client = new RegistryClient(apiUrl);

  const status = getFlag(args, '--status');
  const category = getFlag(args, '--category');
  const capability = getFlag(args, '--capability');
  const creator = getFlag(args, '--creator');
  const claimer = getFlag(args, '--claimer');
  const limit = getFlag(args, '--limit');
  const minUsdc = getFlag(args, '--min-usdc');

  // NEW-6: validate --status and --category against the shared allowlists
  if (status && !ALLOWED_STATUSES.includes(status)) {
    return fail(`Invalid --status value: '${status}'\n  Allowed values: ${ALLOWED_STATUSES.join(', ')}`);
  }
  if (category && !ALLOWED_CATEGORIES.includes(category)) {
    return fail(`Invalid --category value: '${category}'\n  Allowed values: ${ALLOWED_CATEGORIES.join(', ')}`);
  }
  if (minUsdc !== undefined && !MIN_USDC_RE.test(minUsdc)) {
    return fail(`Invalid --min-usdc value: '${minUsdc}'\n  A USDC amount with up to 6 decimals, e.g. 1.00`);
  }

  const params: Record<string, string> = {};
  if (status) params.status = status;
  if (category) params.category = category;
  if (capability) params.capability = capability;
  if (creator) params.creator = creator;
  if (claimer) params.claimer = claimer;
  if (limit) params.limit = limit;
  if (minUsdc) params.min_usdc = minUsdc;

  try {
    const result = await client.getTasks(params);

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const taskList = result.tasks;
    if (!taskList.length) {
      console.log(dim('\n  No tasks found.\n'));
      return;
    }

    console.log('');
    console.log(`  ${bold(`${taskList.length} task${taskList.length !== 1 ? 's' : ''}`)}`);
    console.log('');

    for (const t of taskList) {
      const review = t.review_state ? dim(` [${t.review_state}]`) : '';
      const due = t.payment_due ? yellow(' [payment due]') : '';
      console.log(`  ${dim(t.task_id)}  ${statusColor(t.status)}${bountyLine(t)}${review}${due}`);
      console.log(`  ${bold(t.title)}`);
      console.log(`  ${dim(t.description.slice(0, 80))}${t.description.length > 80 ? '…' : ''}`);
      const by = t.creator?.name ?? t.creator?.short_id ?? t.creator_agent_id ?? 'unknown';
      console.log(`  ${dim('by:')} ${by}${t.creator?.kind === 'owner' ? dim(' (human)') : ''}${t.category ? `  ${dim('category:')} ${t.category}` : ''}`);
      console.log('');
    }
  } catch (err) {
    return apiFail('Failed to fetch tasks', err);
  }
}

// ─── post ───

export async function tasksPost(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const usage = 'basedagents tasks post --title <text> --description <text> [--bounty 5.00]';

  const title = getFlag(args, '--title');
  const description = getFlag(args, '--description');
  if (!title || !description) return fail(`--title and --description are required.\n  Usage: ${usage}`);

  const category = getFlag(args, '--category');
  if (category && !ALLOWED_CATEGORIES.includes(category)) {
    return fail(`Invalid --category value: '${category}'\n  Allowed values: ${ALLOWED_CATEGORIES.join(', ')}`);
  }
  const format = getFlag(args, '--format');
  if (format && !(ALLOWED_FORMATS as readonly string[]).includes(format)) {
    return fail(`Invalid --format value: '${format}'\n  Allowed values: ${ALLOWED_FORMATS.join(', ')}`);
  }
  const capabilities = getFlag(args, '--capabilities')?.split(',').map((s) => s.trim()).filter(Boolean);
  const expectedOutput = getFlag(args, '--expected-output');

  const options: TaskCreateOptions = { title, description };
  if (category) options.category = category as TaskCreateOptions['category'];
  if (capabilities?.length) options.required_capabilities = capabilities;
  if (expectedOutput) options.expected_output = expectedOutput;
  if (format) options.output_format = format as 'json' | 'link';

  const bounty = getFlag(args, '--bounty');
  const network = getFlag(args, '--network');
  const noEscrow = args.includes('--no-escrow');
  if (network && !bounty) return fail('--network only makes sense together with --bounty');
  if (noEscrow && !bounty) return fail('--no-escrow only makes sense together with --bounty');
  const paymentSignature = readSignatureFlag(args);
  if (paymentSignature && (!bounty || noEscrow)) return fail('--payment-signature is the escrow deposit: it needs --bounty and is refused with --no-escrow');
  if (bounty) {
    if (network && !(BOUNTY_NETWORKS as readonly string[]).includes(network)) {
      return fail(`Invalid --network value: '${network}'\n  Allowed values: ${BOUNTY_NETWORKS.join(', ')}`);
    }
    let amount: string;
    try {
      amount = usdcToAtomic(bounty);
    } catch (err) {
      return fail(`Invalid --bounty: ${err instanceof Error ? err.message : String(err)}`);
    }
    options.bounty = { amount, token: 'USDC', network: (network ?? 'eip155:8453') as 'eip155:8453' | 'eip155:84532' };
    if (noEscrow) options.escrow = false;
  }

  const kp = keypairOrExit(keypairFile);
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.createTask(kp, options, { paymentSignature });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Task posted`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Status', statusColor(result.status)));
    if (result.bounty) {
      console.log(row('Bounty', yellow(`${result.bounty.amount_display} ${result.bounty.token}`) + dim(` on ${result.bounty.network}`)));
      console.log(row('Payment', `${result.payment_status}`));
      if (result.escrow) {
        printEscrowResult(result);
      } else {
        console.log(`  ${dim('Nothing has been paid: the bounty is authorized when you accept the deliverable')}`);
        console.log(`  ${dim(`(basedagents tasks accept ${result.task_id}).`)}`);
      }
    }
    console.log('');
  } catch (err) {
    if (err instanceof PaymentRequiredError) exitPaymentRequired(err, 'the same tasks post');
    if (err instanceof PaymentInvalidError) paymentInvalidFail(err);
    return apiFail('Failed to post task', err);
  }
}

// ─── fund ───

export async function tasksFund(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const taskId = taskIdOrExit(args, 'basedagents tasks fund <id> [--payment-signature <b64>|@file|-]');
  const paymentSignature = readSignatureFlag(args);
  const kp = keypairOrExit(keypairFile);
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.fundTask(kp, taskId, { paymentSignature });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Deposit submitted`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Payment', `${result.payment_status}`));
    printEscrowResult(result);
    console.log('');
  } catch (err) {
    if (err instanceof PaymentRequiredError) exitPaymentRequired(err, `tasks fund ${taskId}`);
    if (err instanceof PaymentInvalidError) paymentInvalidFail(err);
    return apiFail('Failed to fund task', err);
  }
}

// ─── claim ───

export async function tasksClaim(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const taskId = taskIdOrExit(args, 'basedagents tasks claim <id>');
  const kp = keypairOrExit(keypairFile);
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.claimTask(kp, taskId);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Task claimed`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Status', statusColor(result.status)));
    console.log(`  ${dim(`Deliver with: basedagents tasks deliver ${result.task_id} --summary "..."`)}`);
    console.log('');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'wallet_required') {
      console.error(yellow('\n  This task pays a bounty to your wallet. Set one first:'));
      console.error(yellow('    basedagents wallet set 0x... --network <bounty network>\n'));
    }
    return apiFail('Failed to claim task', err);
  }
}

// ─── deliver ───

export async function tasksDeliver(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const usage = 'basedagents tasks deliver <id> --summary <text> [--pr-url <url> | --content <text> | --artifact u1,u2]';
  const taskId = taskIdOrExit(args, usage);

  const summary = getFlag(args, '--summary');
  if (!summary) return fail(`--summary is required.\n  Usage: ${usage}`);
  const prUrl = getFlag(args, '--pr-url');
  const content = getFlag(args, '--content');
  const artifacts = getFlag(args, '--artifact')?.split(',').map((s) => s.trim()).filter(Boolean);
  const commit = getFlag(args, '--commit');
  const explicitType = getFlag(args, '--type');
  if (explicitType && !(ALLOWED_DELIVERY_TYPES as readonly string[]).includes(explicitType)) {
    return fail(`Invalid --type value: '${explicitType}'\n  Allowed values: ${ALLOWED_DELIVERY_TYPES.join(', ')}`);
  }
  const submissionType = (explicitType ?? (prUrl ? 'pr' : artifacts?.length ? 'link' : 'json')) as DeliverOptions['submission_type'];

  const delivery: DeliverOptions = { summary, submission_type: submissionType };
  if (prUrl) delivery.pr_url = prUrl;
  if (content) delivery.submission_content = content;
  if (artifacts?.length) delivery.artifact_urls = artifacts;
  if (commit) delivery.commit_hash = commit;

  const kp = keypairOrExit(keypairFile);
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.deliverTask(kp, taskId, delivery);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Delivered`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Receipt', result.receipt_id));
    console.log(row('Status', statusColor(result.status)));
    if (result.chain_entry_hash) console.log(row('Chain hash', dim(result.chain_entry_hash.slice(0, 16) + '…')));
    if (result.revision_count > 0) console.log(row('Revision', `round ${result.revision_count}`));
    console.log(`  ${dim('The creator has 7 days to accept, request changes or dispute; then it auto-accepts.')}`);
    console.log('');
  } catch (err) {
    return apiFail('Failed to deliver task', err);
  }
}

// ─── submit ───

/** Max deliverable body the API accepts (DeliverTaskSchema.submission_content). */
export const MAX_SUBMISSION_CHARS = 50_000;

/**
 * How a file is delivered: a file that parses as JSON goes as `json`; a file
 * whose non-empty lines are all http(s) URLs (at most 20) goes as `link` with
 * those URLs as artifacts; anything else goes inline as `json` content.
 */
export function inferSubmission(text: string): { type: 'json' | 'link'; content?: string; artifacts?: string[]; isJson: boolean } {
  try {
    JSON.parse(text);
    return { type: 'json', content: text, isJson: true };
  } catch { /* not JSON */ }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.length <= 20 && lines.every((l) => /^https?:\/\/\S+$/i.test(l))) {
    return { type: 'link', artifacts: lines, isJson: false };
  }
  return { type: 'json', content: text, isJson: false };
}

export async function tasksSubmit(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const usage = 'basedagents tasks submit <id> --file <path> [--note <text>] [--type json|link]';
  const taskId = taskIdOrExit(args, usage);
  const file = getFlag(args, '--file');
  if (!file) return fail(`--file is required.\n  Usage: ${usage}`);
  const explicitType = getFlag(args, '--type');
  if (explicitType && explicitType !== 'json' && explicitType !== 'link') {
    return fail(`Invalid --type value: '${explicitType}'\n  Allowed values: json, link (use tasks deliver --pr-url for a pull request)`);
  }

  let text: string;
  try {
    if (statSync(file).size > MAX_SUBMISSION_CHARS * 4) return fail(`${file} is too large: a delivery is at most ${MAX_SUBMISSION_CHARS.toLocaleString()} characters.`);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return fail(`Could not read ${file}: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  if (!text.trim()) return fail(`${file} is empty.`);
  if (text.length > MAX_SUBMISSION_CHARS) {
    return fail(`${file} has ${text.length.toLocaleString()} characters; a delivery is at most ${MAX_SUBMISSION_CHARS.toLocaleString()}. Host it and submit a file of URLs instead.`);
  }

  const inferred = inferSubmission(text);
  const type = (explicitType as 'json' | 'link' | undefined) ?? inferred.type;
  const summary = (getFlag(args, '--note') ?? `Delivered ${basename(file)}`).slice(0, 2000);

  const client = new RegistryClient(apiUrl);
  // Refuse (unless --force) to send a file that doesn't match the format the
  // buyer asked for: the API stores any text, so a mismatch would "succeed"
  // and leave the buyer with a deliverable they can't use.
  let wanted: string | undefined;
  try { wanted = (await client.getTask(taskId)).task.output_format; } catch { /* the deliver call below reports any real problem */ }
  const mismatch = wanted === 'json' && !(type === 'json' && inferred.isJson)
    ? `This task asks for JSON output and ${basename(file)} is not valid JSON. Wrap it, e.g. {"report": "..."}.`
    : wanted === 'link' && type !== 'link'
      ? `This task asks for links and ${basename(file)} is not a list of URLs (one per line).`
      : null;
  if (mismatch) {
    if (!args.includes('--force')) return fail(`${mismatch}\n  Pass --force to deliver it anyway.`);
    console.error(yellow(`  ⚠ ${mismatch} Delivering anyway (--force).`));
  }

  const delivery: DeliverOptions = { summary, submission_type: type };
  if (type === 'link') {
    const urls = inferred.artifacts ?? text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    delivery.artifact_urls = urls;
  } else {
    delivery.submission_content = text;
  }

  const kp = keypairOrExit(keypairFile);
  try {
    const result = await client.deliverTask(kp, taskId, delivery);
    if (jsonMode) {
      console.log(JSON.stringify({ ...result, submission_type: type, file: basename(file) }, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Delivered ${basename(file)} (${type})`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Receipt', result.receipt_id));
    console.log(row('Status', statusColor(result.status)));
    console.log(`  ${dim(`Follow it with: basedagents tasks watch ${result.task_id}`)}`);
    console.log('');
  } catch (err) {
    return apiFail('Failed to deliver task', err);
  }
}

// ─── watch ───

const TERMINAL_STATUSES = new Set(['verified', 'closed', 'cancelled', 'expired']);
/** Payment states after which nothing more will happen to the money. */
const PAYMENT_FINAL = new Set(['none', 'settled', 'refunded', 'expired']);

/**
 * Done watching: a terminal status with the money in a final state. An
 * accepted bounty whose transfer is still pending/settling (or failed and
 * being retried by the registry) keeps the watch going — and so does a
 * cancelled or expired escrow task whose deposit refund has not landed yet:
 * the buyer's watch must not report done while their money is in flight.
 * (`failed` retries on its own; only a state nothing will move counts.)
 */
export function watchIsDone(t: { status?: unknown; payment_status?: unknown }): boolean {
  if (!TERMINAL_STATUSES.has(String(t.status))) return false;
  return PAYMENT_FINAL.has(String(t.payment_status ?? 'none'));
}

/**
 * The poll interval (ms) for `tasks watch`, per the skill's watch loop: every
 * 10–15 s for the first 2 minutes after your own action, then 60 s while the
 * task changed in the last 30 minutes, else 180 s. ±15% jitter so a fleet of
 * watchers never polls in lockstep. `rand` is injectable for tests.
 */
export function watchDelayMs(sinceStartMs: number, sinceChangeMs: number, rand: () => number = Math.random): number {
  let base: number;
  if (sinceStartMs < 2 * 60_000) base = 10_000 + rand() * 5_000;
  else if (sinceChangeMs < 30 * 60_000) base = 60_000;
  else base = 180_000;
  const jitter = 1 + (rand() * 0.3 - 0.15);
  return Math.round(base * jitter);
}

/** What the task's state asks of the claimer next — the `nextAction` hint of the watch loop. */
export function nextActionHint(t: Pick<Task, 'status'> & Partial<Task>): string {
  const task = t as Partial<Task> & { review_note?: string | null; claim_expires_at?: string | null; auto_release_at?: string | null; payment_status?: string | null };
  switch (task.status) {
    case 'open': return 'claimable';
    case 'claimed': return task.review_note ? 'revise and deliver again (the buyer requested changes)' : `deliver${task.claim_expires_at ? ` before ${task.claim_expires_at}` : ''}`;
    case 'submitted': return `waiting for review${task.auto_release_at ? `; auto-accepts at ${task.auto_release_at}` : ''}`;
    case 'verified':
      if (task.payment_status === 'settled') return 'paid';
      if (task.payment_status === 'failed') return 'accepted; payout failed and is being retried (check tasks payment)';
      return task.payment_status && task.payment_status !== 'none' ? `accepted; payout ${task.payment_status}` : 'accepted';
    case 'cancelled': return 'none (cancelled)';
    case 'expired': return 'none (expired unclaimed)';
    case 'closed': return 'none (closed)';
    default: return 're-fetch the task';
  }
}

/** The fields whose change is worth reporting. */
function watchFingerprint(d: Record<string, unknown>): string {
  const t = (d.task ?? {}) as Record<string, unknown>;
  const escrow = (t.escrow ?? null) as Record<string, unknown> | null;
  return JSON.stringify([t.status, t.payment_status, t.revision_count, t.review_note, t.claimed_by_agent_id, t.disputed_at, escrow?.status, d.receipts_count, d.submission_public]);
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tasksWatch(args: string[]): Promise<void> {
  const { apiUrl, jsonMode } = common(args);
  const taskId = taskIdOrExit(args, 'basedagents tasks watch <id> [--max-hours 24] [--once] [--json]');
  const once = args.includes('--once');
  const maxHours = Number(getFlag(args, '--max-hours') ?? 24);
  if (!Number.isFinite(maxHours) || maxHours <= 0) return fail('--max-hours must be a positive number');
  const base = apiUrl.replace(/\/$/, '');
  const emit = (event: Record<string, unknown>, human: string) => {
    if (jsonMode) console.log(JSON.stringify(event));
    else console.log(human);
  };

  const start = Date.now();
  let lastChange = start;
  let etag: string | undefined;
  let fingerprint: string | undefined;
  let last: Record<string, unknown> | undefined;
  let failures = 0;

  for (;;) {
    let res: Response | null = null;
    try {
      res = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}`, {
        // The one fetch outside RegistryClient: version header as before,
        // plus the shared client headers (interface + optional attribution)
        // when the CLI entrypoint set them.
        headers: { Accept: 'application/json', 'X-BasedAgents-Cli-Version': VERSION, ...getClientHeaders(), ...(etag ? { 'If-None-Match': etag } : {}) },
      });
    } catch (err) {
      failures++;
      if (failures >= 5) return fail(`Could not reach ${base}: ${err instanceof Error ? err.message : 'network error'}`);
    }

    if (res) {
      if (res.status === 429) {
        const wait = Math.max(1, Number(res.headers.get('Retry-After') ?? 60)) * 1000;
        emit({ event: 'rate_limited', task_id: taskId, retry_after_s: wait / 1000, at: new Date().toISOString() }, dim(`  rate limited — waiting ${wait / 1000}s`));
        await sleepMs(wait);
        continue;
      }
      if (res.status === 404) return fail(`Task ${taskId} not found`);
      if (res.status === 304) {
        failures = 0;
      } else if (res.ok) {
        failures = 0;
        etag = res.headers.get('ETag') ?? undefined;
        const data = await res.json() as Record<string, unknown>;
        const fp = watchFingerprint(data);
        if (fp !== fingerprint) {
          fingerprint = fp;
          last = data;
          lastChange = Date.now();
          const t = data.task as Task & Record<string, unknown>;
          const hint = nextActionHint(t);
          emit(
            { event: 'state', task_id: taskId, status: t.status, payment_status: t.payment_status ?? null, revision_count: t.revision_count ?? 0, review_note: t.review_note ?? null, escrow_status: (t.escrow as { status?: string } | null)?.status ?? null, next_action: hint, updated_at: new Date().toISOString() },
            `  ${dim(new Date().toISOString())}  ${statusColor(String(t.status))}  ${dim(hint)}`,
          );
        }
      } else {
        failures++;
        if (failures >= 5) return fail(`The API kept failing (HTTP ${res.status}); stopping. Check GET /v1/health.`);
      }
    }

    const t = (last?.task ?? null) as Record<string, unknown> | null;
    if (once) {
      process.exit(t ? 0 : 1);
    }
    if (t && watchIsDone(t)) {
      emit({ event: 'done', task_id: taskId, reason: 'terminal', status: t.status, payment_status: t.payment_status ?? null }, `  ${green('✓')} ${taskId} is ${t.status}. Done.`);
      process.exit(0);
    }
    if (Date.now() - start > maxHours * 3_600_000) {
      emit({ event: 'done', task_id: taskId, reason: 'timeout', status: t?.status ?? null, watched_hours: maxHours }, yellow(`  Stopped after ${maxHours} h; last status: ${t?.status ?? 'unknown'}. Report this and re-check later.`));
      process.exit(3);
    }
    const backoff = failures ? Math.min(60_000 * failures, 300_000) : 0;
    await sleepMs(Math.max(watchDelayMs(Date.now() - start, Date.now() - lastChange), backoff));
  }
}

// ─── accept ───

/** --rating / --rating-comment → RatingOptions; exits on a value the API would refuse. */
function ratingFlags(args: string[]): { rating?: number; ratingComment?: string } {
  const raw = getFlag(args, '--rating');
  const ratingComment = getFlag(args, '--rating-comment');
  if (raw === undefined) {
    if (ratingComment !== undefined) fail('--rating-comment needs --rating <1-5>.');
    return {};
  }
  const rating = Number(raw);
  if (!/^[1-5]$/.test(raw.trim()) || !Number.isInteger(rating)) fail(`--rating must be a whole number from 1 to 5 (got "${raw}").`);
  if (ratingComment !== undefined && ratingComment.length > 500) fail('--rating-comment is limited to 500 characters.');
  return { rating, ...(ratingComment !== undefined ? { ratingComment } : {}) };
}

export async function tasksAccept(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const taskId = taskIdOrExit(args, 'basedagents tasks accept <id> [--note <text>] [--rating 1-5 [--rating-comment <text>]] [--payment-signature <b64>|@file|-]');
  const note = getFlag(args, '--note');
  const rating = ratingFlags(args);
  const paymentSignature = readSignatureFlag(args);

  const kp = keypairOrExit(keypairFile);
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.acceptTask(kp, taskId, { note, paymentSignature, ...rating });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Accepted`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Status', statusColor(result.status)));
    if (result.accepted_by) console.log(row('Accepted by', result.accepted_by));
    if (result.rating) console.log(row('Rating', `${result.rating}/5`));
    if (result.rating_saved === false) console.log(row('Rating', yellow(result.rating_error ?? "not saved — run tasks accept again to resend it")));
    console.log(row('Payment', result.payment_status === 'settled' ? green(result.payment_status) : result.payment_status));
    if (result.escrow) console.log(row('Escrow', result.escrow.status === 'released' ? green(result.escrow.status) : yellow(result.escrow.status)));
    if (result.payment_tx_hash) console.log(row('TX hash', cyan(result.payment_tx_hash)));
    if (result.settle_error) console.log(row('Settle error', yellow(result.settle_error)));
    if (result.escrow && result.escrow.status !== 'released') {
      console.log(`  ${dim(`The escrow release is retried automatically; follow it with: basedagents tasks payment ${result.task_id}`)}`);
    } else if (result.payment_status === 'authorized' || result.payment_status === 'settling') {
      console.log(`  ${dim(`Settlement is retried automatically; follow it with: basedagents tasks payment ${result.task_id}`)}`);
    } else if (result.payment_status === 'failed') {
      console.log(`  ${dim(`Settlement failed. Run: basedagents tasks payment ${result.task_id} — if next_settle_at is set it retries automatically; otherwise sign a fresh authorization and re-run tasks accept.`)}`);
    }
    console.log('');
  } catch (err) {
    if (err instanceof PaymentRequiredError) exitPaymentRequired(err, `tasks accept ${taskId}`);
    if (err instanceof PaymentInvalidError) paymentInvalidFail(err);
    return apiFail('Failed to accept task', err);
  }
}

// ─── revision ───

export async function tasksRevision(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const usage = 'basedagents tasks revision <id> --note <what to change>';
  const taskId = taskIdOrExit(args, usage);
  const note = getFlag(args, '--note');
  if (!note) return fail(`--note is required.\n  Usage: ${usage}`);

  const kp = keypairOrExit(keypairFile);
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.requestRevision(kp, taskId, note);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Changes requested (round ${result.revision_count} of 3)`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Status', `${statusColor(result.status)} ${dim(`[${result.review_state}]`)}`));
    console.log('');
  } catch (err) {
    return apiFail('Failed to request changes', err);
  }
}

// ─── dispute ───

export async function tasksDispute(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const usage = 'basedagents tasks dispute <id> --reason <why> [--rating 1-5 [--rating-comment <text>]]';
  const taskId = taskIdOrExit(args, usage);
  const reason = getFlag(args, '--reason');
  if (!reason) return fail(`--reason is required.\n  Usage: ${usage}`);
  const rating = ratingFlags(args);

  const kp = keypairOrExit(keypairFile);
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.disputeTask(kp, taskId, reason, rating);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Disputed — auto-accept is frozen`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Status', `${statusColor(result.status)} ${dim(`[${result.review_state}]`)}`));
    if (result.rating) console.log(row('Rating', `${result.rating}/5`));
    console.log(`  ${dim(`Resolve it with: basedagents tasks accept ${result.task_id}  or  basedagents tasks cancel ${result.task_id}`)}`);
    console.log('');
  } catch (err) {
    return apiFail('Failed to dispute task', err);
  }
}

// ─── cancel ───

export async function tasksCancel(args: string[]): Promise<void> {
  const { apiUrl, jsonMode, keypairFile } = common(args);
  const taskId = taskIdOrExit(args, 'basedagents tasks cancel <id>');

  const kp = keypairOrExit(keypairFile);
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.cancelTask(kp, taskId);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${green('✓')} Cancelled`);
    console.log(row('Task ID', cyan(result.task_id)));
    console.log(row('Status', statusColor(result.status)));
    console.log(row('Payment', result.payment_status));
    console.log('');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'dispute_first') {
      console.error(yellow(`\n  Delivered work can only be cancelled after a dispute:`));
      console.error(yellow(`    basedagents tasks dispute ${taskId} --reason "..."\n`));
    }
    return apiFail('Failed to cancel task', err);
  }
}

// ─── payment ───

export async function tasksPayment(args: string[]): Promise<void> {
  const { apiUrl, jsonMode } = common(args);
  const taskId = taskIdOrExit(args, 'basedagents tasks payment <id>');
  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.getTaskPayment(taskId);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const p = result.payment;
    console.log('');
    console.log(`  ${bold('Payment')}  ${cyan(p.task_id)}`);
    console.log('');
    if (p.bounty) {
      console.log(row('Bounty', yellow(`${p.bounty.amount_display} ${p.bounty.token}`) + dim(` on ${p.bounty.network}`)));
    } else {
      console.log(row('Bounty', dim('none')));
    }
    console.log(row('Status', p.status === 'settled' ? green(p.status) : p.status));
    if (p.payment_due) console.log(row('Payment due', yellow('yes — accepted, not paid yet')));
    if (p.accepted_by) console.log(row('Accepted by', p.accepted_by));
    if (p.pay_to) console.log(row('Pay to', p.pay_to));
    if (p.payer) console.log(row('Payer', p.payer));
    if (p.tx_hash) console.log(row('TX hash', cyan(p.tx_hash)));
    if (p.settled_at) console.log(row('Settled at', p.settled_at));
    if (p.expires_at) console.log(row('Auth expires', p.expires_at));
    if (p.auto_release_at) console.log(row('Auto-accept at', p.auto_release_at));
    if (p.last_error) console.log(row('Last error', yellow(p.last_error)));
    if (p.settle_attempts) console.log(row('Settle attempts', String(p.settle_attempts)));
    if (p.next_settle_at) console.log(row('Next attempt', p.next_settle_at));
    console.log('');

    if (result.requirements) {
      const r = result.requirements;
      console.log(`  ${bold('x402 requirements')} ${dim(`(send the signed payload as ${result.payment_header} to ${result.accept_endpoint})`)}`);
      console.log(row('scheme', r.scheme));
      console.log(row('network', r.network));
      console.log(row('asset', r.asset));
      console.log(row('amount', `${r.amount} ${dim('(atomic)')}`));
      console.log(row('payTo', r.payTo));
      console.log(row('maxTimeout', `${r.maxTimeoutSeconds}s`));
      console.log('');
    } else if (result.requirements_unavailable_reason) {
      console.log(`  ${dim(`No x402 requirements yet: ${result.requirements_unavailable_reason}`)}`);
      console.log('');
    }

    if (result.events.length) {
      console.log(`  ${bold('Events')}`);
      for (const e of result.events) {
        console.log(`  ${dim(e.created_at)}  ${e.event_type}${e.details ? dim(`  ${JSON.stringify(e.details)}`) : ''}`);
      }
      console.log('');
    }
  } catch (err) {
    return apiFail('Failed to fetch payment', err);
  }
}
