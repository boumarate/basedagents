#!/usr/bin/env node
/**
 * Prerender `/`, `/tasks` and `/about` into static HTML after `vite build` (POSITIONING_SPEC.md §A1).
 *
 *   1. `vite build --ssr src/entry-server.tsx --outDir dist-ssr` → a Node bundle
 *      exporting render(url);
 *   2. for each route, render the React tree with a static router and splice
 *      it into the built dist/index.html (same hashed assets, so hydration
 *      matches byte for byte);
 *   3. per-route <title>/description/canonical/og from positioning.routeMeta;
 *   4. write dist/index.html (/) and dist/<route>.html (e.g. tasks.html, served at /tasks) —
 *      Cloudflare Pages serves both ahead of the `/* → /index.html` fallback.
 *
 * Dynamic sections render their stable placeholder (loading state) here and
 * fill in client-side after hydration, so there are no hydration mismatches.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(web, 'dist');
const ssrDir = join(web, 'dist-ssr');
const pos = JSON.parse(readFileSync(join(web, 'src/content/positioning.json'), 'utf8'));

const build = spawnSync('npx', ['vite', 'build', '--ssr', 'src/entry-server.tsx', '--outDir', 'dist-ssr', '--logLevel', 'warn'], { cwd: web, stdio: 'inherit' });
if (build.status !== 0) { console.error('prerender: SSR build failed'); process.exit(1); }

const { render } = await import(pathToFileURL(join(ssrDir, 'entry-server.js')).href);
const template = readFileSync(join(dist, 'index.html'), 'utf8');
if (!template.includes('<div id="root"></div>')) { console.error('prerender: dist/index.html has no empty #root'); process.exit(1); }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const site = pos.urls.site;

function withRouteMeta(html, route) {
  const meta = pos.routeMeta[route];
  if (!meta || route === '/') return html;
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(meta.description)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${site}${route}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(meta.title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(meta.description)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${site}${route}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(meta.title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(meta.description)}$2`);
}

for (const route of pos.routes.prerendered) {
  const markup = render(route);
  if (!markup || markup.length < 500) { console.error(`prerender: ${route} rendered ${markup?.length ?? 0} bytes`); process.exit(1); }
  const html = withRouteMeta(template, route).replace('<div id="root"></div>', `<div id="root" data-prerendered="${route}">${markup}</div>`);
  // Non-root routes become `<route>.html`: Cloudflare Pages serves a named
  // .html asset at its pretty URL (/tasks.html → /tasks, 200) with no
  // redirect, whereas a directory index (tasks/index.html) 308s to /tasks/.
  const out = route === '/' ? join(dist, 'index.html') : join(dist, `${route.replace(/^\//, '')}.html`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`prerendered ${route} → ${out.replace(web + '/', '')} (${markup.length} bytes of markup)`);
}
if (existsSync(ssrDir)) rmSync(ssrDir, { recursive: true, force: true });
