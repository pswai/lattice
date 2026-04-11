import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { broadcastEvent } from '../src/models/event.js';
import { sendMessage } from '../src/models/message.js';
import { eventBus } from '../src/services/event-emitter.js';

/**
 * Helper to read SSE events from a ReadableStream response.
 * Reads until we have at least `count` events or the stream ends.
 */
async function readSSEEvents(
  response: Response,
  count: number,
  timeoutMs: number = 2000,
): Promise<{ events: Array<{ id: string; event: string; data: string }>; raw: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const events: Array<{ id: string; event: string; data: string }> = [];

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
      ),
    ]);

    if (value) {
      raw += decoder.decode(value, { stream: true });
    }

    // Parse SSE events from raw buffer
    const blocks = raw.split('\n\n');
    // Keep the last incomplete block in the buffer
    raw = blocks.pop() || '';

    for (const block of blocks) {
      if (!block.trim() || block.trim().startsWith(':')) continue;
      const lines = block.split('\n');
      const entry: { id: string; event: string; data: string } = { id: '', event: '', data: '' };
      for (const line of lines) {
        if (line.startsWith('id: ')) entry.id = line.slice(4);
        else if (line.startsWith('event: ')) entry.event = line.slice(7);
        else if (line.startsWith('data: ')) entry.data = line.slice(6);
      }
      if (entry.id || entry.data) {
        events.push(entry);
      }
    }

    if (events.length >= count || done) break;
  }

  reader.releaseLock();
  return { events, raw };
}

