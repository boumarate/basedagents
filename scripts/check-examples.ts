#!/usr/bin/env tsx
/**
 * check-examples — keeps examples/ usable (CI). Fails when:
 *   1. a task template in examples/tasks/ doesn't pass the API's own
 *      CreateTaskSchema once filled. Every variable gets a hostile value
 *      (quotes, a colon, a `#`, a newline), and defaults are used where they exist;
 *   2. a filled template's ```yaml contract doesn't parse, isn't a mapping, or
 *      lacks task_type / required_output / acceptance;
 *   3. a contract uses an unquoted placeholder (only "{{name}}" is safe in YAML);
 *   4. a template variable isn't documented in examples/tasks/README.md;
 *   5. an examples/*.manifest.json fails `basedagents validate` or gets any
 *      recommendation from it (examples model complete manifests).
 *
 *   npx tsx scripts/check-examples.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { CreateTaskSchema } from '../packages/api/src/types/index.js';
import { validate } from '../packages/sdk/src/cli/validate.js';
import { parseTemplate, templateVars, fillTemplate, toTaskBody } from '../examples/tasks/post-task.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(ROOT, 'examples/tasks');
const HOSTILE = 'x: "y" # z\nsecond line';
const YAML_BLOCK = /```yaml\n([\s\S]*?)```/g;
const failures: string[] = [];

const readme = readFileSync(join(TASKS, 'README.md'), 'utf8');
const templates = readdirSync(TASKS).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
if (templates.length === 0) failures.push('examples/tasks: no templates found');

for (const file of templates) {
  const where = `examples/tasks/${file}`;
  try {
    const template = parseTemplate(readFileSync(join(TASKS, file), 'utf8'), where);

    // 3. contracts use quoted placeholders only
    for (const [, block] of template.body.matchAll(YAML_BLOCK)) {
      for (const m of block.matchAll(/("?)\{\{\s*([a-z0-9_]+)[^}]*\}\}("?)/g)) {
        if (!(m[1] === '"' && m[3] === '"')) failures.push(`${where}: contract placeholder {{${m[2]}}} must be quoted ("{{${m[2]}}}")`);
      }
    }

    const vars = templateVars(template);
    // 4. documented
    for (const name of vars.keys()) {
      if (!readme.includes(`\`${name}\``)) failures.push(`${where}: variable ${name} isn't documented in examples/tasks/README.md`);
    }

    // 1. fills and passes the API schema: hostile values, and defaults alone
    const required = Object.fromEntries([...vars].filter(([, def]) => def === undefined).map(([k]) => [k, HOSTILE]));
    const allHostile = Object.fromEntries([...vars.keys()].map((k) => [k, HOSTILE]));
    for (const [label, values] of [['defaults', required], ['hostile values', allHostile]] as const) {
      const filled = fillTemplate(template, values);
      const body = toTaskBody(filled);
      const parsed = CreateTaskSchema.safeParse(body);
      if (!parsed.success) failures.push(`${where} (${label}): rejected by CreateTaskSchema: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);

      // 2. contract parses
      const blocks = [...filled.body.matchAll(YAML_BLOCK)].map((m) => m[1]);
      if (blocks.length !== 1) failures.push(`${where}: expected one \`\`\`yaml contract block, found ${blocks.length}`);
      for (const block of blocks) {
        let doc: unknown;
        try {
          doc = yaml.load(block);
        } catch (err) {
          failures.push(`${where} (${label}): contract is not valid YAML: ${(err as Error).message.split('\n')[0]}`);
          continue;
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { failures.push(`${where}: contract is not a YAML mapping`); continue; }
        for (const key of ['task_type', 'required_output', 'acceptance']) {
          if (!(key in doc)) failures.push(`${where}: contract lacks ${key}`);
        }
      }
    }
  } catch (err) {
    failures.push(`${where}: ${(err as Error).message}`);
  }
}

// 5. manifests: `basedagents validate`, with no errors and no recommendations (its report is shown on failure)
const manifests = readdirSync(join(ROOT, 'examples')).filter((f) => f.endsWith('.manifest.json')).sort();
for (const file of manifests) {
  const out: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { out.push(args.join(' ')); };
  let result;
  try {
    result = validate(join(ROOT, 'examples', file));
  } finally {
    console.log = log;
  }
  if (!result.valid || result.warningCount > 0) {
    failures.push(`examples/${file}: basedagents validate reported ${result.errorCount} error(s) and ${result.warningCount} recommendation(s):\n${out.join('\n')}`);
  }
}

if (failures.length) {
  console.error('check-examples: FAILED\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`check-examples: ok (${templates.length} task templates, ${manifests.length} manifests)`);
