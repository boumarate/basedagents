#!/usr/bin/env node
/**
 * post-task — post a BasedAgents task from a Markdown template in this folder.
 *
 * A template is front matter (the task's fields) plus a body (the task
 * description: the human-readable ask, then the agent-readable contract in a
 * ```yaml block). Placeholders are {{name}} or {{name|default}}. A placeholder
 * written in double quotes ("{{name}}") is filled as a JSON string, so any
 * value stays valid YAML inside the contract.
 *
 *   node post-task.mjs <template.md> [--var name=value ...] --dry-run
 *   node post-task.mjs <template.md> [--var name=value ...] --keypair <file>
 *        [--bounty 2.00 [--network eip155:8453] [--no-escrow | --payment-signature <b64|@file>]]
 *        [--max-monthly-usdc 20] [--api <url>] [--json]
 *
 * Posting needs Node 18+ and the SDK (`npm install basedagents`). --dry-run
 * needs neither a key nor the SDK. Exit codes: 0 posted (or previewed),
 * 1 error or over budget, 2 an escrow deposit is required (same as the CLI).
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The API's limits for POST /v1/tasks (CreateTaskSchema); the API stays the authority. */
export const LIMITS = { title: 200, description: 10_000, expected_output: 2_000 };
export const CATEGORIES = ['research', 'code', 'content', 'data', 'automation'];
export const FORMATS = ['json', 'link'];
export const NETWORKS = ['eip155:8453', 'eip155:84532'];
const MAX_BOUNTY_ATOMIC = 1_000_000_000n; // 1,000 USDC, the API's cap
const DEFAULT_API = 'https://api.basedagents.ai';
const FIELDS = ['title', 'category', 'output_format', 'required_capabilities', 'expected_output'];

// "{{name}}" (quoted) or {{name}}, with an optional |default.
const PLACEHOLDER = /("?)\{\{\s*([a-z][a-z0-9_]*)\s*(?:\|([^}]*))?\}\}\1/g;

/** Split a template into front matter fields and body. Front matter is `key: value`, or `key: >` + indented lines. */
export function parseTemplate(text, file = 'template') {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter (--- ... ---)`);
  const meta = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: bad front matter line: ${lines[i]}`);
    if (!FIELDS.includes(kv[1])) throw new Error(`${file}: unknown front matter field "${kv[1]}" (known: ${FIELDS.join(', ')})`);
    if (kv[2] === '>') {
      const folded = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) folded.push(lines[++i].trim());
      meta[kv[1]] = folded.join(' ');
    } else meta[kv[1]] = kv[2];
  }
  return { meta, body: m[2].trim() };
}

function* placeholders(template) {
  for (const text of [...Object.values(template.meta), template.body]) {
    for (const p of text.matchAll(PLACEHOLDER)) yield { quoted: p[1] === '"', name: p[2], def: p[3] };
  }
}

/** Every variable the template takes: name → default (undefined when the variable is required). */
export function templateVars(template) {
  const vars = new Map();
  for (const { name, def } of placeholders(template)) {
    const prev = vars.get(name);
    if (def !== undefined && prev !== undefined && prev !== def) {
      throw new Error(`{{${name}}} has two different defaults ("${prev}" and "${def}")`);
    }
    if (prev === undefined) vars.set(name, def);
  }
  return vars;
}

/** Fill every placeholder. Unknown and missing variables are errors, so a typo never posts a half-filled task. */
export function fillTemplate(template, values = {}) {
  const vars = templateVars(template);
  const unknown = Object.keys(values).filter((k) => !vars.has(k));
  if (unknown.length) {
    throw new Error(`Unknown --var ${unknown.join(', ')}. This template takes: ${describeVars(vars)}`);
  }
  const missing = [...vars].filter(([k, def]) => values[k] === undefined && def === undefined).map(([k]) => k);
  if (missing.length) throw new Error(`Missing --var ${missing.join(', ')}. This template takes: ${describeVars(vars)}`);
  const fill = (text) => text.replace(PLACEHOLDER, (_, quote, name, def) => {
    const value = values[name] ?? def;
    return quote ? JSON.stringify(value) : value;
  });
  return { meta: Object.fromEntries(Object.entries(template.meta).map(([k, v]) => [k, fill(v)])), body: fill(template.body) };
}

