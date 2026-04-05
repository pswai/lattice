import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { waitForEvent, broadcastEvent } from '../src/models/event.js';

describe('wait_for_event', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('model: waitForEvent', () => {
    it('returns immediately if matching events already exist', async () => {
      broadcastEvent(ctx.db, ctx.teamId, 'a', {
        event_type: 'BROADCAST',
        message: 'pre-existing',
        tags: [],
      });

      const start = Date.now();
      const result = await waitForEvent(ctx.db, ctx.teamId, {
        since_id: 0,
        timeout_sec: 30,
      });
      const elapsed = Date.now() - start;

      expect(result.events).toHaveLength(1);
      expect(result.events[0].message).toBe('pre-existing');
      expect(elapsed).toBeLessThan(500);
    });

    it('waits and returns when matching event arrives', async () => {
      const waitPromise = waitForEvent(ctx.db, ctx.teamId, {
        since_id: 0,
        timeout_sec: 5,
      });

      // Emit after a short delay
      setTimeout(() => {
        broadcastEvent(ctx.db, ctx.teamId, 'a', {
          event_type: 'BROADCAST',
          message: 'late-arrival',
          tags: [],
        });
      }, 50);

      const result = await waitPromise;
      expect(result.events).toHaveLength(1);
      expect(result.events[0].message).toBe('late-arrival');
    });

    it('times out and returns empty when no matching event arrives', async () => {
      const start = Date.now();
      const result = await waitForEvent(ctx.db, ctx.teamId, {
        since_id: 0,
        timeout_sec: 1,
      });
      const elapsed = Date.now() - start;

      expect(result.events).toHaveLength(0);
      expect(result.cursor).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2000);
    });

    it('respects topics filter — ignores non-matching events', async () => {
      const waitPromise = waitForEvent(ctx.db, ctx.teamId, {
        since_id: 0,
        topics: ['wanted'],
        timeout_sec: 2,
      });

      // Emit a non-matching event first
      setTimeout(() => {
        broadcastEvent(ctx.db, ctx.teamId, 'a', {
          event_type: 'BROADCAST',
          message: 'ignore me',
          tags: ['other'],
        });
      }, 30);

      // Then emit the matching event
      setTimeout(() => {
        broadcastEvent(ctx.db, ctx.teamId, 'a', {
          event_type: 'BROADCAST',
          message: 'pick me',
          tags: ['wanted'],
        });
      }, 80);

      const result = await waitPromise;
      expect(result.events).toHaveLength(1);
      expect(result.events[0].message).toBe('pick me');
    });

    it('respects event_type filter', async () => {
      const waitPromise = waitForEvent(ctx.db, ctx.teamId, {
        since_id: 0,
        event_type: 'ERROR',
        timeout_sec: 2,
      });

      setTimeout(() => {
        broadcastEvent(ctx.db, ctx.teamId, 'a', {
          event_type: 'BROADCAST',
          message: 'wrong type',
          tags: [],
        });
      }, 30);

      setTimeout(() => {
        broadcastEvent(ctx.db, ctx.teamId, 'a', {
          event_type: 'ERROR',
          message: 'right type',
          tags: [],
        });
      }, 80);

      const result = await waitPromise;
      expect(result.events).toHaveLength(1);
      expect(result.events[0].message).toBe('right type');
      expect(result.events[0].eventType).toBe('ERROR');
    });

    it('isolates by team — other team events do not wake the waiter', async () => {
      // Set up a second team
      const otherTeam = 'other-team';
      ctx.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(otherTeam, 'Other');

      const start = Date.now();
      const waitPromise = waitForEvent(ctx.db, ctx.teamId, {
        since_id: 0,
        timeout_sec: 1,
      });

      setTimeout(() => {
        broadcastEvent(ctx.db, otherTeam, 'a', {
          event_type: 'BROADCAST',
          message: 'other team event',
          tags: [],
        });
      }, 50);

      const result = await waitPromise;
      const elapsed = Date.now() - start;
      expect(result.events).toHaveLength(0);
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });
  });

  describe('HTTP: GET /api/v1/events/wait', () => {
    it('requires since_id', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/events/wait', {
        headers: authHeaders(ctx.apiKey),
      });
      expect(res.status).toBe(400);
    });

    it('returns immediately when events exist', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: { event_type: 'BROADCAST', message: 'existing', tags: ['foo'] },
      });

      const start = Date.now();
      const res = await request(
        ctx.app,
        'GET',
        '/api/v1/events/wait?since_id=0&timeout_sec=30',
        { headers },
      );
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(500);
    });

    it('times out when no events', async () => {
      const headers = authHeaders(ctx.apiKey);
      const res = await request(
        ctx.app,
        'GET',
        '/api/v1/events/wait?since_id=0&timeout_sec=1',
        { headers },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.events).toHaveLength(0);
      expect(data.cursor).toBe(0);
    });

    it('rejects invalid event_type', async () => {
      const res = await request(
        ctx.app,
        'GET',
        '/api/v1/events/wait?since_id=0&event_type=BOGUS&timeout_sec=0',
        { headers: authHeaders(ctx.apiKey) },
      );
      expect(res.status).toBe(400);
    });
  });
});
