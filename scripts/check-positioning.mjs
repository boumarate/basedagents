#!/usr/bin/env node
/**
 * check-positioning — the guardrail (POSITIONING_SPEC.md §A4). Fails when:
 *   1. a public surface contains a retired tagline (allowed only in the
 *      /keyring page content and the CHANGELOG);
 *   1b. a public surface, the README body or a blog post calls BasedAgents
 *      "non-custodial" / says it "never holds funds" outside copy about the
 *      per-task escrow opt-out (escrow is the default, and it is custodial);
 *   2. the built homepage (packages/web/dist/index.html) lacks the one-liner in
 *      <title>, the meta description, og:title, or an <h1>;
 *   3. `sync-positioning --check` reports drift.
 * Run after `npm run build --workspace=packages/web`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { custodyViolations } from './lib/custody-claims.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pos = JSON.parse(readFileSync(join(ROOT, 'packages/web/src/content/positioning.json'), 'utf8'));
const failures = [];

// ── 1. retired taglines ──
const SURFACES = [
  'packages/web/public/.well-known/agent.json',
  'packages/web/public/.well-known/ai-plugin.json',
  'packages/web/public/llms.txt',
  'packages/web/public/llms-full.txt',
  'skills/basedagents/SKILL.md',
  'packages/web/public/.well-known/basedagents.json',
  'packages/web/public/_headers',
  'packages/web/index.html',
  'packages/web/registry.html',
  'packages/web/docs/agents.html',
  'packages/sdk/package.json', 'packages/sdk/README.md',
  'packages/mcp/package.json', 'packages/mcp/server.json', 'packages/mcp/README.md',
  'packages/python/pyproject.toml', 'packages/python/README.md', 'packages/python/basedagents/__init__.py',
  'packages/api/src/openapi.json', 'packages/api/src/index.ts', 'packages/api/README.md',
];
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (f.endsWith('.html')) out.push(p);
  }
  return out;
}
const dist = join(ROOT, 'packages/web/dist');
// keyring.html may name the retired Keyring tagline; changelog.html is the
// CHANGELOG rendered (history quotes retired wording on purpose, as the source does).
const builtHtml = existsSync(dist) ? walk(dist).filter((f) => !/[\\/](keyring|changelog)\.html$/.test(f)) : [];
if (!existsSync(dist)) failures.push('packages/web/dist is missing — build the site first');

// README: only the hero between the markers is a public surface here (history/changelog below it is allowed).
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const hs = readme.indexOf('<!-- positioning:start -->'); const he = readme.indexOf('<!-- positioning:end -->');
const readmeHero = hs !== -1 && he !== -1 ? readme.slice(hs, he) : readme;

const texts = [
  ...SURFACES.map((rel) => [rel, existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '']),
  ...builtHtml.map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]),
  ['README.md (hero)', readmeHero],
];
for (const [name, text] of texts) {
  const lower = text.toLowerCase();
  for (const tag of pos.retiredTaglines) {
    if (lower.includes(tag.toLowerCase())) failures.push(`${name}: contains retired tagline "${tag}"`);
  }
}

// ── 1b. custody claims, scoped to default-flow copy (scripts/lib/custody-claims.mjs) ──
// Covers the whole README and the blog, not just the hero.
const blogDir = join(ROOT, 'packages/web/src/blog/posts');
const custodyTexts = [
  ...texts.filter(([name]) => name !== 'README.md (hero)'),
  ['README.md', readme],
  ...(existsSync(blogDir) ? readdirSync(blogDir).map((f) => [`packages/web/src/blog/posts/${f}`, readFileSync(join(blogDir, f), 'utf8')]) : []),
];
for (const [name, text] of custodyTexts) {
  for (const v of custodyViolations(text)) failures.push(`${name}: custody claim ${v} outside opt-out copy (escrow is the default and is custodial)`);
}

// ── 2. the built homepage carries the one-liner ──
const home = join(dist, 'index.html');
if (existsSync(home)) {
  const html = readFileSync(home, 'utf8');
  const needle = pos.oneLiner.replace(/\.$/, '').toLowerCase();
  const has = (re) => re.test(html);
  const titleOk = has(new RegExp(`<title>[^<]*${needle}[^<]*</title>`, 'i'));
  const descOk = has(new RegExp(`<meta name="description" content="[^"]*${needle}`, 'i'));
  const ogOk = has(new RegExp(`<meta property="og:title" content="[^"]*${needle}`, 'i'));
  const h1Ok = has(new RegExp(`<h1[^>]*>(?:(?!</h1>).)*${needle}`, 'is'));
  if (!titleOk) failures.push('dist/index.html: <title> lacks the one-liner');
  if (!descOk) failures.push('dist/index.html: meta description lacks the one-liner');
  if (!ogOk) failures.push('dist/index.html: og:title lacks the one-liner');
  if (!h1Ok) failures.push('dist/index.html: no <h1> carries the one-liner (is the page prerendered?)');
}

// ── 3. sync drift ──
const sync = spawnSync('npx', ['tsx', 'scripts/sync-positioning.ts', '--check'], { cwd: ROOT, encoding: 'utf8' });
if (sync.status !== 0) failures.push((sync.stderr || sync.stdout || 'sync-positioning --check failed').trim());

if (failures.length) {
  console.error('check-positioning: FAILED\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`check-positioning: ok (${texts.length} surfaces, ${builtHtml.length} built pages)`);
