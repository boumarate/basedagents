// node --test examples/tasks/post-task.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  parseTemplate, templateVars, fillTemplate, toTaskBody, usdcToAtomic, atomicToUsdc,
  monthlySpendAtomic, parseArgs, main, LIMITS,
} from './post-task.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEMPLATES = readdirSync(here).filter((f) => f.endsWith('.md') && f !== 'README.md');

const tpl = (front, body) => parseTemplate(`---\n${front}\n---\n${body}\n`);

test('front matter: plain and folded values', () => {
  const t = tpl('title: Hello {{name}}\nexpected_output: >\n  line one\n  line two\ncategory: data', 'Body');
  assert.deepEqual(t.meta, { title: 'Hello {{name}}', expected_output: 'line one line two', category: 'data' });
  assert.equal(t.body, 'Body');
  assert.throws(() => tpl('titel: typo', 'x'), /unknown front matter field "titel"/);
  assert.throws(() => parseTemplate('no front matter'), /missing front matter/);
});

test('variables: required, defaulted, and conflicting defaults', () => {
  const t = tpl('title: {{a}} on {{env|Windows 11}}', 'Run on {{env|Windows 11}}, see {{a}}');
  assert.deepEqual([...templateVars(t)], [['a', undefined], ['env', 'Windows 11']]);
  assert.throws(() => templateVars(tpl('title: {{x|1}}', '{{x|2}}')), /two different defaults/);
});

test('fill: quoted placeholders become JSON strings, unquoted are raw', () => {
  const t = tpl('title: T {{v}}', 'prose {{v}}\n```yaml\nkey: "{{v}}"\n```');
  const value = 'a "quoted": value\nsecond line';
  const filled = fillTemplate(t, { v: value });
  assert.equal(filled.meta.title, `T ${value}`);
  assert.ok(filled.body.includes(`prose ${value}`));
  assert.ok(filled.body.includes(`key: ${JSON.stringify(value)}`));
});

test('fill: missing and unknown variables are errors that list what the template takes', () => {
  const t = tpl('title: {{a}}', '{{b|x}}');
  assert.throws(() => fillTemplate(t, {}), /Missing --var a\. This template takes: a, b \(default: x\)/);
  assert.throws(() => fillTemplate(t, { a: '1', c: '2' }), /Unknown --var c/);
  assert.equal(fillTemplate(t, { a: '1' }).body, 'x');
  assert.equal(fillTemplate(t, { a: '1', b: '' }).body, '', 'an explicit empty value wins over the default');
});

test('task body: fields, capabilities, and the API limits', () => {
  const body = toTaskBody({ meta: { title: 'T', category: 'code', required_capabilities: 'os-windows, code-execution', output_format: 'json' }, body: 'D' });
  assert.deepEqual(body, { title: 'T', description: 'D', output_format: 'json', category: 'code', required_capabilities: ['os-windows', 'code-execution'] });
  assert.throws(() => toTaskBody({ meta: { title: 'x'.repeat(LIMITS.title + 1) }, body: 'D' }), /title is 201 characters/);
  assert.throws(() => toTaskBody({ meta: { title: 'T', category: 'misc' }, body: 'D' }), /category "misc"/);
  assert.throws(() => toTaskBody({ meta: { title: 'T', output_format: 'pdf' }, body: 'D' }), /output_format "pdf"/);
});

test('USDC amounts', () => {
  assert.equal(usdcToAtomic('2.00'), '2000000');
  assert.equal(usdcToAtomic('0.5'), '500000');
  assert.equal(atomicToUsdc('2000000'), '2.00');
  assert.equal(atomicToUsdc('1234567'), '1.234567');
  assert.throws(() => usdcToAtomic('0'), /more than 0/);
  assert.throws(() => usdcToAtomic('1001'), /at most 1000/);
  assert.throws(() => usdcToAtomic('1.2345678'), /not a USDC amount/);
});

test('monthly spend counts this month\'s bounties, not cancelled or free tasks', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const bounty = (amount) => ({ amount_atomic: amount });
  const tasks = [
    { status: 'open', created_at: '2026-09-02T10:00:00Z', bounty: bounty('2000000') },
    { status: 'verified', created_at: '2026-09-20 08:00:00', bounty: bounty('1500000') },
    { status: 'cancelled', created_at: '2026-09-21T08:00:00Z', bounty: bounty('9000000') },
    { status: 'open', created_at: '2026-08-31T23:59:59Z', bounty: bounty('9000000') },
    { status: 'open', created_at: '2026-09-22T08:00:00Z', bounty: null },
  ];
  assert.equal(monthlySpendAtomic(tasks, now), 3_500_000n);
});

test('arguments', () => {
  const a = parseArgs(['t.md', '--var', 'x=1=2', '--bounty', '2.00', '--no-escrow', '--max-monthly-usdc', '20', '--dry-run']);
  assert.deepEqual(a.vars, { x: '1=2' });
  assert.equal(a.bounty, '2.00');
  assert.equal(a.noEscrow, true);
  assert.equal(a.maxMonthlyUsdc, '20');
  assert.equal(a.dryRun, true);
  assert.throws(() => parseArgs(['t.md', '--no-escrow']), /only apply with --bounty/);
  assert.throws(() => parseArgs(['t.md', '--bounty', '1', '--no-escrow', '--payment-signature', 'x']), /can't be combined/);
  assert.throws(() => parseArgs(['t.md', '--title', 'x']), /Unknown flag --title/);
  assert.throws(() => parseArgs(['t.md', '--var', 'novalue']), /name=value/);
  assert.throws(() => parseArgs([]), /Name a template/);
});

test('posting without a key refuses before loading the SDK', async () => {
  await assert.rejects(main(['real-world-failure-sample.md']), /Pass --keypair/);
});

for (const file of TEMPLATES) {
  test(`template ${file}: fills and fits the API limits`, () => {
    const t = parseTemplate(readFileSync(join(here, file), 'utf8'), file);
    const values = Object.fromEntries([...templateVars(t)].map(([k]) => [k, `sample ${k}`]));
    const body = toTaskBody(fillTemplate(t, values));
    assert.ok(body.description.includes('```yaml'), 'has a contract block');
    assert.ok(body.expected_output, 'has expected_output');
    assert.equal(body.output_format, 'json');
    assert.ok(body.required_capabilities?.length, 'names the capability it is buying');
  });
}
