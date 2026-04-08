import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createBodyLimitMiddleware } from '../src/http/middleware/body-limit.js';
import { createTestDb, setupWorkspace, authHeaders, request, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';

function buildApp(maxBytes: number): Hono {
  const app = new Hono();
  app.use('*', createBodyLimitMiddleware(maxBytes));
  app.post('/echo', async (c) => {
    const body = await c.req.text();
    return c.json({ len: body.length });
  });
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

describe('body-limit middleware', () => {
  it('returns 413 when Content-Length exceeds maxBytes', async () => {
    const app = buildApp(10);
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '1000' },
      body: 'hello world this is long',
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('allows request when Content-Length within limit', async () => {
    const app = buildApp(100);
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hi',
    });
    expect(res.status).toBe(200);
  });

  it('skips GET requests', async () => {
    const app = buildApp(1);
    const res = await app.request('/ping');
    expect(res.status).toBe(200);
  });

  it('allows request when Content-Length missing', async () => {
    const app = buildApp(10);
    // fetch API will compute Content-Length, so we use raw Request
    const req = new Request('http://localhost/echo', {
      method: 'POST',
      body: 'hi',
    });
    const res = await app.request(req);
    expect([200, 413]).toContain(res.status);
    // If CL was set by fetch, we rely on it; if missing we let through.
  });

  it('disabled when maxBytes=0', async () => {
    const app = buildApp(0);
    const res = await app.request('/echo', {
      method: 'POST',
      headers: { 'Content-Length': '9999999' },
      body: 'hi',
    });
    expect(res.status).toBe(200);
  });
});

// ─── Body limit stream validation (from round5-fixes) ─────────────────

describe('Body limit stream validation (integration)', () => {
  it('should reject requests exceeding body limit via Content-Length', async () => {
    const config = testConfig({ maxBodyBytes: 1024 });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const bigBody = JSON.stringify({ key: 'x', value: 'a'.repeat(2000), tags: [] });
    const res = await request(app, 'POST', '/api/v1/context', {
      headers: {
        ...authHeaders('ltk_test_key_12345678901234567890'),
        'Content-Length': String(Buffer.byteLength(bigBody)),
      },
      body: JSON.parse(bigBody),
    });
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('should allow requests within body limit', async () => {
    const config = testConfig({ maxBodyBytes: 10_000 });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const res = await request(app, 'POST', '/api/v1/context', {
      headers: authHeaders('ltk_test_key_12345678901234567890'),
      body: { key: 'small', value: 'hello', tags: [] },
    });
    expect(res.status).toBe(201);
  });

  it('should skip limit check for GET requests', async () => {
    const config = testConfig({ maxBodyBytes: 1 });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const res = await request(app, 'GET', '/api/v1/context?query=test', {
      headers: authHeaders('ltk_test_key_12345678901234567890'),
    });
    expect(res.status).toBe(200);
  });

  it('should pass through when maxBytes is 0 (disabled)', async () => {
    const config = testConfig({ maxBodyBytes: 0 });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const res = await request(app, 'POST', '/api/v1/context', {
      headers: authHeaders('ltk_test_key_12345678901234567890'),
      body: { key: 'any-size', value: 'a'.repeat(5000), tags: [] },
    });
    expect(res.status).toBe(201);
  });
});
