#!/usr/bin/env node
/**
 * /changelog and /changelog.json from the repo's CHANGELOG.md (WS5).
 * Runs after prerender in `npm run build`; writes dist/changelog.html (served
 * at /changelog, ahead of the SPA fallback) and dist/changelog.json.
 *
 *   changelog.json: { source, releases: [{ version, date, entries: [{ title, markdown }] }] }
 *
 * The skill links both, so an agent can see what changed without scraping.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://github.com/maxfain/basedagents/blob/main/CHANGELOG.md';
const md = readFileSync(join(web, '..', '..', 'CHANGELOG.md'), 'utf8');

/** `## [0.8.0] — 2026-07-16` → { version: '0.8.0', date: '2026-07-16' }; `## [Unreleased]` → { version: 'Unreleased', date: null }. */
export function parseChangelog(text) {
  const releases = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const nl = block.indexOf('\n');
    const heading = (nl === -1 ? block : block.slice(0, nl)).trim();
    const body = nl === -1 ? '' : block.slice(nl + 1);
    const m = /^\[([^\]]+)\](?:\s*[—–-]\s*(.+))?$/.exec(heading);
    const entries = body.split(/^### /m).slice(1).map((e) => {
      const i = e.indexOf('\n');
      return { title: (i === -1 ? e : e.slice(0, i)).trim(), markdown: (i === -1 ? '' : e.slice(i + 1)).replace(/\n---\s*$/, '').trim() };
    });
    releases.push({ version: m ? m[1] : heading, date: m?.[2]?.trim() ?? null, entries });
  }
  return releases;
}

const releases = parseChangelog(md);
writeFileSync(join(web, 'dist', 'changelog.json'), JSON.stringify({ source: SOURCE, releases }, null, 2) + '\n');

// Everything after the file's own intro, rendered as-is.
const bodyMd = md.slice(md.indexOf('\n## '));
const content = renderToStaticMarkup(createElement(Markdown, null, bodyMd));
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Changelog — BasedAgents</title>
  <meta name="description" content="Everything that changed in BasedAgents: the API, the CLI and SDK, the MCP server, the site and the agent skill." />
  <link rel="canonical" href="https://basedagents.ai/changelog" />
  <link rel="alternate" type="application/json" href="/changelog.json" title="Changelog (JSON)" />
  <link rel="alternate" type="text/markdown" href="/skill.md" title="Agent runbook (skill)" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root { --bg-primary:#0A0A0B; --bg-secondary:#121215; --accent:#6466E9; --accent-hover:#818CF8; --text-primary:#FAFAFA; --text-secondary:#AAAAB8; --text-tertiary:#6B6B78; --border:#2A2A33; --font-sans:'DM Sans',-apple-system,sans-serif; --font-display:'Space Grotesk',system-ui,sans-serif; --font-mono:'JetBrains Mono',monospace; }
    * { box-sizing:border-box; margin:0; padding:0; }
    html { font-size:15px; line-height:1.65; -webkit-font-smoothing:antialiased; }
    body { font-family:var(--font-sans); background:var(--bg-primary); color:var(--text-primary); }
    a { color:var(--accent); text-decoration:none; overflow-wrap:anywhere; } a:hover { color:var(--accent-hover); }
    .nav { border-bottom:1px solid var(--border); }
    .nav-inner { max-width:900px; margin:0 auto; padding:14px 24px; display:flex; gap:18px; align-items:center; }
    .nav-logo { display:flex; align-items:center; gap:8px; color:var(--text-primary); font-weight:700; }
    .nav-logo-mark { color:var(--accent); font-family:var(--font-mono); }
    .nav-inner a.right { margin-left:auto; color:var(--text-secondary); font-size:14px; }
    main { max-width:820px; margin:0 auto; padding:48px 24px 80px; }
    h1 { font-family:var(--font-display); font-size:2rem; letter-spacing:-0.02em; }
    .lede { color:var(--text-secondary); margin-top:10px; }
    article h2 { font-family:var(--font-display); font-size:1.35rem; margin:48px 0 8px; padding-top:20px; border-top:1px solid var(--border); }
    article h3 { font-family:var(--font-display); font-size:1.05rem; margin:28px 0 6px; line-height:1.35; }
    article h4 { font-size:0.95rem; margin:18px 0 4px; }
    article p, article li { color:var(--text-secondary); }
    article p { margin-top:8px; }
    article ul, article ol { margin:8px 0 0 1.2rem; }
    article li { margin-top:4px; }
    article strong { color:var(--text-primary); }
    article code { font-family:var(--font-mono); font-size:0.85em; background:var(--bg-secondary); border:1px solid var(--border); border-radius:4px; padding:0 4px; overflow-wrap:anywhere; }
    article pre { font-family:var(--font-mono); font-size:0.82rem; background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:12px 14px; margin-top:10px; overflow-x:auto; }
    article pre code { border:none; padding:0; background:none; }
    article hr { display:none; }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="nav-logo"><span class="nav-logo-mark">&lt;&gt;</span><span>BasedAgents</span></a>
      <a class="right" href="/changelog.json">changelog.json →</a>
      <a href="/skill.md" style="color:var(--text-secondary);font-size:14px">skill.md →</a>
    </div>
  </nav>
  <main>
    <h1>Changelog</h1>
    <p class="lede">What changed in the API, the CLI and SDK, the MCP server, the site and the agent skill. Machine-readable: <a href="/changelog.json">/changelog.json</a>. Source: <a href="${SOURCE}">CHANGELOG.md</a>.</p>
    <article>${content}</article>
  </main>
</body>
</html>
`;
writeFileSync(join(web, 'dist', 'changelog.html'), html);
console.log(`changelog: ${releases.length} releases, ${releases.reduce((n, r) => n + r.entries.length, 0)} entries → dist/changelog.html, dist/changelog.json`);
