#!/usr/bin/env node
/**
 * check-front-door — does a LIVE host serve the agent front door (WS1)?
 *
 * For each host given, `/` must negotiate:
 *   Accept: text/markdown     → 200 text/markdown, the skill, sha256 = the repo's skill.json
 *   same + If-None-Match      → 304
 *   Accept: application/json  → the descriptor for the repo's skill version
 *   Accept: text/html         → the page (site, console) or a redirect (api), never markdown/JSON
 *   every negotiated response → Vary: Accept
 * and /.well-known/basedagents.json must equal the repo's descriptor, with the
 * same value on every host. The site must also serve /skill.md and
 * /skills/basedagents/skill.json matching the repo, and /changelog (+ .json).
 *
 *   node scripts/check-front-door.mjs --site https://basedagents.ai --api https://api.basedagents.ai \
 *     --console https://app.basedagents.ai [--retries 0] [--delay 15]
 *
 * Retries cover Pages propagation right after a deploy. Sends X-Canary when
 * CANARY_BYPASS is set (same WAF skip rule as the canary and the drift check).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function repoExpectations(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages/web/public/skills/basedagents/skill.json'), 'utf8'));
  const descriptor = JSON.parse(readFileSync(join(root, 'packages/web/public/.well-known/basedagents.json'), 'utf8'));
  return { manifest, descriptor };
}

async function fetchText(url, headers = {}) {
  const extra = process.env.CANARY_BYPASS ? { 'X-Canary': process.env.CANARY_BYPASS } : {};
  const res = await fetch(url, { headers: { 'User-Agent': 'basedagents-front-door-check', ...extra, ...headers }, redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: res.status === 304 ? '' : await res.text() };
}

/** Problems with one host, [] when it serves the front door correctly. */
export async function checkHost(kind, base, exp) {
  const out = [];
  const at = (p) => `${kind} ${base}${p}`;
  const vary = (r, label) => { if (!/\baccept\b/i.test(r.headers.get('vary') ?? '')) out.push(`${label}: missing Vary: Accept`); };

  const md = await fetchText(`${base}/`, { Accept: 'text/markdown' });
  if (md.status !== 200) out.push(`${at('/')} [markdown]: HTTP ${md.status}`);
  else {
    if (!/^text\/markdown/i.test(md.headers.get('content-type') ?? '')) out.push(`${at('/')} [markdown]: content-type ${md.headers.get('content-type')}`);
    if (sha(md.body) !== exp.manifest.sha256) out.push(`${at('/')} [markdown]: sha256 ${sha(md.body).slice(0, 12)}… ≠ skill.json ${exp.manifest.sha256.slice(0, 12)}…`);
    vary(md, `${at('/')} [markdown]`);
    const tag = md.headers.get('etag');
    if (!tag) out.push(`${at('/')} [markdown]: no ETag`);
    else {
      const again = await fetchText(`${base}/`, { Accept: 'text/markdown', 'If-None-Match': tag });
      if (again.status !== 304) out.push(`${at('/')} [markdown]: If-None-Match gave HTTP ${again.status}, expected 304`);
    }
  }

  const js = await fetchText(`${base}/`, { Accept: 'application/json' });
  let d = null;
  try { d = JSON.parse(js.body); } catch { /* reported below */ }
  if (js.status !== 200 || !d) out.push(`${at('/')} [json]: HTTP ${js.status}, ${d ? 'json' : 'not JSON'}`);
  else {
    if (d.name !== 'BasedAgents' || d.skill?.version !== exp.manifest.version) out.push(`${at('/')} [json]: descriptor name/version ${d.name}/${d.skill?.version}, expected BasedAgents/${exp.manifest.version}`);
    vary(js, `${at('/')} [json]`);
  }

  const html = await fetchText(`${base}/`, { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
  const htmlOk = kind === 'api' ? html.status === 301 : html.status === 200 && /^text\/html/i.test(html.headers.get('content-type') ?? '');
  if (!htmlOk) out.push(`${at('/')} [browser]: HTTP ${html.status} ${html.headers.get('content-type') ?? ''}`);

  const wk = await fetchText(`${base}/.well-known/basedagents.json`);
  let live = null;
  try { live = JSON.parse(wk.body); } catch { /* reported below */ }
  if (wk.status !== 200 || !live) out.push(`${at('/.well-known/basedagents.json')}: HTTP ${wk.status}`);
  else if (!isDeepStrictEqual(live, exp.descriptor)) out.push(`${at('/.well-known/basedagents.json')}: differs from the repo's descriptor`);

  if (kind === 'site') {
    const skill = await fetchText(`${base}/skill.md`);
    if (skill.status !== 200 || sha(skill.body) !== exp.manifest.sha256) out.push(`${at('/skill.md')}: HTTP ${skill.status}, sha256 ${sha(skill.body).slice(0, 12)}…`);
    const man = await fetchText(`${base}/skills/basedagents/skill.json`);
    let m = null;
    try { m = JSON.parse(man.body); } catch { /* reported below */ }
    if (!m || !isDeepStrictEqual(m, exp.manifest)) out.push(`${at('/skills/basedagents/skill.json')}: HTTP ${man.status}, differs from the repo`);
    const cl = await fetchText(`${base}/changelog.json`);
    let releases = null;
    try { releases = JSON.parse(cl.body).releases; } catch { /* reported below */ }
    if (cl.status !== 200 || !Array.isArray(releases) || releases.length === 0) out.push(`${at('/changelog.json')}: HTTP ${cl.status}, no releases`);
    const page = await fetchText(`${base}/changelog`, { Accept: 'text/html' });
    if (page.status !== 200 || !page.body.includes('<h1>Changelog</h1>')) out.push(`${at('/changelog')}: HTTP ${page.status}, not the changelog page`);
  }
  return out;
}

export async function run(hosts, { retries = 0, delay = 15, exp = repoExpectations(), log = console.log } = {}) {
  let problems = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    problems = [];
    for (const [kind, base] of hosts) {
      try { problems.push(...await checkHost(kind, base.replace(/\/$/, ''), exp)); }
      catch (err) { problems.push(`${kind} ${base}: ${err.message}`); }
    }
    if (!problems.length) {
      log(`front door OK on ${hosts.map(([k]) => k).join(', ')} (skill v${exp.manifest.version})`);
      return [];
    }
    if (attempt < retries) {
      log(`attempt ${attempt + 1}: ${problems.length} problem(s); retrying in ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? undefined : process.argv[i + 1]; };
  const hosts = [['site', arg('--site')], ['api', arg('--api')], ['console', arg('--console')]].filter(([, u]) => u);
  if (!hosts.length) { console.error('usage: check-front-door.mjs --site URL [--api URL] [--console URL] [--retries N] [--delay S]'); process.exit(2); }
  const problems = await run(hosts, { retries: Number(arg('--retries') ?? 0), delay: Number(arg('--delay') ?? 15) });
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
}
