import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, authHeaders, request, testConfig, type TestContext } from './helpers.js';
import { createTask } from '../src/models/task.js';
import { definePlaybook } from '../src/models/playbook.js';
import { defineProfile } from '../src/models/profile.js';
import { saveContext } from '../src/models/context.js';
import { createUser } from '../src/models/user.js';
import { createSession, pruneExpiredSessions, getSession } from '../src/models/session.js';
import { setUsageTracking, getUsage, incrementUsageForced, decrementUsageForced } from '../src/models/usage.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';

// ─── H1: Model-layer secret scanning ───────────────────────────────────

describe('H1 — Model-layer secret scanning (protects both REST and model)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('createTask — model layer', () => {
    it('should reject task with secret in description at model layer', async () => {
      await expect(
        createTask(ctx.db, ctx.workspaceId, 'agent', {
          description: 'Deploy with AKIAIOSFODNN7EXAMPLE',
          status: 'open',
        }),
      ).rejects.toThrow(/secret/i);
    });

    it('should allow clean descriptions at model layer', async () => {
      const result = await createTask(ctx.db, ctx.workspaceId, 'agent', {
        description: 'Normal deployment task',
        status: 'open',
      });
      expect(result.task_id).toBeGreaterThan(0);
    });
  });

  describe('createTask — REST route', () => {
    it('should reject task with secret via REST POST /tasks', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Use key AKIAIOSFODNN7EXAMPLE' },
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });
  });

  describe('definePlaybook — model layer', () => {
    it('should reject playbook with secret in task description at model layer', async () => {
      await expect(
        definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-pb',
          description: 'Test',
          tasks: [{ description: 'Use sk_live_1234567890abcdefghijklmn' }],
        }),
      ).rejects.toThrow(/secret/i);
    });

    it('should reject playbook with secret in description at model layer', async () => {
      await expect(
        definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-pb-desc',
          description: 'Deploy with AKIAIOSFODNN7EXAMPLE',
          tasks: [{ description: 'Clean step' }],
        }),
      ).rejects.toThrow(/secret/i);
    });
  });

  describe('definePlaybook — REST route', () => {
    it('should reject playbook with secret via REST', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'rest-bad-pb',
          description: 'safe',
          tasks: [{ description: 'Deploy with AKIAIOSFODNN7EXAMPLE' }],
        },
      });
      expect(res.status).toBe(422);
    });
  });

  describe('defineProfile — model layer', () => {
    it('should reject profile with secret in system_prompt at model layer', async () => {
      await expect(
        defineProfile(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-prof',
          description: 'Test profile',
          system_prompt: 'Use api_key=SuperSecretKey12345678 for everything',
        }),
      ).rejects.toThrow(/secret/i);
    });
  });

  describe('defineProfile — REST route', () => {
    it('should reject profile with secret via REST', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'rest-bad-prof',
          description: 'safe',
          system_prompt: 'Use AKIAIOSFODNN7EXAMPLE to auth',
        },
      });
      expect(res.status).toBe(422);
    });
  });
});

// ─── H2: Body limit stream validation ───────────────────────────────────

describe('H2 — Body limit stream validation', () => {
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
    const config = testConfig({ maxBodyBytes: 1 }); // 1 byte limit
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

// ─── M1: Session cleanup ────────────────────────────────────────────────

describe('M1 — pruneExpiredSessions', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should remove expired sessions', async () => {
    const user = await createUser(ctx.db, { email: 'sess@test.com', password: 'password123' });

    // Create a session that's already expired
    const session = await createSession(ctx.db, user.id, { ttlDays: 0 });
    // Force expire by setting expires_at to the past
    ctx.rawDb.prepare(
      "UPDATE sessions SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
    ).run(session.sessionId);

    // Create a valid session
    const validSession = await createSession(ctx.db, user.id);

    const removed = await pruneExpiredSessions(ctx.db);
    expect(removed).toBe(1);

    // Expired session should be gone
    const expired = await getSession(ctx.db, session.raw);
    expect(expired).toBeNull();

    // Valid session should still exist
    const valid = await getSession(ctx.db, validSession.raw);
    expect(valid).not.toBeNull();
  });

  it('should remove revoked sessions', async () => {
    const user = await createUser(ctx.db, { email: 'revoke@test.com', password: 'password123' });
    const session = await createSession(ctx.db, user.id);

    // Mark as revoked
    ctx.rawDb.prepare(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?",
    ).run(session.sessionId);

    const removed = await pruneExpiredSessions(ctx.db);
    expect(removed).toBe(1);
  });

  it('should return 0 when nothing to prune', async () => {
    const user = await createUser(ctx.db, { email: 'clean@test.com', password: 'password123' });
    await createSession(ctx.db, user.id);

    const removed = await pruneExpiredSessions(ctx.db);
    expect(removed).toBe(0);
  });
});

