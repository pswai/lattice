import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, testConfig, type TestContext } from './helpers.js';
import { broadcastEvent } from '../src/models/event.js';

describe('Events API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /api/v1/events — broadcast', () => {
    it('should broadcast a LEARNING event', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'LEARNING',
          message: 'Discovered that retry logic handles idempotency',
          tags: ['retry', 'idempotency'],
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.eventId).toBeGreaterThan(0);
    });

    it('should broadcast a BROADCAST event', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'BROADCAST',
          message: 'New API endpoint deployed',
          tags: ['deploy'],
        },
      });

      expect(res.status).toBe(201);
    });

    it('should broadcast an ESCALATION event', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'ESCALATION',
          message: 'Need human review for security finding',
          tags: ['security'],
        },
      });

      expect(res.status).toBe(201);
    });

    it('should broadcast an ERROR event', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'ERROR',
          message: 'Connection pool exhausted',
          tags: ['database', 'error'],
        },
      });

      expect(res.status).toBe(201);
    });

    it('should broadcast a TASK_UPDATE event', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'TASK_UPDATE',
          message: 'Task completed: fix webhook handler',
          tags: ['task'],
        },
      });

      expect(res.status).toBe(201);
    });

    it('should reject invalid event type', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'INVALID_TYPE',
          message: 'test',
          tags: [],
        },
      });

      expect(res.status).toBe(400);
    });

    it('should reject empty message', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'BROADCAST',
          message: '',
          tags: [],
        },
      });

      expect(res.status).toBe(400);
    });

    it('should block messages containing secrets', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'BROADCAST',
          message: 'Use key AKIAIOSFODNN7EXAMPLE for auth',
          tags: [],
        },
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });

    it('should broadcast with tags', async () => {
      const headers = authHeaders(ctx.apiKey);

      await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: {
          event_type: 'BROADCAST',
          message: 'Tagged event',
          tags: ['tag1', 'tag2', 'tag3'],
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/events?topics=tag1', {
        headers,
      });

      const data = await res.json();
      expect(data.events.length).toBeGreaterThan(0);
      expect(data.events[0].tags).toContain('tag1');
    });
  });

  describe('GET /api/v1/events — get_updates', () => {
    beforeEach(async () => {
      const headers = authHeaders(ctx.apiKey);
      // Seed events
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: { event_type: 'LEARNING', message: 'Event 1', tags: ['topicA'] },
      });
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: { event_type: 'BROADCAST', message: 'Event 2', tags: ['topicB'] },
      });
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: { event_type: 'ERROR', message: 'Event 3', tags: ['topicA', 'topicB'] },
      });
    });

    it('should return all events when no filter', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events.length).toBe(3);
      expect(data.cursor).toBeGreaterThan(0);
    });

    it('should filter events by since_id', async () => {
      const headers = authHeaders(ctx.apiKey);

      // Get all events first
      const allRes = await request(ctx.app, 'GET', '/api/v1/events', { headers });
      const allData = await allRes.json();
      const firstId = allData.events[0].id;

      // Get events after the first one
      const res = await request(ctx.app, 'GET', `/api/v1/events?since_id=${firstId}`, {
        headers,
      });

      const data = await res.json();
      expect(data.events.length).toBe(2);
      // All events should have id > firstId
      for (const event of data.events) {
        expect(event.id).toBeGreaterThan(firstId);
      }
    });

    it('should filter events by topics', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/events?topics=topicA', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.events.length).toBe(2); // Event 1 and Event 3
    });

    it('should combine since_id and topic filter', async () => {
      const headers = authHeaders(ctx.apiKey);

      const allRes = await request(ctx.app, 'GET', '/api/v1/events', { headers });
      const allData = await allRes.json();
      const firstId = allData.events[0].id;

      const res = await request(ctx.app, 'GET', `/api/v1/events?since_id=${firstId}&topics=topicA`, {
        headers,
      });

      const data = await res.json();
      // Should only get Event 3 (topicA, after first event)
      expect(data.events.length).toBe(1);
      expect(data.events[0].message).toBe('Event 3');
    });

    it('should return empty when no updates since cursor', async () => {
      const headers = authHeaders(ctx.apiKey);

      const allRes = await request(ctx.app, 'GET', '/api/v1/events', { headers });
      const allData = await allRes.json();
      const lastCursor = allData.cursor;

      const res = await request(ctx.app, 'GET', `/api/v1/events?since_id=${lastCursor}`, {
        headers,
      });

      const data = await res.json();
      expect(data.events).toHaveLength(0);
      expect(data.cursor).toBe(lastCursor);
    });

    it('should return events in chronological order', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      for (let i = 1; i < data.events.length; i++) {
        expect(data.events[i].id).toBeGreaterThan(data.events[i - 1].id);
      }
    });

    it('should respect limit parameter', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/events?limit=1', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.events.length).toBe(1);
    });

    it('should support since_timestamp filtering', async () => {
      const headers = authHeaders(ctx.apiKey);

      // Use a timestamp in the far past
      const res = await request(ctx.app, 'GET', '/api/v1/events?since_timestamp=2020-01-01T00:00:00Z', {
        headers,
      });

      const data = await res.json();
      expect(data.events.length).toBe(3);
    });

    it('should return cursor for pagination', async () => {
      const headers = authHeaders(ctx.apiKey);

      // First poll
      const res1 = await request(ctx.app, 'GET', '/api/v1/events?limit=2', { headers });
      const data1 = await res1.json();
      expect(data1.events.length).toBe(2);

      // Second poll using cursor
      const res2 = await request(ctx.app, 'GET', `/api/v1/events?since_id=${data1.cursor}`, {
        headers,
      });
      const data2 = await res2.json();
      expect(data2.events.length).toBe(1);
    });
  });

  describe('Multiple event types in one poll', () => {
    it('should return mixed event types', async () => {
      const headers = authHeaders(ctx.apiKey);

      await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: { event_type: 'LEARNING', message: 'Learn something', tags: ['shared'] },
      });
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: { event_type: 'ERROR', message: 'Something broke', tags: ['shared'] },
      });
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: { event_type: 'ESCALATION', message: 'Need help', tags: ['shared'] },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/events?topics=shared', { headers });
      const data = await res.json();

      const types = data.events.map((e: any) => e.eventType);
      expect(types).toContain('LEARNING');
      expect(types).toContain('ERROR');
      expect(types).toContain('ESCALATION');
    });
  });
});