describe('SSE Events Streaming', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('GET /api/v1/events/stream', () => {
    it('should require authentication', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/events/stream');
      expect(res.status).toBe(401);
    });

    it('should return SSE content type', async () => {
      const res = await ctx.app.request('/api/v1/events/stream', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
    });

    it('should backfill existing events on connect', async () => {
      // Seed some events first
      await broadcastEvent(ctx.db, ctx.workspaceId, 'agent-1', {
        event_type: 'LEARNING',
        message: 'First learning',
        tags: ['test'],
      });
      await broadcastEvent(ctx.db, ctx.workspaceId, 'agent-1', {
        event_type: 'BROADCAST',
        message: 'First broadcast',
        tags: ['test'],
      });

      const res = await ctx.app.request('/api/v1/events/stream', {
        headers: authHeaders(ctx.apiKey),
      });

      const { events } = await readSSEEvents(res, 2);
      expect(events.length).toBe(2);
      expect(events[0].event).toBe('message');

      const data0 = JSON.parse(events[0].data);
      expect(data0.message).toBe('First learning');
      expect(data0.eventType).toBe('LEARNING');

      const data1 = JSON.parse(events[1].data);
      expect(data1.message).toBe('First broadcast');
    });

    it('should receive new events via eventBus', async () => {
      const res = await ctx.app.request('/api/v1/events/stream', {
        headers: authHeaders(ctx.apiKey),
      });

      // Broadcast an event after connecting
      await broadcastEvent(ctx.db, ctx.workspaceId, 'agent-1', {
        event_type: 'ERROR',
        message: 'Something went wrong',
        tags: ['error'],
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events.length).toBe(1);
      const data = JSON.parse(events[0].data);
      expect(data.message).toBe('Something went wrong');
      expect(data.eventType).toBe('ERROR');
    });

    it('should support Last-Event-ID for resumption', async () => {
      // Seed events
      const { eventId: id1 } = await broadcastEvent(ctx.db, ctx.workspaceId, 'agent-1', {
        event_type: 'LEARNING',
        message: 'Event one',
        tags: ['test'],
      });
      await broadcastEvent(ctx.db, ctx.workspaceId, 'agent-1', {
        event_type: 'BROADCAST',
        message: 'Event two',
        tags: ['test'],
      });

      // Connect with Last-Event-ID set to the first event
      const res = await ctx.app.request('/api/v1/events/stream', {
        headers: {
          ...authHeaders(ctx.apiKey),
          'Last-Event-ID': String(id1),
        },
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events.length).toBe(1);
      const data = JSON.parse(events[0].data);
      expect(data.message).toBe('Event two');
    });

    it('should still deliver new events when Last-Event-ID is larger than the current max', async () => {
      // Connect with a stale / bogus Last-Event-ID higher than any event that exists.
      // Regression: this used to pin lastSentId above the true max and silently drop
      // subsequent events whose ids were lower than the bogus cursor.
      const res = await ctx.app.request('/api/v1/events/stream', {
        headers: {
          ...authHeaders(ctx.apiKey),
          'Last-Event-ID': '999999',
        },
      });

      await broadcastEvent(ctx.db, ctx.workspaceId, 'agent-1', {
        event_type: 'BROADCAST',
        message: 'should still arrive',
        tags: ['regression'],
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events.length).toBe(1);
      const data = JSON.parse(events[0].data);
      expect(data.message).toBe('should still arrive');
    });

    it('should not receive events from other teams', async () => {
      // Create a second team
      const otherTeamId = 'other-team';
      const otherApiKey = 'ltk_other_key_12345678901234567890';
      const { createHash } = await import('crypto');
      const keyHash = createHash('sha256').update(otherApiKey).digest('hex');
      ctx.rawDb.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(otherTeamId, 'Other Team');
      ctx.rawDb.prepare('INSERT INTO api_keys (workspace_id, key_hash, label) VALUES (?, ?, ?)').run(otherTeamId, keyHash, 'other key');

      // Connect SSE for the main team
      const res = await ctx.app.request('/api/v1/events/stream', {
        headers: authHeaders(ctx.apiKey),
      });

      // Broadcast event to the OTHER team
      await broadcastEvent(ctx.db, otherTeamId, 'other-agent', {
        event_type: 'BROADCAST',
        message: 'Other team event',
        tags: ['test'],
      });

      // Also broadcast event to OUR team
      await broadcastEvent(ctx.db, ctx.workspaceId, 'agent-1', {
        event_type: 'BROADCAST',
        message: 'Our team event',
        tags: ['test'],
      });

      const { events } = await readSSEEvents(res, 1);
      // Should only receive our team's event
      expect(events.length).toBe(1);
      const data = JSON.parse(events[0].data);
      expect(data.message).toBe('Our team event');
    });

    it('should format SSE events correctly', async () => {
      await broadcastEvent(ctx.db, ctx.workspaceId, 'agent-1', {
        event_type: 'LEARNING',
        message: 'Test event',
        tags: ['test'],
      });

      const res = await ctx.app.request('/api/v1/events/stream', {
        headers: authHeaders(ctx.apiKey),
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events[0].id).toBeTruthy();
      expect(events[0].event).toBe('message');
      const data = JSON.parse(events[0].data);
      expect(data.id).toBe(Number(events[0].id));
      expect(data.workspaceId).toBe(ctx.workspaceId);
    });
  });

  describe('GET /api/v1/messages/stream', () => {
    it('should require authentication', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/messages/stream');
      expect(res.status).toBe(401);
    });

    it('should return SSE content type', async () => {
      const res = await ctx.app.request('/api/v1/messages/stream', {
        headers: authHeaders(ctx.apiKey, 'agent-alice'),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('should backfill existing messages for the agent', async () => {
      await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-alice', message: 'hello alice 1', tags: [],
      });
      await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-alice', message: 'hello alice 2', tags: [],
      });

      const res = await ctx.app.request('/api/v1/messages/stream', {
        headers: authHeaders(ctx.apiKey, 'agent-alice'),
      });

      const { events } = await readSSEEvents(res, 2);
      expect(events.length).toBe(2);
      const m0 = JSON.parse(events[0].data);
      const m1 = JSON.parse(events[1].data);
      expect(m0.message).toBe('hello alice 1');
      expect(m0.toAgent).toBe('agent-alice');
      expect(m1.message).toBe('hello alice 2');
    });

    it('should receive new messages via eventBus', async () => {
      const res = await ctx.app.request('/api/v1/messages/stream', {
        headers: authHeaders(ctx.apiKey, 'agent-alice'),
      });

      await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-alice', message: 'live message', tags: ['live'],
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events.length).toBe(1);
      const m = JSON.parse(events[0].data);
      expect(m.message).toBe('live message');
      expect(m.fromAgent).toBe('agent-bob');
    });

    it('should not deliver messages addressed to a different agent', async () => {
      const res = await ctx.app.request('/api/v1/messages/stream', {
        headers: authHeaders(ctx.apiKey, 'agent-alice'),
      });

      // Message to a different agent — must NOT appear on alice's stream
      await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-carol', message: 'not for alice', tags: [],
      });
      // Message to alice — should appear
      await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-alice', message: 'for alice', tags: [],
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events.length).toBe(1);
      const m = JSON.parse(events[0].data);
      expect(m.message).toBe('for alice');
    });

    it('should not deliver messages from other workspaces', async () => {
      const otherTeamId = 'other-team';
      const otherApiKey = 'ltk_other_key_12345678901234567890';
      const { createHash } = await import('crypto');
      const keyHash = createHash('sha256').update(otherApiKey).digest('hex');
      ctx.rawDb.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(otherTeamId, 'Other Team');
      ctx.rawDb.prepare('INSERT INTO api_keys (workspace_id, key_hash, label) VALUES (?, ?, ?)').run(otherTeamId, keyHash, 'other key');

      const res = await ctx.app.request('/api/v1/messages/stream', {
        headers: authHeaders(ctx.apiKey, 'agent-alice'),
      });

      // Cross-workspace message to an agent that happens to share the id
      await sendMessage(ctx.db, otherTeamId, 'cross-agent', {
        to: 'agent-alice', message: 'cross-workspace leakage', tags: [],
      });
      // Same-workspace message should arrive
      await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-alice', message: 'same workspace', tags: [],
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events.length).toBe(1);
      const m = JSON.parse(events[0].data);
      expect(m.message).toBe('same workspace');
    });

    it('should support Last-Event-ID for resumption', async () => {
      const { messageId: id1 } = await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-alice', message: 'first', tags: [],
      });
      await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-alice', message: 'second', tags: [],
      });

      const res = await ctx.app.request('/api/v1/messages/stream', {
        headers: {
          ...authHeaders(ctx.apiKey, 'agent-alice'),
          'Last-Event-ID': String(id1),
        },
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events.length).toBe(1);
      const m = JSON.parse(events[0].data);
      expect(m.message).toBe('second');
    });

    it('should still deliver new messages when Last-Event-ID is larger than the current max', async () => {
      // Regression guard for the clamp fix in the onMessage handler.
      const res = await ctx.app.request('/api/v1/messages/stream', {
        headers: {
          ...authHeaders(ctx.apiKey, 'agent-alice'),
          'Last-Event-ID': '999999',
        },
      });

      await sendMessage(ctx.db, ctx.workspaceId, 'agent-bob', {
        to: 'agent-alice', message: 'arrives despite bogus cursor', tags: [],
      });

      const { events } = await readSSEEvents(res, 1);
      expect(events.length).toBe(1);
      const m = JSON.parse(events[0].data);
      expect(m.message).toBe('arrives despite bogus cursor');
    });
  });
});

