/**
 * Tests for GET /openapi.json
 *
 * Verifies that the OpenAPI spec file is valid and serves correctly, and that
 * it stays in lockstep with the task routes actually registered on the Hono
 * app: every `/v1/tasks*` path+method in the spec exists on `taskRoutes`, and
 * every registered route is documented.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

// Import via JSON (vitest handles JSON imports natively)
import openApiSpec from '../openapi.json';
import taskRoutes from './tasks.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const TASKS_MOUNT = '/v1/tasks'; // app.route('/v1/tasks', taskRoutes) in index.ts

/** `POST /:id/accept` on the sub-app → `post /v1/tasks/{id}/accept` as the spec spells it. */
function registeredTaskOperations(): string[] {
  const ops = new Set<string>();
  for (const route of taskRoutes.routes) {
    if (route.method === 'ALL') continue; // middleware mounted with .use(), none today
    const suffix = route.path === '/' ? '' : route.path;
    const path = `${TASKS_MOUNT}${suffix}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    ops.add(`${route.method.toLowerCase()} ${path}`);
  }
  return [...ops].sort();
}

function specTaskOperations(): string[] {
  const paths = (openApiSpec as unknown as { paths: Record<string, Record<string, unknown>> }).paths;
  const ops: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (path !== TASKS_MOUNT && !path.startsWith(`${TASKS_MOUNT}/`)) continue;
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) ops.push(`${method} ${path}`);
    }
  }
  return ops.sort();
}

describe('OpenAPI Spec — openapi.json validity', () => {
  it('spec has required OpenAPI top-level fields', () => {
    expect(openApiSpec).toBeDefined();
    expect(typeof (openApiSpec as Record<string, unknown>).openapi).toBe('string');
    expect((openApiSpec as Record<string, unknown>).openapi).toMatch(/^3\./);
  });

  it('spec has info object with title and version', () => {
    const spec = openApiSpec as Record<string, unknown>;
    expect(spec.info).toBeDefined();
    const info = spec.info as Record<string, unknown>;
    expect(typeof info.title).toBe('string');
    expect(info.title).not.toBe('');
    expect(typeof info.version).toBe('string');
    expect(info.version).toBe('0.7.0');
  });

  it('spec has paths object', () => {
    const spec = openApiSpec as Record<string, unknown>;
    expect(spec.paths).toBeDefined();
    expect(typeof spec.paths).toBe('object');
  });

  it('spec includes core agent and task routes', () => {
    const paths = (openApiSpec as unknown as Record<string, Record<string, unknown>>).paths;
    const pathKeys = Object.keys(paths);
    // Verify the spec has agent and task routes
    expect(pathKeys.some(p => p.includes('agents'))).toBe(true);
    expect(pathKeys.some(p => p.includes('tasks'))).toBe(true);
  });

  it('spec is valid JSON (no circular refs, parses without error)', () => {
    const serialized = JSON.stringify(openApiSpec);
    expect(() => JSON.parse(serialized)).not.toThrow();
    const reparsed = JSON.parse(serialized);
    expect(reparsed.openapi).toBe((openApiSpec as Record<string, unknown>).openapi);
  });
});

describe('OpenAPI Spec — task route parity with routes/tasks.ts', () => {
  it('every route registered on taskRoutes is documented, and vice versa', () => {
    const registered = registeredTaskOperations();
    expect(registered.length).toBeGreaterThan(0);
    expect(specTaskOperations()).toEqual(registered);
  });

  it('documents the full task lifecycle', () => {
    const ops = specTaskOperations();
    for (const op of [
      'post /v1/tasks', 'get /v1/tasks', 'get /v1/tasks/{id}',
      'post /v1/tasks/{id}/claim', 'post /v1/tasks/{id}/deliver', 'post /v1/tasks/{id}/submit',
      'post /v1/tasks/{id}/accept', 'post /v1/tasks/{id}/verify', 'post /v1/tasks/{id}/revision',
      'post /v1/tasks/{id}/dispute', 'post /v1/tasks/{id}/cancel',
      'get /v1/tasks/{id}/receipt', 'get /v1/tasks/{id}/receipts', 'get /v1/tasks/{id}/payment',
    ]) {
      expect(ops).toContain(op);
    }
  });

  it('pins the payment contract: header on /accept only, /verify deprecated, 402 challenge documented', () => {
    const paths = (openApiSpec as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths;

    const headerNames = (op: Record<string, unknown>) =>
      ((op.parameters ?? []) as Array<{ name: string; in: string }>).filter(p => p.in === 'header').map(p => p.name);

    // Escrow: the deposit is signed at create (402 there too); the legacy header name is never advertised.
    expect(headerNames(paths['/v1/tasks'].post)).toEqual(['PAYMENT-SIGNATURE']);
    expect(JSON.stringify(paths['/v1/tasks'].post)).not.toContain('X-PAYMENT-SIGNATURE');
    const create = paths['/v1/tasks'].post as { responses: Record<string, { headers?: Record<string, unknown> }> };
    expect(Object.keys(create.responses['402'].headers ?? {})).toContain('PAYMENT-REQUIRED');
    expect(headerNames(paths['/v1/tasks/{id}/fund'].post)).toEqual(['PAYMENT-SIGNATURE']);
    expect(headerNames(paths['/v1/tasks/{id}/accept'].post)).toEqual(['PAYMENT-SIGNATURE']);

    expect(paths['/v1/tasks/{id}/verify'].post.deprecated).toBe(true);

    const accept = paths['/v1/tasks/{id}/accept'].post as { responses: Record<string, { headers?: Record<string, unknown> }> };
    expect(accept.responses['402']).toBeDefined();
    expect(Object.keys(accept.responses['402'].headers ?? {})).toContain('PAYMENT-REQUIRED');
    expect(Object.keys(accept.responses['200'].headers ?? {})).toContain('PAYMENT-RESPONSE');

    // dispute requires a reason
    const dispute = paths['/v1/tasks/{id}/dispute'].post as { requestBody: { required: boolean; content: { 'application/json': { schema: { required: string[] } } } } };
    expect(dispute.requestBody.required).toBe(true);
    expect(dispute.requestBody.content['application/json'].schema.required).toEqual(['reason']);

    // bounty amount is atomic units
    const schemas = (openApiSpec as unknown as { components: { schemas: Record<string, { properties: Record<string, { pattern?: string }> }> } }).components.schemas;
    expect(schemas.Bounty.properties.amount.pattern).toBe('^[1-9][0-9]{0,9}$');

    // status enum includes closed
    const statusParam = ((paths['/v1/tasks'].get.parameters as Array<{ name: string; schema: { enum: string[] } }>)).find(p => p.name === 'status');
    expect(statusParam?.schema.enum).toContain('closed');
  });
});

describe('GET /openapi.json — HTTP endpoint', () => {
  it('returns 200 with application/json and valid spec', async () => {
    // Create a minimal Hono app that serves the spec (mimics index.ts behaviour)
    const app = new Hono();
    app.get('/openapi.json', (c) => c.json(openApiSpec));

    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const data = await res.json() as Record<string, unknown>;
    expect(typeof data.openapi).toBe('string');
    expect(data.paths).toBeDefined();
    expect(data.info).toBeDefined();
  });
});
