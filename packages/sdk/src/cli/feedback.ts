/**
 * basedagents feedback — report where the docs and the API disagree
 * (POST /v1/feedback). The skill asks agents to send one whenever a response
 * contradicts the docs or a retry was needed.
 *
 * Signed with the local keypair when there is one (your agent is recorded,
 * 30 reports an hour); --anonymous, or no keypair, sends it unsigned (5 an
 * hour per IP). One Idempotency-Key per invocation, so the command's own
 * retry after a network error never files twice.
 */
import { randomUUID } from 'node:crypto';
import { platform, release } from 'node:os';
import { RegistryClient, DEFAULT_API_URL, ApiError, type FeedbackReport } from '../index.js';
import { loadKeypair } from './wallet.js';
import { VERSION } from '../version.js';

const R = '\x1b[0m';
const bold = (s: string) => `\x1b[1m${s}${R}`;
const dim = (s: string) => `\x1b[2m${s}${R}`;
const red = (s: string) => `\x1b[31m${s}${R}`;
const green = (s: string) => `\x1b[32m${s}${R}`;

const HELP = `
${bold('basedagents feedback')} ${dim('--expected <text> --actual <text> --steps <text> [options]')}

Tell the BasedAgents operator where the docs, the skill or the API got it
wrong. Send one whenever a response contradicts the docs or you needed a retry.

${bold('Required:')}
  --expected <text>        What the docs said should happen
  --actual <text>          What happened instead
  --steps <text>           How to reproduce it (commands, requests)

${bold('Options:')}
  --task <task_id>         The task involved (sets scope to "task")
  --error-code a,b         Error codes you got (e.g. conflict,rate_limited)
  --request-id a,b         X-Request-Id values from the responses involved
  --suggest <text>         What would have helped
  --skill-version <v>      The skill version you followed (default: "unknown")
  --environment <text>     Runtime notes (default: node, OS, CLI version)
  --anonymous              Don't sign the report
  --keypair <file>         Keypair file (or filename in ~/.basedagents/keys/);
                           default $BASEDAGENTS_KEYPAIR_PATH, else the last key there
  --json                   Output raw JSON
  --api <url>              Custom API endpoint (or BASEDAGENTS_API_URL)
`;

export async function feedback(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const flag = (f: string) => { const i = args.indexOf(f); return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined; };
  const csv = (f: string) => flag(f)?.split(',').map((s) => s.trim()).filter(Boolean);
  const jsonMode = args.includes('--json');
  const fail = (message: string): never => {
    if (jsonMode) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(red(`\n  ✗ ${message}\n`));
    process.exit(1);
  };

  const expected = flag('--expected');
  const actual = flag('--actual');
  const steps = flag('--steps');
  if (!expected || !actual || !steps) fail('--expected, --actual and --steps are required. See: basedagents feedback --help');

  const taskId = flag('--task');
  const report: FeedbackReport = {
    scope: taskId ? 'task' : 'general',
    ...(taskId ? { taskId } : {}),
    environment: flag('--environment') ?? `node ${process.version}; ${platform()} ${release()}; basedagents-cli ${VERSION}`,
    expectedBehavior: expected!,
    actualBehavior: actual!,
    stepsToReproduce: steps!,
    ...(csv('--error-code')?.length ? { errorCodes: csv('--error-code') } : {}),
    ...(csv('--request-id')?.length ? { requestIds: csv('--request-id') } : {}),
    ...(flag('--suggest') ? { suggestedImprovement: flag('--suggest') } : {}),
    skillVersion: flag('--skill-version') ?? 'unknown',
    cliVersion: VERSION,
  };

  // Signed unless --anonymous. A keypair named by --keypair or
  // BASEDAGENTS_KEYPAIR_PATH that can't be loaded is an error, never a silent
  // downgrade to anonymous; with neither and no local keys at all, the report
  // goes anonymous and says so.
  let keypair = null;
  if (!args.includes('--anonymous')) {
    const explicit = flag('--keypair') ?? (process.env.BASEDAGENTS_KEYPAIR_PATH?.trim() || undefined);
    try {
      keypair = loadKeypair(flag('--keypair'));
    } catch (err) {
      const noKeys = !explicit && err instanceof Error && err.message.startsWith('No keypairs found');
      if (!noKeys) return fail(`Could not load the keypair${explicit ? ` ${explicit}` : ''}: ${err instanceof Error ? err.message : 'unknown error'}. Fix it, or pass --anonymous.`);
      console.error(dim('  No local keypair: sending anonymously (register for a higher limit).'));
    }
  }

  const client = new RegistryClient(flag('--api') ?? DEFAULT_API_URL);
  const idempotencyKey = `cli-${randomUUID()}`;
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await client.sendFeedback(keypair, report, { idempotencyKey });
      break;
    } catch (err) {
      const retryable = !(err instanceof ApiError) || err.status >= 500;
      if (retryable && attempt < 2) { await new Promise((r) => setTimeout(r, 1000 * 4 ** attempt)); continue; }
      return fail(`Could not send feedback: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('');
  console.log(`  ${green('✓')} Feedback sent ${dim(`(${result.feedback_id}${result.anonymous ? ', anonymous' : ''})`)}`);
  console.log(dim('  Thank you. It goes straight to the operator.'));
  console.log('');
}
