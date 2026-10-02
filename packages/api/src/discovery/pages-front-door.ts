/**
 * The Pages Function behind `/` on basedagents.ai and app.basedagents.ai
 * (WS1). Each package's functions/index.ts is a two-line wrapper around this.
 *
 *   Accept: text/markdown (no text/html)    → /skill.md
 *   Accept: application/json (no text/html) → /.well-known/basedagents.json
 *   anything else (every browser)           → the page, unchanged
 *
 * Only `/` runs a function (wrangler builds _routes.json from the folder);
 * every other path is a plain static asset. The agent formats are the same
 * static files served at their own URLs, fetched through ASSETS with the
 * request's own headers (If-None-Match included), so ETag and 304 behave
 * exactly as they do there. Pages skips _headers for function responses, so
 * the headers _headers gives `/` are passed in and set here.
 */
import { agentFormat, NEGOTIATED_VARY } from './negotiate.js';

export interface PagesContext {
  request: Request;
  env: { ASSETS: { fetch(request: Request): Promise<Response> } };
  next(): Promise<Response>;
}

const AGENT_ASSET = { markdown: '/skill.md', json: '/.well-known/basedagents.json' } as const;
const AGENT_TYPE = { markdown: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8' } as const;

export async function frontDoor(ctx: PagesContext, rootHeaders: Record<string, string>): Promise<Response> {
  const { request } = ctx;
  if (request.method !== 'GET' && request.method !== 'HEAD') return ctx.next();
  const format = agentFormat(request.headers.get('Accept'));

  let res: Response;
  if (format) {
    const asset = await ctx.env.ASSETS.fetch(new Request(new URL(AGENT_ASSET[format], request.url), request));
    res = new Response(asset.body, asset);
    if (asset.status === 200) res.headers.set('Content-Type', AGENT_TYPE[format]);
    res.headers.set('Access-Control-Allow-Origin', '*');
  } else {
    const page = await ctx.next();
    res = new Response(page.body, page);
    for (const [name, value] of Object.entries(rootHeaders)) res.headers.set(name, value);
  }
  res.headers.set('Vary', NEGOTIATED_VARY);
  // Preview deployments (<hash>.<project>.pages.dev) must never be indexed as
  // a copy of the site; ROOT_HEADERS carries production's `index, follow`.
  if (new URL(request.url).hostname.endsWith('.pages.dev')) res.headers.set('X-Robots-Tag', 'noindex');
  return res;
}
