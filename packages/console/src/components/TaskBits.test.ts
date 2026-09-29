import { describe, it, expect } from 'vitest';
import { mdExcerpt } from './TaskBits.js';

describe('mdExcerpt', () => {
  it('strips the Markdown syntax a list card should not show', () => {
    const md = [
      '## What to build',
      '',
      'A **single-file** checker that reads `/.well-known/x402` and follows *every* row.',
      '',
      '- first item',
      '1. numbered item',
      '> quoted line',
      '',
      '---',
      '',
      'See [the docs](https://basedagents.ai/docs/agents) and ![diagram](https://x/y.png).',
    ].join('\n');
    expect(mdExcerpt(md)).toBe(
      'What to build A single-file checker that reads /.well-known/x402 and follows every row. ' +
        'first item numbered item quoted line See the docs and diagram.',
    );
  });

  it('drops fenced code blocks and keeps inline code text', () => {
    expect(mdExcerpt('Run it:\n```bash\nnode verify.mjs\n```\nthen check `posted.json`.')).toBe(
      'Run it: then check posted.json.',
    );
  });

  it('leaves snake_case identifiers alone', () => {
    expect(mdExcerpt('Set BASEDAGENTS_KEYPAIR and read task_id from workflow_dispatch.')).toBe(
      'Set BASEDAGENTS_KEYPAIR and read task_id from workflow_dispatch.',
    );
  });

  it('cuts long text on a word boundary with an ellipsis', () => {
    const out = mdExcerpt('alpha beta gamma delta epsilon', 18);
    expect(out).toBe('alpha beta gamma…');
    expect(mdExcerpt('short text', 18)).toBe('short text');
  });
});
