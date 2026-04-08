import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  createRateLimitMiddleware,
  checkRateLimit,
  __resetRateLimit,
} from '../src/http/middleware/rate-limit.js';
import {
  createTestDb,
  createTestContext,
  setupWorkspace,
  addApiKey,
  authHeaders,
  request,
  testConfig,
  type TestContext,
} from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';

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

// ─── Sliding window behavior (from round2) ───────────────────────────

describe('Rate limit — sliding window behavior', () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it('allows requests after window slides past old hits', () => {
    const windowMs = 100;
    const perMinute = 2;
    const key = 'test-window';

    expect(checkRateLimit(key, perMinute, windowMs).limited).toBe(false);
    expect(checkRateLimit(key, perMinute, windowMs).limited).toBe(false);
    expect(checkRateLimit(key, perMinute, windowMs).limited).toBe(true);
  });

  it('returns retryAfterSec when limited', () => {
    const key = 'test-retry';
    const perMinute = 1;

    checkRateLimit(key, perMinute);
    const result = checkRateLimit(key, perMinute);
    expect(result.limited).toBe(true);
    if (result.limited) {
      expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });

  it('per-minute 0 disables rate limiting', () => {
    const key = 'test-disabled';
    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit(key, 0).limited).toBe(false);
    }
  });
});

// ─── MCP and REST share the same rate limit bucket (from round4-fixes) ─

describe('MCP and REST share the same rate limit bucket', () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  afterEach(() => {
    __resetRateLimit();
  });

  it('should count MCP and REST requests against the same bucket', async () => {
    const config = testConfig({ rateLimitPerMinute: 5 });
    const db = createTestDb();
    const team = setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const headers = authHeaders(team.apiKey);

    for (let i = 0; i < 3; i++) {
      const res = await request(app, 'GET', '/api/v1/context?query=test', { headers });
      expect(res.status).toBe(200);
    }

    for (let i = 0; i < 2; i++) {
      const res = await request(app, 'GET', '/api/v1/events', { headers });
      expect(res.status).toBe(200);
    }

    const limited = await request(app, 'GET', '/api/v1/context?query=test', { headers });
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.error).toBe('RATE_LIMITED');
  });
});

// ─── Rate limit bucket cleanup (from round6-fixes) ────────────────────

describe('Rate limit bucket cleanup (sweepStaleBuckets)', () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  afterEach(() => {
    __resetRateLimit();
  });

  it('should add bucket entries on rate limit check', () => {
    const result = checkRateLimit('key-1', 100, 60_000);
    expect(result.limited).toBe(false);
    const result2 = checkRateLimit('key-2', 100, 60_000);
    expect(result2.limited).toBe(false);
  });

  it('should limit after perMinute hits reached', () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit('full-key', 5, 60_000);
    }
    const result = checkRateLimit('full-key', 5, 60_000);
    expect(result.limited).toBe(true);
    if (result.limited) {
      expect(result.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('should clean up on __resetRateLimit', () => {
    checkRateLimit('ephemeral', 100, 60_000);
    __resetRateLimit();
    const result = checkRateLimit('ephemeral', 1, 60_000);
    expect(result.limited).toBe(false);
  });

  it('should not leak memory — buckets with expired hits can be re-created fresh', () => {
    for (let i = 0; i < 100; i++) {
      checkRateLimit(`leak-test-${i}`, 100, 60_000);
    }
    __resetRateLimit();
    const result = checkRateLimit('leak-test-0', 100, 60_000);
    expect(result.limited).toBe(false);
  });
});

// ─── Per-workspace rate limiter (from phase3-deferred) ─────────────────

describe('Per-workspace rate limiter', () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it('returns 429 when workspace exceeds limit', async () => {
    const db = createTestDb();
    const { apiKey } = setupWorkspace(db, 'ws-rl');
    const config = testConfig({ rateLimitPerMinuteWorkspace: 3 });
    const app = createApp(db, () => createMcpServer(db), config);

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/api/v1/agents', {
        headers: { Authorization: `Bearer ${apiKey}`, 'X-Agent-ID': 'test' },
      });
      expect(res.status).toBe(200);
    }

    const res = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${apiKey}`, 'X-Agent-ID': 'test' },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('RATE_LIMITED');
    expect(body.message).toContain('Workspace');
    expect(res.headers.get('X-RateLimit-Workspace-Remaining')).toBe('0');
  });

  it('aggregates across different API keys in same workspace', async () => {
    const db = createTestDb();
    const { apiKey: key1 } = setupWorkspace(db, 'ws-shared');
    const { createHash } = await import('crypto');
    const key2 = 'ltk_second_key_000000000000000000';
    const hash2 = createHash('sha256').update(key2).digest('hex');
    db.rawDb.prepare('INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
      'ws-shared', hash2, 'second', 'write',
    );

    const config = testConfig({ rateLimitPerMinuteWorkspace: 2 });
    const app = createApp(db, () => createMcpServer(db), config);

    const r1 = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${key1}`, 'X-Agent-ID': 'a' },
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${key2}`, 'X-Agent-ID': 'b' },
    });
    expect(r2.status).toBe(200);

    const r3 = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${key1}`, 'X-Agent-ID': 'a' },
    });
    expect(r3.status).toBe(429);
  });
});
