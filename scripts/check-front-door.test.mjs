// Self-test for check-front-door.mjs against fake hosts on localhost: one that
// negotiates correctly passes; each way of getting it wrong is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, repoExpectations } from './check-front-door.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(join(ROOT, 'packages/web/public/skill.md'), 'utf8');
const MANIFEST = readFileSync(join(ROOT, 'packages/web/public/skills/basedagents/skill.json'), 'utf8');
const DESCRIPTOR = readFileSync(join(ROOT, 'packages/web/public/.well-known/basedagents.json'), 'utf8');
const etagOf = (s) => `"${createHash('sha1').update(s).digest('hex')}"`;

function fakeHost(opts = {}) {
  const server = createServer((req, res) => {
    const accept = req.headers.accept ?? '';
    const send = (status, type, body, extra = {}) => {
      const tag = etagOf(body);
      if (req.headers['if-none-match'] === tag && !opts.no304) { res.writeHead(304, { ETag: tag, ...extra }); return res.end(); }
      res.writeHead(status, { 'Content-Type': type, ETag: tag, ...extra });
      res.end(body);
    };
    const vary = opts.noVary ? {} : { Vary: 'Accept' };
    if (req.url === '/') {
      if (!accept.includes('text/html') && accept.includes('text/markdown') && !opts.markdownAsHtml) return send(200, 'text/markdown; charset=utf-8', opts.staleSkill ? SKILL + '\nold' : SKILL, vary);
      if (!accept.includes('text/html') && accept.includes('application/json')) return send(200, 'application/json', DESCRIPTOR, vary);
      return send(200, 'text/html; charset=utf-8', '<!doctype html><title>BasedAgents</title>', vary);
    }
    if (req.url === '/.well-known/basedagents.json') return send(200, 'application/json', DESCRIPTOR);
    if (req.url === '/skill.md') return send(200, 'text/markdown', SKILL);
    if (req.url === '/skills/basedagents/skill.json') return send(200, 'application/json', MANIFEST);
    if (req.url === '/changelog.json') return send(200, 'application/json', JSON.stringify({ releases: [{ version: 'Unreleased', entries: [] }] }));
    if (req.url === '/changelog') return send(200, 'text/html', '<!doctype html><h1>Changelog</h1>');
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const exp = repoExpectations(ROOT);
const quiet = () => {};

test('a correct host passes', async () => {
  const h = await fakeHost();
  try { assert.deepEqual(await run([['site', h.url], ['console', h.url]], { exp, log: quiet }), []); }
  finally { h.close(); }
});

for (const [name, opts, pattern] of [
  ['markdown served as HTML', { markdownAsHtml: true }, /\[markdown\]: content-type/],
  ['a stale skill', { staleSkill: true }, /sha256/],
  ['no Vary: Accept', { noVary: true }, /Vary: Accept/],
  ['no 304 on If-None-Match', { no304: true }, /expected 304/],
]) {
  test(`reports ${name}`, async () => {
    const h = await fakeHost(opts);
    try {
      const problems = await run([['site', h.url]], { exp, log: quiet });
      assert.ok(problems.some((p) => pattern.test(p)), problems.join('\n'));
    } finally { h.close(); }
  });
}
