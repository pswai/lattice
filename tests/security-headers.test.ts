import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createSecurityHeadersMiddleware } from '../src/http/middleware/security-headers.js';

function buildApp(hstsEnabled = false): Hono {
  const app = new Hono();
  app.use('*', createSecurityHeadersMiddleware({ hstsEnabled }));
  app.get('/', (c) => c.text('dashboard'));
  app.get('/api/v1/tasks', (c) => c.json({ tasks: [] }));
  return app;
}

describe('security-headers middleware', () => {
  it('sets baseline headers on API responses', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/tasks');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('uses SAMEORIGIN for the dashboard path', async () => {
    const app = buildApp();
    const res = await app.request('/');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('emits HSTS only when enabled', async () => {
    const app = buildApp(true);
    const res = await app.request('/api/v1/tasks');
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });
});
