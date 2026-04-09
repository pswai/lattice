/**
 * Postgres compatibility integration tests.
 *
 * These tests exercise dialect-sensitive code paths that differ between
 * SQLite and Postgres: numeric type coercion, time functions, SQL dialect
 * translation, and full HTTP route integration.
 *
 * Skipped automatically when TEST_DATABASE_URL is not set.
 *
 * Local usage:
 *   npm run test:pg:up          # start Postgres container
 *   npm run test:pg             # run these tests
 *   npm run test:pg:down        # stop container
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { DbAdapter } from '../src/db/adapter.js';
import type { PgAdapter } from '../src/db/adapter.js';
import { getWorkspaceAnalytics, parseSinceDuration } from '../src/models/analytics.js';
import { createTask, updateTask, listTasks } from '../src/models/task.js';
import { broadcastEvent } from '../src/models/event.js';
import {
  createTestPgAdapter,
  truncatePgTables,
  createPgTestContext,
  seedTask,
  seedEvent,
  seedAgent,
  seedContext,
  seedMessage,
  authHeaders,
  request,
} from './helpers.js';
import type { Hono } from 'hono';

const PG_URL = process.env.TEST_DATABASE_URL;
const describePg = PG_URL ? describe : describe.skip;

describePg('Postgres compatibility', () => {
  let db: PgAdapter;

  beforeAll(async () => {
    const adapter = await createTestPgAdapter();
    if (!adapter) throw new Error('TEST_DATABASE_URL not set');
    db = adapter;
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await truncatePgTables(db);
  });

  // ── Numeric type coercion ───────────────────────────────────────────

  describe('analytics numeric types', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const nowIso = () => new Date().toISOString();

    let workspaceId: string;

    beforeEach(async () => {
      workspaceId = 'test-team';
      await db.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', workspaceId, 'Test');
    });

    it('returns zero-valued analytics with correct types for empty workspace', async () => {
      const since = ago(24 * 60 * 60 * 1000);
      const result = await getWorkspaceAnalytics(db, workspaceId, since);

      // Every numeric field must be typeof number, not string
      expect(typeof result.tasks.total).toBe('number');
      expect(typeof result.events.total).toBe('number');
      expect(typeof result.agents.total).toBe('number');
      expect(typeof result.agents.online).toBe('number');
      expect(typeof result.context.total_entries).toBe('number');
      expect(typeof result.context.entries_since).toBe('number');
      expect(typeof result.messages.total).toBe('number');
      expect(typeof result.messages.since).toBe('number');

      expect(result.tasks.total).toBe(0);
      expect(result.events.total).toBe(0);
      expect(result.tasks.avg_completion_ms).toBeNull();
      expect(result.tasks.median_completion_ms).toBeNull();
    });

    it('aggregates task counts as numbers (not string concatenation)', async () => {
      const now = nowIso();
      await seedTask(db, workspaceId, { status: 'open', createdBy: 'a', createdAt: ago(60000), updatedAt: now });
      await seedTask(db, workspaceId, { status: 'open', createdBy: 'a', createdAt: ago(60000), updatedAt: now });
      await seedTask(db, workspaceId, { status: 'claimed', createdBy: 'b', claimedBy: 'b', createdAt: ago(60000), updatedAt: now });
      await seedTask(db, workspaceId, { status: 'completed', createdBy: 'a', claimedBy: 'a', createdAt: ago(60000), updatedAt: now });

      const since = ago(24 * 60 * 60 * 1000);
      const result = await getWorkspaceAnalytics(db, workspaceId, since);

      expect(result.tasks.total).toBe(4);
      expect(result.tasks.by_status.open).toBe(2);
      expect(result.tasks.by_status.claimed).toBe(1);
      expect(result.tasks.by_status.completed).toBe(1);

      // Verify these are actual numbers, not '21' from '2' + '1'
      expect(typeof result.tasks.total).toBe('number');
      expect(typeof result.tasks.by_status.open).toBe('number');
    });

    it('aggregates event counts as numbers', async () => {
      for (const type of ['LEARNING', 'LEARNING', 'BROADCAST', 'ERROR', 'ESCALATION', 'TASK_UPDATE']) {
        await seedEvent(db, workspaceId, {
          eventType: type, message: `msg-${type}`, createdBy: 'agent', createdAt: ago(60000),
        });
      }

      const since = ago(24 * 60 * 60 * 1000);
      const result = await getWorkspaceAnalytics(db, workspaceId, since);

      expect(result.events.total).toBe(6);
      expect(result.events.by_type.LEARNING).toBe(2);
      expect(result.events.by_type.BROADCAST).toBe(1);
      expect(typeof result.events.total).toBe('number');
      expect(typeof result.events.by_type.LEARNING).toBe('number');
    });

    it('computes avg and median completion time with EXTRACT (not julianday)', async () => {
      const tenMin = 10 * 60 * 1000;
      const twentyMin = 20 * 60 * 1000;
      const thirtyMin = 30 * 60 * 1000;

      await seedTask(db, workspaceId, {
        status: 'completed', createdBy: 'a', claimedBy: 'a',
        createdAt: ago(tenMin + 60000), updatedAt: ago(60000),
      });
      await seedTask(db, workspaceId, {
        status: 'completed', createdBy: 'a', claimedBy: 'a',
        createdAt: ago(twentyMin + 60000), updatedAt: ago(60000),
      });
      await seedTask(db, workspaceId, {
        status: 'completed', createdBy: 'b', claimedBy: 'b',
        createdAt: ago(thirtyMin + 60000), updatedAt: ago(60000),
      });

      const since = ago(24 * 60 * 60 * 1000);
      const result = await getWorkspaceAnalytics(db, workspaceId, since);

      // avg ~20min, median ~20min
      expect(result.tasks.avg_completion_ms).not.toBeNull();
      expect(typeof result.tasks.avg_completion_ms).toBe('number');
      expect(result.tasks.avg_completion_ms!).toBeGreaterThan(19 * 60 * 1000);
      expect(result.tasks.avg_completion_ms!).toBeLessThan(21 * 60 * 1000);

      expect(result.tasks.median_completion_ms).not.toBeNull();
      expect(typeof result.tasks.median_completion_ms).toBe('number');
      expect(result.tasks.median_completion_ms!).toBeGreaterThan(19 * 60 * 1000);
      expect(result.tasks.median_completion_ms!).toBeLessThan(21 * 60 * 1000);
    });

    it('per-hour bucketing works with EXTRACT', async () => {
      // Insert events at known offsets
      await seedEvent(db, workspaceId, {
        eventType: 'LEARNING', message: 'recent', createdBy: 'a', createdAt: ago(5 * 60 * 1000), // ~0 hours ago
      });
      await seedEvent(db, workspaceId, {
        eventType: 'LEARNING', message: 'recent2', createdBy: 'a', createdAt: ago(10 * 60 * 1000), // ~0 hours ago
      });
      await seedEvent(db, workspaceId, {
        eventType: 'LEARNING', message: '2h ago', createdBy: 'a', createdAt: ago(2 * 60 * 60 * 1000 + 60000), // ~2 hours ago
      });

      const since = ago(24 * 60 * 60 * 1000);
      const result = await getWorkspaceAnalytics(db, workspaceId, since);

      expect(result.events.per_hour_last_24h).toHaveLength(24);
      expect(result.events.per_hour_last_24h[0]).toBe(2);
      expect(result.events.per_hour_last_24h[2]).toBe(1);
      // All entries are numbers
      for (const val of result.events.per_hour_last_24h) {
        expect(typeof val).toBe('number');
      }
    });

    it('top producers have numeric fields', async () => {
      await seedAgent(db, workspaceId, { id: 'alice', status: 'online' });
      await seedAgent(db, workspaceId, { id: 'bob', status: 'online' });

      await seedEvent(db, workspaceId, { eventType: 'LEARNING', message: 'a', createdBy: 'alice', createdAt: ago(60000) });
      await seedEvent(db, workspaceId, { eventType: 'LEARNING', message: 'b', createdBy: 'alice', createdAt: ago(60000) });
      await seedEvent(db, workspaceId, { eventType: 'BROADCAST', message: 'c', createdBy: 'bob', createdAt: ago(60000) });

      const now = nowIso();
      await seedTask(db, workspaceId, { status: 'completed', createdBy: 'bob', claimedBy: 'bob', createdAt: ago(60000), updatedAt: now });

      const since = ago(24 * 60 * 60 * 1000);
      const result = await getWorkspaceAnalytics(db, workspaceId, since);

      expect(result.agents.total).toBe(2);
      expect(typeof result.agents.total).toBe('number');
      expect(typeof result.agents.online).toBe('number');

      for (const p of result.agents.top_producers) {
        expect(typeof p.events).toBe('number');
        expect(typeof p.tasks_completed).toBe('number');
      }
    });

    it('context and message counts are numeric', async () => {
      await seedContext(db, workspaceId, { key: 'k1', value: 'v1', createdBy: 'a', createdAt: ago(60000) });
      await seedContext(db, workspaceId, { key: 'k2', value: 'v2', createdBy: 'b', createdAt: ago(60000) });
      await seedMessage(db, workspaceId, { from: 'a', to: 'b', message: 'hi', createdAt: ago(60000) });

      const since = ago(24 * 60 * 60 * 1000);
      const result = await getWorkspaceAnalytics(db, workspaceId, since);

      expect(result.context.total_entries).toBe(2);
      expect(result.context.entries_since).toBe(2);
      expect(result.messages.total).toBe(1);
      expect(result.messages.since).toBe(1);
      expect(typeof result.context.total_entries).toBe('number');
      expect(typeof result.messages.total).toBe('number');

      for (const a of result.context.top_authors) {
        expect(typeof a.count).toBe('number');
      }
    });
  });

  // ── SQL dialect translation ─────────────────────────────────────────

  describe('SQL dialect translation', () => {
    let workspaceId: string;

    beforeEach(async () => {
      workspaceId = 'test-team';
      await db.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', workspaceId, 'Test');
    });

    it('INSERT OR IGNORE translates to ON CONFLICT DO NOTHING', async () => {
      await db.run(
        'INSERT OR IGNORE INTO workspaces (id, name) VALUES (?, ?)',
        workspaceId, 'Duplicate',
      );
      // Should not throw, and original name should be preserved
      const row = await db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', workspaceId);
      expect(row!.name).toBe('Test');
    });

    it('placeholder rewriting works (? -> $1, $2, ...)', async () => {
      await seedTask(db, workspaceId, {
        status: 'open', createdBy: 'a',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const rows = await db.all<{ id: number }>(
        'SELECT id FROM tasks WHERE workspace_id = ? AND status = ?',
        workspaceId, 'open',
      );
      expect(rows.length).toBe(1);
    });

    it('transactions work with savepoints for nesting', async () => {
      await db.transaction(async (tx) => {
        await tx.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', 'inner-ws', 'Inner');

        // Nested transaction
        await tx.transaction(async (tx2) => {
          await tx2.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', 'nested-ws', 'Nested');
        });
      });

      const rows = await db.all<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      const ids = rows.map((r) => r.id);
      expect(ids).toContain('inner-ws');
      expect(ids).toContain('nested-ws');
    });

    it('transaction rollback on nested error does not affect outer', async () => {
      await db.transaction(async (tx) => {
        await tx.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', 'outer-ws', 'Outer');

        try {
          await tx.transaction(async (tx2) => {
            await tx2.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', 'doomed-ws', 'Doomed');
            throw new Error('rollback inner');
          });
        } catch {
          // Expected
        }
      });

      const rows = await db.all<{ id: string }>('SELECT id FROM workspaces');
      const ids = rows.map((r) => r.id);
      expect(ids).toContain('outer-ws');
      expect(ids).not.toContain('doomed-ws');
    });
  });

  // ── Model layer CRUD ───────────────────────────────────────────────

  describe('model layer CRUD', () => {
    let workspaceId: string;

    beforeEach(async () => {
      workspaceId = 'test-team';
      await db.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', workspaceId, 'Test');
      await seedAgent(db, workspaceId, { id: 'agent-a', status: 'online' });
    });

    it('creates and lists tasks', async () => {
      const result = await createTask(db, workspaceId, 'agent-a', {
        description: 'Fix the widget',
        status: 'open',
      });

      expect(result.task_id).toBeGreaterThan(0);
      expect(typeof result.task_id).toBe('number');

      const { tasks } = await listTasks(db, workspaceId, {});
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      expect(tasks[0].description).toBe('Fix the widget');
    });

    it('creates, claims, and completes a task', async () => {
      const created = await createTask(db, workspaceId, 'agent-a', {
        description: 'Build feature',
        status: 'open',
      });

      const claimed = await updateTask(db, workspaceId, 'agent-a', {
        task_id: created.task_id,
        status: 'claimed',
        version: 1,
      });
      expect(claimed.status).toBe('claimed');

      const completed = await updateTask(db, workspaceId, 'agent-a', {
        task_id: created.task_id,
        status: 'completed',
        version: 2,
        result: 'Done!',
      });
      expect(completed.status).toBe('completed');
    });

    it('broadcasts events', async () => {
      const event = await broadcastEvent(db, workspaceId, 'agent-a', {
        event_type: 'LEARNING',
        message: 'Discovered a pattern',
        tags: ['patterns'],
      });

      expect(event.eventId).toBeGreaterThan(0);
      expect(typeof event.eventId).toBe('number');
    });
  });

  // ── HTTP route integration ──────────────────────────────────────────

  describe('HTTP routes', () => {
    let app: Hono;
    let workspaceId: string;
    let apiKey: string;

    beforeEach(async () => {
      const ctx = await createPgTestContext(db);
      app = ctx.app;
      workspaceId = ctx.workspaceId;
      apiKey = ctx.apiKey;
    });

    it('GET /api/v1/analytics returns numeric values', async () => {
      // Seed some data
      await seedTask(db, workspaceId, {
        status: 'completed', createdBy: 'a', claimedBy: 'a',
        createdAt: new Date(Date.now() - 600000).toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await seedEvent(db, workspaceId, {
        eventType: 'LEARNING', message: 'test', createdBy: 'a',
        createdAt: new Date(Date.now() - 60000).toISOString(),
      });

      const res = await request(app, 'GET', '/api/v1/analytics', {
        headers: authHeaders(apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(typeof data.tasks.total).toBe('number');
      expect(typeof data.events.total).toBe('number');
      expect(data.tasks.total).toBe(1);
      expect(data.events.total).toBe(1);
    });

    it('GET /api/v1/dashboard-snapshot returns valid data', async () => {
      const res = await request(app, 'GET', '/api/v1/dashboard-snapshot', {
        headers: authHeaders(apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.workspace).toBeDefined();
      expect(data.analytics).toBeDefined();
      expect(typeof data.analytics.tasks.total).toBe('number');
      expect(typeof data.analytics.events.total).toBe('number');
    });

    it('GET /api/v1/dashboard-snapshot respects sections filter', async () => {
      const res = await request(app, 'GET', '/api/v1/dashboard-snapshot?sections=analytics', {
        headers: authHeaders(apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();

      // Analytics should be present
      expect(data.analytics).not.toBeNull();
      // Other sections should be null
      expect(data.agents).toBeNull();
      expect(data.tasks).toBeNull();
      expect(data.recentEvents).toBeNull();
      expect(data.auditLog).toBeNull();
      expect(data.apiKeys).toBeNull();
    });

    it('POST /api/v1/tasks creates task with numeric id', async () => {
      const res = await request(app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(apiKey),
        body: { description: 'Test task' },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(typeof data.task_id).toBe('number');
      expect(data.task_id).toBeGreaterThan(0);
    });

    it('POST /api/v1/events creates event with numeric id', async () => {
      const res = await request(app, 'POST', '/api/v1/events', {
        headers: authHeaders(apiKey, 'agent-a'),
        body: { event_type: 'LEARNING', message: 'test', tags: [] },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(typeof data.eventId).toBe('number');
      expect(data.eventId).toBeGreaterThan(0);
    });
  });
});
