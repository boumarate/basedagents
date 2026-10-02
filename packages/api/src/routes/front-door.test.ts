/**
 * The agent front door (WS1) on api.basedagents.ai, through the real Worker
 * app and its middleware: content negotiation on `/`, the service descriptor,
 * the /v1 aliases, ETag → 304, default Cache-Control, and ?min_usdc.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker, { setNodeAdapter } from '../index.js';
import { setupTestDb, createTestAgent } from '../test-helpers.js';
import { buildDescriptor } from '../discovery/descriptor.js';
import { agentFormat } from '../discovery/negotiate.js';
import { SKILL_MD, SKILL_VERSION, SKILL_SHA256 } from '../discovery/skill.generated.js';
import { REVIEW_WINDOW_MS, MAX_REVISIONS } from '../tasks/service.js';
import { createHash } from 'node:crypto';
import { MIN_BOUNTY_ATOMIC_DEFAULT } from '../tasks/bounty-minimum.js';

const BASE = 'https://api.basedagents.ai';
const get = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, { headers }), {} as never, { waitUntil() {}, passThroughOnException() {} } as never);

const repo = (rel: string) => fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

beforeAll(async () => {
  const db = setupTestDb();
  setNodeAdapter(db);
  const creator = await createTestAgent(db, { name: 'Poster' });
  const insert = (id: string, bounty: string | null) => db.run(
    `INSERT INTO tasks (task_id, creator_agent_id, creator_kind, title, description, status, created_at, output_format, bounty_amount, bounty_token, bounty_network, payment_status)
     VALUES (?, ?, 'agent', ?, 'd', 'open', ?, 'json', ?, ?, ?, ?)`,
    id, creator.agentId, id, new Date().toISOString(), bounty, bounty ? 'USDC' : null, bounty ? 'eip155:8453' : null, bounty ? 'pending' : 'none',
  );
  await insert('task_free', null);
  await insert('task_half', '500000');
  await insert('task_one', '1000000');
  await insert('task_five_legacy', '5.00');
});

describe('agentFormat', () => {
  it.each([
    ['text/markdown', 'markdown'],
    ['text/markdown, */*;q=0.1', 'markdown'],
    ['application/json', 'json'],
    ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', null],
    ['text/html, text/markdown', null],
    ['*/*', null],
    ['', null],
  ])('%s → %s', (accept, expected) => {
    expect(agentFormat(accept)).toBe(expected);
  });
});

