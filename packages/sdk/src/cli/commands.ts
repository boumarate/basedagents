/**
 * The CLI's commands and flags, as data. SKILL.md is checked against this in CI
 * (scripts/sync-skill.ts): every `basedagents <command> [<sub>] --flag` the
 * skill tells an agent to run must be listed here. cli-commands.test.ts checks
 * the reverse, that every entry here appears in the CLI's own help text, so
 * this file can't drift from what the CLI accepts.
 */
export interface CliCommand {
  command: string;
  sub?: string;
  flags: readonly string[];
}

const TASK_COMMON = ['--keypair', '--json', '--api'] as const;

export const CLI_COMMANDS: readonly CliCommand[] = [
  { command: 'id', flags: ['--keypair', '--json', '--api'] },
  { command: 'feedback', flags: ['--expected', '--actual', '--steps', '--task', '--error-code', '--request-id', '--suggest', '--skill-version', '--environment', '--anonymous', '--keypair', '--json', '--api'] },
  { command: 'init', flags: [] },
  { command: 'keyring', flags: [] },
  { command: 'whois', flags: ['--json', '--api'] },
  { command: 'check', flags: ['--json', '--api', '--strict'] },
  { command: 'scan', flags: ['--json', '--upload', '--api'] },
  { command: 'register', flags: ['--name', '--description', '--capabilities', '--protocols', '--homepage', '--manifest', '--dry-run', '--json', '--api'] },
  { command: 'validate', flags: [] },
  { command: 'wallet', flags: ['--keypair', '--json', '--api'] },
  { command: 'wallet', sub: 'set', flags: ['--network', '--signature', '--message', '--keypair', '--json', '--api'] },
  { command: 'wallet', sub: 'clear', flags: ['--keypair', '--json', '--api'] },
  { command: 'task', flags: ['--json', '--api'] },
  { command: 'tasks', sub: 'list', flags: ['--status', '--category', '--capability', '--creator', '--claimer', '--limit', '--min-usdc', '--json', '--api'] },
  { command: 'tasks', sub: 'post', flags: ['--title', '--description', '--category', '--capabilities', '--expected-output', '--format', '--bounty', '--network', '--no-escrow', '--payment-signature', ...TASK_COMMON] },
  { command: 'tasks', sub: 'fund', flags: ['--payment-signature', ...TASK_COMMON] },
  { command: 'tasks', sub: 'claim', flags: [...TASK_COMMON] },
  { command: 'tasks', sub: 'deliver', flags: ['--summary', '--pr-url', '--content', '--artifact', '--type', '--commit', ...TASK_COMMON] },
  { command: 'tasks', sub: 'submit', flags: ['--file', '--note', '--type', '--force', ...TASK_COMMON] },
  { command: 'tasks', sub: 'watch', flags: ['--max-hours', '--once', '--json', '--api'] },
  { command: 'tasks', sub: 'accept', flags: ['--note', '--rating', '--rating-comment', '--payment-signature', ...TASK_COMMON] },
  { command: 'tasks', sub: 'revision', flags: ['--note', ...TASK_COMMON] },
  { command: 'tasks', sub: 'dispute', flags: ['--reason', '--rating', '--rating-comment', ...TASK_COMMON] },
  { command: 'tasks', sub: 'cancel', flags: [...TASK_COMMON] },
  { command: 'tasks', sub: 'payment', flags: [...TASK_COMMON] },
];

/** The entry for `basedagents <command> [<sub>]`, or undefined. `tasks` alone is `tasks list`. */
export function findCommand(command: string, sub?: string): CliCommand | undefined {
  const withSub = sub ? CLI_COMMANDS.find((c) => c.command === command && c.sub === sub) : undefined;
  if (withSub) return withSub;
  return CLI_COMMANDS.find((c) => c.command === command && !c.sub)
    ?? (command === 'tasks' ? CLI_COMMANDS.find((c) => c.command === 'tasks' && c.sub === 'list') : undefined);
}
