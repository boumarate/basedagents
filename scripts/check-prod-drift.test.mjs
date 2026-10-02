// node --test scripts/check-prod-drift.test.mjs
// Serves a fake "production" on localhost and proves the drift check passes a
// current site and fails a stale one — without touching the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expectations, checkSite, checkBody } from './check-prod-drift.mjs';

const pos = JSON.parse(readFileSync(new URL('../packages/web/src/content/positioning.json', import.meta.url), 'utf8'));
const exp = expectations(pos);

const head = (title, img) => `<!doctype html><html><head><title>${title}</title>
<meta property="og:image" content="${img}"><meta name="twitter:image" content="${img}"></head><body></body></html>`;
function site(overrides = {}) {
  return {
    '/': head(pos.routeMeta['/'].title, pos.ogImage),
    '/tasks': head(pos.routeMeta['/tasks'].title, pos.ogImage),
    '/llms.txt': `# ${pos.name}\n\n> ${pos.oneLiner} ${pos.subhead}\n`,
    '/.well-known/agent.json': JSON.stringify({ name: pos.name, tagline: pos.oneLiner.replace(/\.$/, '') }),
    ...overrides,
  };
}
async function serve(pages) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (!(path in pages)) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pages[path]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('a site that matches positioning passes', async () => {
  const s = await serve(site());
  try { assert.deepEqual(await checkSite(s.base, exp), []); } finally { await s.close(); }
});

test('a deliberately stale title fails', async () => {
  const stale = head('BasedAgents — never paste a key into a chat again', pos.ogImage);
  const s = await serve(site({ '/': stale }));
  try {
    const problems = await checkSite(s.base, exp);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^\/: <title> is "BasedAgents — never paste a key into a chat again"/);
  } finally { await s.close(); }
});

test('an old og:image version fails, on both og and twitter tags', async () => {
  const old = pos.ogImage.replace(/v=\d+$/, 'v=2');
  const s = await serve(site({ '/tasks': head(pos.routeMeta['/tasks'].title, old) }));
  try {
    const problems = await checkSite(s.base, exp);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((p) => p.startsWith('/tasks:') && p.includes('v=2')));
  } finally { await s.close(); }
});

test('stale llms.txt and agent.json fail; a missing page fails', async () => {
  const pages = site({ '/llms.txt': '# BasedAgents\n\n> An open registry.\n', '/.well-known/agent.json': '{"tagline":"Identity and reputation registry for AI agents"}' });
  delete pages['/tasks'];
  const s = await serve(pages);
  try {
    const problems = await checkSite(s.base, exp);
    assert.ok(problems.some((p) => p.startsWith('/llms.txt:')));
    assert.ok(problems.some((p) => p.startsWith('/.well-known/agent.json: tagline')));
    assert.ok(problems.some((p) => p === '/tasks: HTTP 404'));
  } finally { await s.close(); }
});

test('an edge throttle is reported as throttling, not drift', async () => {
  const s = await serve(site({ '/.well-known/agent.json': 'error code: 1027' }));
  try {
    assert.deepEqual(await checkSite(s.base, exp), ['/.well-known/agent.json: Cloudflare edge throttled the check (HTTP 200) — edge rate limiting, not drift']);
  } finally { await s.close(); }
});

test('checkBody accepts attribute order either way', () => {
  const html = `<title>${pos.routeMeta['/'].title}</title><meta content="${pos.ogImage}" property="og:image"><meta content="${pos.ogImage}" name="twitter:image">`;
  assert.deepEqual(checkBody('/', html, exp['/']), []);
});

test('the CLI exits non-zero against a stale site', async () => {
  const s = await serve(site({ '/': head('BasedAgents — never paste a key into a chat again', pos.ogImage) }));
  try {
    const script = fileURLToPath(new URL('./check-prod-drift.mjs', import.meta.url));
    // execFile, not spawnSync: a sync child would block the event loop serving the fake site.
    const r = await new Promise((resolve) =>
      execFile(process.execPath, [script, '--base', s.base], (err, _stdout, stderr) => resolve({ code: err ? err.code : 0, stderr })));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /FAILED/);
  } finally { await s.close(); }
});

