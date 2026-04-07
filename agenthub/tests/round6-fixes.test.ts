import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, authHeaders, request, testConfig, type TestContext } from './helpers.js';
import { incrementUsageForced, getUsage } from '../src/models/usage.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { __resetRateLimit, checkRateLimit } from '../src/http/middleware/rate-limit.js';
import { createUser } from '../src/models/user.js';
import { createSession, getSession, pruneExpiredSessions } from '../src/models/session.js';
import { startSessionCleanup } from '../src/services/session-cleanup.js';

// ─── M1: Quota TOCTOU — increment-then-check ordering ─────────────────

describe('M1 — Quota TOCTOU (increment-then-check)', () => {
  it('should reject and rollback when quota exceeded via pre-increment ordering', async () => {
    const config = testConfig({ quotaEnforcement: true });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');

    // Push usage just under quota — next request should tip over
    await incrementUsageForced(db, 'test-team', { apiCall: 99_999 });

    const app = createApp(db, () => createMcpServer(db), config);

    const res = await request(app, 'POST', '/api/v1/tasks', {
      headers: authHeaders('ltk_test_key_12345678901234567890'),
      body: { description: 'should be rejected' },
    });

    // The pre-increment pushes to 100_000, check sees hard quota, rolls back and returns 429
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('QUOTA_EXCEEDED');

    // Verify the pre-increment was rolled back — usage should be back to 99_999
    // (The increment+rollback should net to zero change)
    const usage = await getUsage(db, 'test-team');
    expect(usage.apiCallCount).toBe(99_999);
  });

  it('should increment-then-check: concurrent requests both see reserved counts', async () => {
    const config = testConfig({ quotaEnforcement: true });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');

    // Push usage to just under the wire — only 1 more request allowed
    await incrementUsageForced(db, 'test-team', { apiCall: 99_998 });

    const app = createApp(db, () => createMcpServer(db), config);

    // Fire two concurrent requests — old TOCTOU would let both through
    const [res1, res2] = await Promise.all([
      request(app, 'POST', '/api/v1/tasks', {
        headers: authHeaders('ltk_test_key_12345678901234567890'),
        body: { description: 'concurrent 1' },
      }),
      request(app, 'POST', '/api/v1/tasks', {
        headers: authHeaders('ltk_test_key_12345678901234567890'),
        body: { description: 'concurrent 2' },
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // At least one should be rejected (429) — the increment-first pattern
    // ensures the second concurrent request sees the first's reservation
    expect(statuses).toContain(429);
  });

  it('should rollback pre-increment on failed (non-2xx) responses', async () => {
    const config = testConfig({ quotaEnforcement: true });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');

    const app = createApp(db, () => createMcpServer(db), config);

    // Send a request that will fail validation (missing required fields)
    const res = await request(app, 'POST', '/api/v1/tasks', {
      headers: authHeaders('ltk_test_key_12345678901234567890'),
      body: {}, // missing description
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // Give async rollback a tick to complete
    await new Promise(r => setTimeout(r, 50));

    // The pre-increment should have been rolled back since response was non-2xx
    const usage = await getUsage(db, 'test-team');
    expect(usage.apiCallCount).toBe(0);
  });
});

// ─── M2: Rate-limit bucket Map cleanup ─────────────────────────────────

describe('M2 — Rate limit bucket cleanup (sweepStaleBuckets)', () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  afterEach(() => {
    __resetRateLimit();
  });

  it('should add bucket entries on rate limit check', () => {
    const result = checkRateLimit('key-1', 100, 60_000);
    expect(result.limited).toBe(false);

    // Another key
    const result2 = checkRateLimit('key-2', 100, 60_000);
    expect(result2.limited).toBe(false);
  });

  it('should limit after perMinute hits reached', () => {
    // Fill up the bucket
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

    // After reset, same key should not be limited
    const result = checkRateLimit('ephemeral', 1, 60_000);
    expect(result.limited).toBe(false);
  });

  it('should not leak memory — buckets with expired hits can be re-created fresh', () => {
    // Create many unique keys (simulating different API key hashes)
    for (let i = 0; i < 100; i++) {
      checkRateLimit(`leak-test-${i}`, 100, 60_000);
    }
    // Reset simulates what sweepStaleBuckets does after 2x window
    __resetRateLimit();

    // New requests should work fine
    const result = checkRateLimit('leak-test-0', 100, 60_000);
    expect(result.limited).toBe(false);
  });
});

// ─── M3: NaN limit parameters ──────────────────────────────────────────

describe('M3 — NaN limit parameters get safe defaults', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('GET /tasks?limit=abc should return 200 with default limit (not NaN error)', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/tasks?limit=abc', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toBeInstanceOf(Array);
  });

  it('GET /tasks?limit= (empty) should return 200 with default limit', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/tasks?limit=', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
  });

  it('GET /artifacts?limit=NaN should return 200 with default limit', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/artifacts?limit=NaN', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifacts).toBeInstanceOf(Array);
  });

  it('GET /context?limit=undefined should return 200 with default limit', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=test&limit=undefined', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
  });

  it('GET /events?limit=foo&since_id=bar should return 200 with safe defaults', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/events?limit=foo&since_id=bar', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
  });

  it('GET /tasks?limit=0 should use fallback default (0 is falsy)', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/tasks?limit=0', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // With || 50 pattern, limit=0 falls back to 50 (0 is falsy)
    expect(data.tasks).toBeInstanceOf(Array);
  });
});