describe('GET / content negotiation', () => {
  it('Accept: text/markdown returns the skill, with Vary and an ETag', async () => {
    const res = await get('/', { Accept: 'text/markdown' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/markdown/);
    expect(res.headers.get('Vary')).toMatch(/Accept/);
    const body = await res.text();
    expect(body).toBe(SKILL_MD);
    expect(createHash('sha256').update(body).digest('hex')).toBe(SKILL_SHA256);
    expect(res.headers.get('ETag')).toBeTruthy();
  });

  it('If-None-Match round-trip returns 304 with no body', async () => {
    const first = await get('/', { Accept: 'text/markdown' });
    const tag = first.headers.get('ETag')!;
    const second = await get('/', { Accept: 'text/markdown', 'If-None-Match': tag });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('Accept: application/json returns the service descriptor', async () => {
    const res = await get('/', { Accept: 'application/json' });
    expect(res.status).toBe(200);
    const d = await res.json() as Record<string, Record<string, unknown>>;
    expect(d.name).toBe('BasedAgents');
    expect(d.skill.version).toBe(SKILL_VERSION);
    expect(d.auth.idPrefix).toBe('ag_');
    expect(res.headers.get('Vary')).toMatch(/Accept/);
  });

  it('a browser (text/html) still gets the redirect to the site', async () => {
    const res = await get('/', { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://basedagents.ai');
  });

  it('*/* (curl default) keeps the legacy API root document', async () => {
    const res = await get('/', { Accept: '*/*' });
    const d = await res.json() as Record<string, unknown>;
    expect(d.name).toBe('BasedAgents API');
    expect(d.endpoints).toBeTruthy();
  });
});

describe('descriptor', () => {
  it('reports the rules the state machine enforces', () => {
    const d = buildDescriptor({ version: SKILL_VERSION }) as Record<string, Record<string, unknown>>;
    expect(d.marketplace.autoApproveHours).toBe(REVIEW_WINDOW_MS / 3_600_000);
    expect(d.marketplace.maxRevisionRounds).toBe(MAX_REVISIONS);
    expect(d.marketplace.feeBps).toBe(0);
    // D3: free tasks allowed; a bounty has a floor (the defaults the API enforces).
    expect(d.marketplace.minTaskUsdc).toEqual({ human: 0, a2a: 0 });
    expect(d.marketplace.minBountyUsdcDefault).toEqual({ human: MIN_BOUNTY_ATOMIC_DEFAULT.human / 1e6, a2a: MIN_BOUNTY_ATOMIC_DEFAULT.a2a / 1e6 });
    expect(d.payments.contract).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(d.signingKeys).toEqual([]);
  });

  it('GET /.well-known/basedagents.json equals the static copies on the site and console', async () => {
    const res = await get('/.well-known/basedagents.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const live = await res.json();
    for (const rel of ['packages/web/public/.well-known/basedagents.json', 'packages/console/public/.well-known/basedagents.json']) {
      expect(JSON.parse(readFileSync(repo(rel), 'utf8'))).toEqual(live);
    }
  });

  it('the served skill.json manifest matches the embedded skill', () => {
    const manifest = JSON.parse(readFileSync(repo('packages/web/public/skills/basedagents/skill.json'), 'utf8'));
    expect(manifest.version).toBe(SKILL_VERSION);
    expect(manifest.sha256).toBe(SKILL_SHA256);
    expect(readFileSync(repo('packages/web/public/skill.md'), 'utf8')).toBe(SKILL_MD);
  });
});

describe('/v1 aliases and headers', () => {
  it('GET /v1/health', async () => {
    const res = await get('/v1/health');
    expect(await res.json()).toEqual({ status: 'ok', skill_version: SKILL_VERSION });
  });

  it('GET /v1/openapi.json is the OpenAPI document', async () => {
    const d = await (await get('/v1/openapi.json')).json() as Record<string, Record<string, unknown>>;
    expect(d.openapi).toMatch(/^3\./);
    expect(d.paths['/.well-known/basedagents.json']).toBeTruthy();
  });

  it('every response names the latest skill version, rate-limited ones included', async () => {
    const res = await get('/v1/health');
    expect(res.headers.get('X-BasedAgents-Skill-Latest')).toBe(SKILL_VERSION);
    // /v1/register/init allows 5 a minute per IP; the 6th is a 429 from the limiter itself.
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await worker.fetch(new Request(`${BASE}/v1/register/init`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' }, body: '{}' }), {} as never, { waitUntil() {}, passThroughOnException() {} } as never);
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get('X-BasedAgents-Skill-Latest')).toBe(SKILL_VERSION);
  });

  it('a public GET without its own Cache-Control gets a revalidate default and an ETag', async () => {
    const res = await get('/v1/tasks');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    const tag = res.headers.get('ETag');
    expect(tag).toBeTruthy();
    expect((await get('/v1/tasks', { 'If-None-Match': tag! })).status).toBe(304);
  });

  it('a credentialed GET is private', async () => {
    const res = await get('/v1/tasks', { Authorization: 'AgentSig x:y' });
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
  });
});

describe('GET /v1/tasks?min_usdc', () => {
  const ids = async (q: string) => ((await (await get(`/v1/tasks?status=open${q}`)).json()) as { tasks: Array<{ task_id: string }> }).tasks.map((t) => t.task_id).sort();

  it('filters by bounty floor in atomic units, legacy decimal rows included; free tasks drop out', async () => {
    expect(await ids('')).toEqual(['task_five_legacy', 'task_free', 'task_half', 'task_one']);
    expect(await ids('&min_usdc=0.5')).toEqual(['task_five_legacy', 'task_half', 'task_one']);
    expect(await ids('&min_usdc=1.00')).toEqual(['task_five_legacy', 'task_one']);
    expect(await ids('&min_usdc=5')).toEqual(['task_five_legacy']);
    expect(await ids('&min_usdc=5.000001')).toEqual([]);
  });

  it('a malformed or empty value is a 400, not a silently ignored filter', async () => {
    for (const bad of ['1.2345678', '', 'abc']) {
      const res = await get(`/v1/tasks?min_usdc=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_min_usdc');
    }
  });
});

describe('Pages front door (site + console `/`)', () => {
  const ROOT = { 'Content-Security-Policy': "default-src 'self'", 'X-Robots-Tag': 'index, follow' };
  const ctx = (url: string, accept: string) => {
    const assets: string[] = [];
    return {
      assets,
      ctx: {
        request: new Request(url, { headers: { Accept: accept, 'If-None-Match': '"x"' } }),
        env: { ASSETS: { fetch: async (r: Request) => { assets.push(`${new URL(r.url).pathname} ${r.headers.get('If-None-Match')}`); return new Response('asset', { headers: { ETag: '"x"', 'Content-Type': 'text/plain' } }); } } },
        next: async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
      },
    };
  };

  it('serves the skill asset for markdown, forwarding If-None-Match', async () => {
    const { frontDoor } = await import('../discovery/pages-front-door.js');
    const t = ctx('https://basedagents.ai/', 'text/markdown');
    const res = await frontDoor(t.ctx, ROOT);
    expect(t.assets).toEqual(['/skill.md "x"']);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('Vary')).toBe('Accept');
  });

  it('passes browsers through with the _headers for `/` re-applied', async () => {
    const { frontDoor } = await import('../discovery/pages-front-door.js');
    const res = await frontDoor(ctx('https://basedagents.ai/', 'text/html,*/*').ctx, ROOT);
    expect(await res.text()).toBe('<html>');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'self'");
    expect(res.headers.get('X-Robots-Tag')).toBe('index, follow');
  });

  it('never lets a *.pages.dev preview be indexed', async () => {
    const { frontDoor } = await import('../discovery/pages-front-door.js');
    const res = await frontDoor(ctx('https://868f361e.auth-ai-web.pages.dev/', 'text/html').ctx, ROOT);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});

describe('GET /.well-known/x402 networks', () => {
  const discover = (env: Record<string, string>) =>
    worker.fetch(new Request(`${BASE}/.well-known/x402`), env as never, { waitUntil() {}, passThroughOnException() {} } as never);

  it('production advertises only Base mainnet, matching the manifest', async () => {
    const res = await discover({ ENVIRONMENT: 'production' });
    expect(res.status).toBe(200);
    const body = await res.json() as { accepts: Array<{ network: string; asset: string }> };
    expect(body.accepts.map((a) => a.network)).toEqual(['eip155:8453']);
    expect(body.accepts[0].asset).toBe((buildDescriptor({ version: '0' }) as { payments: { contract: string } }).payments.contract);
  });

  it('advertises the live minimum bounty for agent and console posters', async () => {
    type Discovery = { accepts: Array<{ min_amount: string }>; min_bounty_atomic: { a2a: string; human: string } };
    const dflt = await (await discover({ ENVIRONMENT: 'production' })).json() as Discovery;
    expect(dflt.accepts[0].min_amount).toBe(String(MIN_BOUNTY_ATOMIC_DEFAULT.a2a));
    expect(dflt.min_bounty_atomic).toEqual({ a2a: String(MIN_BOUNTY_ATOMIC_DEFAULT.a2a), human: String(MIN_BOUNTY_ATOMIC_DEFAULT.human) });
    const raised = await (await discover({ ENVIRONMENT: 'production', MIN_BOUNTY_ATOMIC_A2A: '2500000', MIN_BOUNTY_ATOMIC_HUMAN: '5000000' })).json() as Discovery;
    expect(raised.accepts[0].min_amount).toBe('2500000');
    expect(raised.min_bounty_atomic).toEqual({ a2a: '2500000', human: '5000000' });
  });

  it('other environments also advertise Base Sepolia for testing', async () => {
    const body = await (await discover({ ENVIRONMENT: 'staging' })).json() as { accepts: Array<{ network: string }> };
    expect(body.accepts.map((a) => a.network).sort()).toEqual(['eip155:8453', 'eip155:84532']);
  });
});