// ─── Event cleanup service (from round3-coverage-p0) ──────────────────

describe('Event cleanup service', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should delete events older than retention days', async () => {
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'old event', '[]', 'agent', oldDate);

    await broadcastEvent(ctx.db, ctx.workspaceId, 'agent', {
      event_type: 'BROADCAST',
      message: 'recent event',
      tags: [],
    });

    const config = testConfig({ eventRetentionDays: 30 });
    const cutoff = new Date(Date.now() - config.eventRetentionDays * 24 * 60 * 60 * 1000).toISOString();

    const result = await ctx.db.run(`DELETE FROM events WHERE created_at < ?`, cutoff);
    expect(result.changes).toBe(1);

    const remaining = ctx.rawDb.prepare(
      `SELECT COUNT(*) as cnt FROM events WHERE workspace_id = ?`,
    ).get(ctx.workspaceId) as any;
    expect(remaining.cnt).toBe(1);
  });

  it('should not delete events when retentionDays is 0', async () => {
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'ancient event', '[]', 'agent', oldDate);

    const count = ctx.rawDb.prepare(
      `SELECT COUNT(*) as cnt FROM events WHERE workspace_id = ?`,
    ).get(ctx.workspaceId) as any;
    expect(count.cnt).toBe(1);
  });

  it('should handle cleanup with no matching events gracefully', async () => {
    await broadcastEvent(ctx.db, ctx.workspaceId, 'agent', {
      event_type: 'BROADCAST',
      message: 'fresh event',
      tags: [],
    });

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await ctx.db.run(`DELETE FROM events WHERE created_at < ?`, cutoff);
    expect(result.changes).toBe(0);
  });

  it('should cleanup events precisely at the boundary', async () => {
    const exactCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const olderDate = new Date(exactCutoff.getTime() - 1000).toISOString();
    const newerDate = new Date(exactCutoff.getTime() + 1000).toISOString();

    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'older', '[]', 'agent', olderDate);
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'newer', '[]', 'agent', newerDate);

    const result = await ctx.db.run(`DELETE FROM events WHERE created_at < ?`, exactCutoff.toISOString());
    expect(result.changes).toBe(1);

    const remaining = ctx.rawDb.prepare(
      `SELECT message FROM events WHERE workspace_id = ?`,
    ).get(ctx.workspaceId) as any;
    expect(remaining.message).toBe('newer');
  });
});