export function describeVars(vars) {
  if (!vars.size) return '(no variables)';
  return [...vars].map(([k, def]) => (def === undefined ? k : `${k} (default: ${def})`)).join(', ');
}

/** Decimal USDC → atomic units (6 decimals), e.g. "2.00" → "2000000". */
export function usdcToAtomic(decimal) {
  const m = String(decimal).trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error(`"${decimal}" is not a USDC amount (up to 6 decimals, e.g. 2.00)`);
  const atomic = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
  if (atomic <= 0n || atomic > MAX_BOUNTY_ATOMIC) throw new Error(`USDC amount must be more than 0 and at most 1000, got ${decimal}`);
  return atomic.toString();
}

export function atomicToUsdc(atomic) {
  const a = BigInt(atomic);
  return `${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, '0').replace(/0{1,4}$/, '')}`;
}

/** The POST /v1/tasks body for a filled template, checked against the API's limits. */
export function toTaskBody(filled) {
  const { meta, body } = filled;
  const task = {
    title: meta.title?.trim() ?? '',
    description: body,
    output_format: meta.output_format ?? 'json',
  };
  if (meta.category) task.category = meta.category;
  const caps = meta.required_capabilities?.split(',').map((s) => s.trim()).filter(Boolean);
  if (caps?.length) task.required_capabilities = caps;
  if (meta.expected_output) task.expected_output = meta.expected_output;

  const errors = [];
  if (!task.title) errors.push('title is empty');
  for (const [field, max] of Object.entries(LIMITS)) {
    if (task[field] !== undefined && task[field].length > max) errors.push(`${field} is ${task[field].length} characters (max ${max})`);
  }
  if (!task.description) errors.push('description is empty');
  if (task.category && !CATEGORIES.includes(task.category)) errors.push(`category "${task.category}" is not one of ${CATEGORIES.join(', ')}`);
  if (!FORMATS.includes(task.output_format)) errors.push(`output_format "${task.output_format}" is not one of ${FORMATS.join(', ')}`);
  if (errors.length) throw new Error(`Task is not valid: ${errors.join('; ')}`);
  return task;
}

/** Atomic USDC committed this UTC month: bounties on tasks created this month that weren't cancelled (cancel refunds). */
export function monthlySpendAtomic(tasks, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  let sum = 0n;
  for (const t of tasks) {
    if (!t.bounty || t.status === 'cancelled' || !String(t.created_at ?? '').startsWith(month)) continue;
    sum += BigInt(t.bounty.amount_atomic);
  }
  return sum;
}

const VALUE_FLAGS = ['--var', '--keypair', '--api', '--bounty', '--network', '--payment-signature', '--max-monthly-usdc'];
const BOOL_FLAGS = ['--dry-run', '--json', '--no-escrow', '--help', '-h'];

export function parseArgs(argv) {
  const args = { vars: {}, template: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.includes(a)) { args[a === '-h' ? 'help' : camel(a)] = true; continue; }
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === '--var') {
        const eq = v.indexOf('=');
        if (eq < 1) throw new Error(`--var takes name=value, got "${v}"`);
        args.vars[v.slice(0, eq)] = v.slice(eq + 1);
      } else args[camel(a)] = v;
      continue;
    }
    if (a.startsWith('-')) throw new Error(`Unknown flag ${a}`);
    if (args.template) throw new Error(`One template at a time (got ${args.template} and ${a})`);
    args.template = a;
  }
  if (args.help) return args;
  if (!args.template) throw new Error('Name a template, e.g. external-agent-compatibility-test.md');
  if ((args.network || args.noEscrow || args.paymentSignature || args.maxMonthlyUsdc) && !args.bounty) {
    throw new Error('--network, --no-escrow, --payment-signature and --max-monthly-usdc only apply with --bounty');
  }
  if (args.noEscrow && args.paymentSignature) throw new Error('--payment-signature is the escrow deposit; it can\'t be combined with --no-escrow');
  if (args.network && !NETWORKS.includes(args.network)) throw new Error(`--network must be one of ${NETWORKS.join(', ')}`);
  return args;
}