// ─── M2: Context delta tracks decreases ─────────────────────────────────

describe('M2 — Context saveContext delta tracks both increases and decreases', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    setUsageTracking(true);
  });

  afterEach(() => {
    setUsageTracking(false);
  });

  it('should handle negative delta when replacing with smaller value', async () => {
    const largeValue = 'x'.repeat(1000);
    const smallValue = 'y'.repeat(100);

    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'shrink-test', value: largeValue, tags: [],
    });

    const usageAfterLarge = await getUsage(ctx.db, ctx.workspaceId);
    const bytesAfterLarge = usageAfterLarge.storageBytes;
    expect(bytesAfterLarge).toBeGreaterThan(0);

    // Replace with smaller value — should succeed and decrement storage
    const result = await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'shrink-test', value: smallValue, tags: [],
    });
    expect(result.key).toBe('shrink-test');

    const smallBytes = Buffer.byteLength(smallValue, 'utf8');
    const usageAfterShrink = await getUsage(ctx.db, ctx.workspaceId);
    expect(usageAfterShrink.storageBytes).toBe(smallBytes);
  });

  it('should not change usage when replacing with same-size value', async () => {
    const value1 = 'a'.repeat(500);
    const value2 = 'b'.repeat(500);

    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'same-size', value: value1, tags: [],
    });
    const usage1 = await getUsage(ctx.db, ctx.workspaceId);

    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'same-size', value: value2, tags: [],
    });
    const usage2 = await getUsage(ctx.db, ctx.workspaceId);

    expect(usage2.storageBytes).toBe(usage1.storageBytes);
  });

  it('should increase usage when replacing with larger value', async () => {
    const small = 'x'.repeat(100);
    const large = 'y'.repeat(1000);

    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'grow-test', value: small, tags: [],
    });
    const usage1 = await getUsage(ctx.db, ctx.workspaceId);

    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'grow-test', value: large, tags: [],
    });
    const usage2 = await getUsage(ctx.db, ctx.workspaceId);

    expect(usage2.storageBytes).toBeGreaterThan(usage1.storageBytes);
  });
});

// ─── M3: decrementUsageForced (quota rollback mechanism) ────────────────

describe('M3 — decrementUsageForced for quota TOCTOU rollback', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should decrement usage counters', async () => {
    // Set up some usage
    await incrementUsageForced(ctx.db, ctx.workspaceId, { exec: 10, apiCall: 5 });
    const before = await getUsage(ctx.db, ctx.workspaceId);
    expect(before.execCount).toBe(10);
    expect(before.apiCallCount).toBe(5);

    // Decrement (simulate rollback)
    await decrementUsageForced(ctx.db, ctx.workspaceId, { exec: 3, apiCall: 2 });
    const after = await getUsage(ctx.db, ctx.workspaceId);
    expect(after.execCount).toBe(7);
    expect(after.apiCallCount).toBe(3);
  });

  it('should floor at zero (not go negative)', async () => {
    await incrementUsageForced(ctx.db, ctx.workspaceId, { exec: 2 });

    // Try to decrement more than current value
    await decrementUsageForced(ctx.db, ctx.workspaceId, { exec: 10 });
    const after = await getUsage(ctx.db, ctx.workspaceId);
    expect(after.execCount).toBe(0);
  });

  it('should be no-op when all deltas are zero', async () => {
    await incrementUsageForced(ctx.db, ctx.workspaceId, { exec: 5 });
    await decrementUsageForced(ctx.db, ctx.workspaceId, { exec: 0, apiCall: 0, storageBytes: 0 });
    const after = await getUsage(ctx.db, ctx.workspaceId);
    expect(after.execCount).toBe(5);
  });
});
