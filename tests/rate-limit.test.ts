import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createRateLimitMiddleware,
  __resetRateLimit,
} from '../src/http/middleware/rate-limit.js';

function buildApp(perMinute: number, windowMs?: number): Hono {
  const app = new Hono();
  app.use('*', createRateLimitMiddleware({ perMinute, windowMs }));
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

describe('rate-limit middleware', () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it('allows up to perMinute requests, then 429s', async () => {
    const app = buildApp(3);
    const headers = { Authorization: 'Bearer test-rate-key' };

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/ping', { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
    }

    const blocked = await app.request('/ping', { headers });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error).toBe('RATE_LIMITED');
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(blocked.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('sets X-RateLimit-Remaining on success', async () => {
    const app = buildApp(5);
    const headers = { Authorization: 'Bearer test-remaining-key' };
    const res1 = await app.request('/ping', { headers });
    expect(res1.headers.get('X-RateLimit-Remaining')).toBe('4');
    const res2 = await app.request('/ping', { headers });
    expect(res2.headers.get('X-RateLimit-Remaining')).toBe('3');
  });

  it('window resets after windowMs passes', async () => {
    const app = buildApp(2, 50); // 50ms window for test speed
    const headers = { Authorization: 'Bearer test-window-key' };
    await app.request('/ping', { headers });
    await app.request('/ping', { headers });
    const blocked = await app.request('/ping', { headers });
    expect(blocked.status).toBe(429);

    await new Promise((r) => setTimeout(r, 70));
    const ok = await app.request('/ping', { headers });
    expect(ok.status).toBe(200);
  });

  it('disables rate limiting when perMinute=0', async () => {
    const app = buildApp(0);
    const headers = { Authorization: 'Bearer test-disabled-key' };
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/ping', { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
    }
  });

  it('skips when Authorization header absent (auth will 401)', async () => {
    const app = buildApp(1);
    const r1 = await app.request('/ping');
    const r2 = await app.request('/ping');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('keys per-token (different Authorization -> separate buckets)', async () => {
    const app = buildApp(1);
    const r1 = await app.request('/ping', {
      headers: { Authorization: 'Bearer a' },
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/ping', {
      headers: { Authorization: 'Bearer b' },
    });
    expect(r2.status).toBe(200);
    const r3 = await app.request('/ping', {
      headers: { Authorization: 'Bearer a' },
    });
    expect(r3.status).toBe(429);
  });
});