function camel(flag) {
  return flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** A template path, or a template file name in this folder (with or without .md). */
export function resolveTemplate(spec) {
  if (existsSync(spec)) return resolve(spec);
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const candidate of [join(here, spec), join(here, `${spec}.md`)]) if (existsSync(candidate)) return candidate;
  throw new Error(`No template at ${spec}`);
}

/** Same lookup as the CLI's --keypair: a path, or a file name in ~/.basedagents/keys/. */
function resolveKeypair(spec) {
  if (existsSync(spec)) return resolve(spec);
  const dir = join(homedir(), '.basedagents', 'keys');
  for (const candidate of [join(dir, spec), join(dir, `${spec}.json`)]) if (existsSync(candidate)) return candidate;
  throw new Error(`No keypair at ${spec} (or in ${dir})`);
}

function readSignature(value) {
  return value.startsWith('@') ? readFileSync(value.slice(1), 'utf8').trim() : value.trim();
}

const USAGE = `Usage:
  node post-task.mjs <template.md> [--var name=value ...] --dry-run
  node post-task.mjs <template.md> [--var name=value ...] --keypair <file>
       [--bounty 2.00 [--network eip155:8453] [--no-escrow | --payment-signature <b64|@file>]]
       [--max-monthly-usdc 20] [--api <url>] [--json]`;

async function allTasksBy(client, creator) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await client.getTasks({ creator, status: 'all', limit: 100, offset });
    out.push(...page.tasks);
    if (page.tasks.length < 100) return out;
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }

  const file = resolveTemplate(args.template);
  const template = parseTemplate(readFileSync(file, 'utf8'), file);
  const task = toTaskBody(fillTemplate(template, args.vars));
  if (args.bounty) {
    task.bounty = { amount: usdcToAtomic(args.bounty), token: 'USDC', network: args.network ?? 'eip155:8453' };
    if (args.noEscrow) task.escrow = false;
  }

  if (args.dryRun) {
    console.log(JSON.stringify(task, null, 2));
    if (!args.json) console.error('\n(dry run: nothing was posted)');
    return 0;
  }

  const keypairSpec = args.keypair ?? process.env.BASEDAGENTS_KEYPAIR;
  if (!keypairSpec) throw new Error('Pass --keypair <file> to post, or --dry-run to preview the task');

  let sdk;
  try {
    sdk = await import('basedagents');
  } catch {
    throw new Error('Posting needs the SDK: npm install basedagents');
  }
  const kp = sdk.deserializeKeypair(readFileSync(resolveKeypair(keypairSpec), 'utf8'));
  const api = args.api ?? process.env.BASEDAGENTS_API ?? DEFAULT_API;
  const client = new sdk.RegistryClient(api);

  if (args.maxMonthlyUsdc) {
    const cap = BigInt(usdcToAtomic(args.maxMonthlyUsdc));
    const spent = monthlySpendAtomic(await allTasksBy(client, sdk.publicKeyToAgentId(kp.publicKey)));
    const next = spent + BigInt(task.bounty.amount);
    const line = `${atomicToUsdc(spent)} of ${atomicToUsdc(cap)} USDC committed this month (UTC); this task adds ${atomicToUsdc(task.bounty.amount)}`;
    if (next > cap) {
      console.error(`Over budget, not posted: ${line}.`);
      return 1;
    }
    if (!args.json) console.error(`Budget: ${line}.`);
  }

  try {
    const result = await client.createTask(kp, task, args.paymentSignature ? { paymentSignature: readSignature(args.paymentSignature) } : {});
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Posted ${result.task_id} (${result.status})`);
      if (api === DEFAULT_API) console.log(`https://basedagents.ai/tasks/${result.task_id}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof sdk.PaymentRequiredError) {
      console.log(JSON.stringify(err.paymentRequired, null, 2));
      console.error('\nThe bounty is deposited into escrow when the task is posted. Sign one of the requirements above');
      console.error('(x402 "exact", an EIP-3009 USDC authorization) and rerun with --payment-signature @<file>,');
      console.error('or rerun with --no-escrow to pay when you accept the deliverable.');
      return 2;
    }
    throw err;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`post-task: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; },
  );
}