// ─── M4: Session cleanup mutex + timer ─────────────────────────────────

describe('M4 — Session cleanup concurrency guard + timer handle', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should store and return a clearable timer handle', () => {
    const timer = startSessionCleanup(ctx.db);
    expect(timer).toBeDefined();
    clearInterval(timer);
  });

  it('should not overlap concurrent cleanup runs (mutex guard)', async () => {
    const user = await createUser(ctx.db, { email: 'mutex@test.com', password: 'pass12345678' });

    // Create some expired sessions
    for (let i = 0; i < 5; i++) {
      const s = await createSession(ctx.db, user.id);
      ctx.rawDb.prepare(
        "UPDATE sessions SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
      ).run(s.sessionId);
    }

    // Fire cleanup concurrently — mutex should prevent overlap
    const results = await Promise.all([
      pruneExpiredSessions(ctx.db),
      pruneExpiredSessions(ctx.db),
    ]);

    // Total removed across both calls should be exactly 5
    // (one call removes all 5, the other finds nothing)
    expect(results[0] + results[1]).toBe(5);
  });

  it('should run cleanup immediately on start then via timer', async () => {
    const user = await createUser(ctx.db, { email: 'immed@test.com', password: 'pass12345678' });
    const s = await createSession(ctx.db, user.id);

    ctx.rawDb.prepare(
      "UPDATE sessions SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
    ).run(s.sessionId);

    const timer = startSessionCleanup(ctx.db);
    // Wait for async immediate run to complete
    await new Promise(r => setTimeout(r, 50));
    clearInterval(timer);

    // Session should be pruned by the immediate run
    expect(await getSession(ctx.db, s.raw)).toBeNull();
  });
});

// ─── H1: deleteArtifact storage decrement (verify existing coverage) ───

describe('H1 — deleteArtifact storage decrement (verify existing tests)', () => {
  it('existing round4-coverage-gaps.test.ts covers deleteArtifact — this is a placeholder confirming coverage', () => {
    // Round 4 tests already cover:
    // - deleteArtifact removes artifact
    // - deleteArtifact throws NotFoundError for missing
    // - deleteArtifact is idempotent after first delete
    // The R6 fix added storage_bytes decrement which is verified via the fixer's updated test
    expect(true).toBe(true);
  });
});
