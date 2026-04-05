import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createCorsMiddleware } from '../src/http/middleware/cors.js';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';

function buildCorsApp(opts: Parameters<typeof createCorsMiddleware>[0]): Hono {
  const app = new Hono();
  app.use('*', createCorsMiddleware(opts));
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

describe('CORS middleware', () => {
  it('returns correct preflight headers for an allowed origin', async () => {
    const app = buildCorsApp({ origins: ['https://app.example.com'], maxAge: 300 });
    const res = await app.request('/ping', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('300');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('rejects a disallowed origin (no ACAO header)', async () => {
    const app = buildCorsApp({ origins: ['https://app.example.com'] });
    const res = await app.request('/ping', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    // Preflight returns 204 but WITHOUT ACAO so the browser blocks.
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('wildcard origin works without credentials', async () => {
    const app = buildCorsApp({ origins: '*' });
    const res = await app.request('/ping', {
      method: 'GET',
      headers: { Origin: 'https://anything.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('rejects wildcard + credentials at construction', () => {
    expect(() => createCorsMiddleware({ origins: '*', credentials: true })).toThrow();
  });

  it('always sets Vary: Origin', async () => {
    const app = buildCorsApp({ origins: ['https://app.example.com'] });
    const noOriginRes = await app.request('/ping', { method: 'GET' });
    expect(noOriginRes.headers.get('Vary')).toBe('Origin');

    const okRes = await app.request('/ping', {
      method: 'GET',
      headers: { Origin: 'https://app.example.com' },
    });
    expect(okRes.headers.get('Vary')).toBe('Origin');

    const badRes = await app.request('/ping', {
      method: 'GET',
      headers: { Origin: 'https://bad.example.com' },
    });
    expect(badRes.headers.get('Vary')).toBe('Origin');
    expect(badRes.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('is inert when corsOrigins=[] in the full app', async () => {
    const db = createTestDb();
    const app = createApp(db, () => createMcpServer(db), testConfig({ corsOrigins: [] }));
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://somewhere.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    // Middleware not mounted → no ACAO header whatsoever.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBeNull();
  });

  it('reflects the request origin with credentials: true', async () => {
    const app = buildCorsApp({
      origins: ['https://app.example.com'],
      credentials: true,
    });
    const res = await app.request('/ping', {
      method: 'GET',
      headers: { Origin: 'https://app.example.com' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});