// ─── EventEmitter (eventBus) pub/sub (from round3-coverage-p0) ────────

describe('EventEmitter (eventBus)', () => {
  it('should emit and receive events', () => {
    const received: string[] = [];
    const handler = (msg: string) => received.push(msg);

    eventBus.on('test-event', handler);
    eventBus.emit('test-event', 'hello');

    expect(received).toEqual(['hello']);
    eventBus.off('test-event', handler);
  });

  it('should support multiple listeners', () => {
    const results: number[] = [];
    const h1 = () => results.push(1);
    const h2 = () => results.push(2);

    eventBus.on('multi', h1);
    eventBus.on('multi', h2);
    eventBus.emit('multi');

    expect(results).toEqual([1, 2]);
    eventBus.off('multi', h1);
    eventBus.off('multi', h2);
  });

  it('should not receive events after unsubscribe', () => {
    const received: string[] = [];
    const handler = (msg: string) => received.push(msg);

    eventBus.on('unsub-test', handler);
    eventBus.emit('unsub-test', 'before');
    eventBus.off('unsub-test', handler);
    eventBus.emit('unsub-test', 'after');

    expect(received).toEqual(['before']);
  });

  it('should have unlimited maxListeners (0 = no cap)', () => {
    expect(eventBus.getMaxListeners()).toBe(0);
  });

  it('should isolate different event names', () => {
    const aReceived: string[] = [];
    const bReceived: string[] = [];
    const hA = (msg: string) => aReceived.push(msg);
    const hB = (msg: string) => bReceived.push(msg);

    eventBus.on('event-a', hA);
    eventBus.on('event-b', hB);

    eventBus.emit('event-a', 'for-a');
    eventBus.emit('event-b', 'for-b');

    expect(aReceived).toEqual(['for-a']);
    expect(bReceived).toEqual(['for-b']);

    eventBus.off('event-a', hA);
    eventBus.off('event-b', hB);
  });

  it('should handle errors in listeners without crashing other listeners', () => {
    const results: number[] = [];
    const safeHandler = () => results.push(42);

    eventBus.on('error-test', safeHandler);
    eventBus.emit('error-test');

    expect(results).toEqual([42]);
    eventBus.off('error-test', safeHandler);
  });
});
