#!/usr/bin/env node
/**
 * check-prod-drift — does the LIVE site say what positioning.ts says?
 *
 * check-positioning.mjs catches drift inside the repo; this catches drift
 * between the repo and production (a deploy that didn't land, a stale Pages
 * deployment bound to the apex, an edge cache serving an old head). Fetches:
 *
 *   /                        <title> = siteTitle; og:image + twitter:image = ogImage (…?v=N)
 *   /tasks                   <title> = routeMeta['/tasks'].title; og:image + twitter:image = ogImage
 *   /llms.txt                carries the one-liner
 *   /.well-known/agent.json  tagline = the one-liner
 *
 *   node scripts/check-prod-drift.mjs [--base https://basedagents.ai] [--retries 0] [--delay 15]
 *
 * Retries cover Pages propagation right after a deploy: every attempt
 * re-fetches all four URLs, and the check passes on the first clean attempt.
 * Sends X-Canary when CANARY_BYPASS is set (same WAF skip rule as the canary).
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What production must serve, derived from positioning.json (itself generated from positioning.ts). */
export function expectations(pos) {
  const oneLiner = pos.oneLiner.replace(/\.$/, '');
  return {
    '/': { kind: 'html', title: pos.routeMeta['/'].title, ogImage: pos.ogImage },
    '/tasks': { kind: 'html', title: pos.routeMeta['/tasks'].title, ogImage: pos.ogImage },
    '/llms.txt': { kind: 'text', contains: oneLiner },
    '/.well-known/agent.json': { kind: 'json', tagline: oneLiner },
  };
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function meta(html, attr, name) {
  const m = html.match(new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`, 'i'))
    || html.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*${attr}="${name}"`, 'i'));
  return m ? decode(m[1]) : null;
}

/** Problems with one fetched body, [] when it matches. Pure, so the self-test can drive it. */
export function checkBody(path, body, exp) {
  const out = [];
  if (exp.kind === 'html') {
    const t = body.match(/<title>([^<]*)<\/title>/i);
    const title = t ? decode(t[1]).trim() : null;
    if (title !== exp.title) out.push(`${path}: <title> is ${JSON.stringify(title)}, expected ${JSON.stringify(exp.title)}`);
    for (const [attr, name] of [['property', 'og:image'], ['name', 'twitter:image']]) {
      const v = meta(body, attr, name);
      if (v !== exp.ogImage) out.push(`${path}: ${name} is ${JSON.stringify(v)}, expected ${JSON.stringify(exp.ogImage)}`);
    }
  } else if (exp.kind === 'text') {
    if (!body.includes(exp.contains)) out.push(`${path}: does not carry ${JSON.stringify(exp.contains)}`);
  } else if (exp.kind === 'json') {
    let tagline;
    try { tagline = JSON.parse(body).tagline; } catch { out.push(`${path}: not valid JSON`); return out; }
    if (tagline !== exp.tagline) out.push(`${path}: tagline is ${JSON.stringify(tagline)}, expected ${JSON.stringify(exp.tagline)}`);
  }
  return out;
}

/** One pass over every checked URL. Returns problems ([] = production matches). */
export async function checkSite(base, exp, { fetchImpl = fetch, headers = {} } = {}) {
  const problems = [];
  for (const [path, e] of Object.entries(exp)) {
    // Cache-bust the edge, not the origin: a query string Pages ignores.
    const url = `${base.replace(/\/$/, '')}${path}?drift=${Date.now()}`;
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'user-agent': 'basedagents-drift-check', ...headers }, redirect: 'follow' });
    } catch (err) {
      problems.push(`${path}: fetch failed (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const body = await res.text();
    if (res.status === 429 || /^error code: 10\d\d$/.test(body.trim())) {
      problems.push(`${path}: Cloudflare edge throttled the check (HTTP ${res.status}) — edge rate limiting, not drift`);
      continue;
    }
    if (!res.ok) { problems.push(`${path}: HTTP ${res.status}`); continue; }
    problems.push(...checkBody(path, body, e));
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; };
  const pos = JSON.parse(readFileSync(join(ROOT, 'packages/web/src/content/positioning.json'), 'utf8'));
  const base = flag('--base', pos.urls.site);
  const retries = Number(flag('--retries', '0'));
  const delay = Number(flag('--delay', '15'));
  const headers = process.env.CANARY_BYPASS ? { 'X-Canary': process.env.CANARY_BYPASS } : {};
  const exp = expectations(pos);

  let problems = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    problems = await checkSite(base, exp, { headers });
    if (!problems.length) {
      console.log(`check-prod-drift: ok — ${base} matches positioning (${Object.keys(exp).join(', ')})`);
      return;
    }
    if (attempt < retries) {
      console.log(`check-prod-drift: attempt ${attempt + 1}/${retries + 1} found ${problems.length} problem(s); retrying in ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
  console.error(`check-prod-drift: FAILED — ${base} does not match positioning.ts\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
