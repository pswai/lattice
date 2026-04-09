import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { waitForMessage, sendMessage } from '../src/models/message.js';

describe('wait_for_message', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('model: waitForMessage', () => {
    it('returns immediately if messages already exist', async () => {
      await sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
        to: 'agent-b',
        message: 'pre-existing',
        tags: [],
      });

      const start = Date.now();
      const result = await waitForMessage(ctx.db, ctx.workspaceId, 'agent-b', {
        since_id: 0,
        timeout_sec: 30,
      });
      const elapsed = Date.now() - start;

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('pre-existing');
      expect(elapsed).toBeLessThan(500);
    });

    it('waits and returns when a message arrives', async () => {
      const waitPromise = waitForMessage(ctx.db, ctx.workspaceId, 'agent-b', {
        since_id: 0,
        timeout_sec: 5,
      });

      // Send after a short delay
      setTimeout(() => {
        sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
          to: 'agent-b',
          message: 'wake up!',
          tags: [],
        });
      }, 50);

      const result = await waitPromise;
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('wake up!');
      expect(result.messages[0].fromAgent).toBe('agent-a');
    });

    it('times out and returns empty when no message arrives', async () => {
      const start = Date.now();
      const result = await waitForMessage(ctx.db, ctx.workspaceId, 'agent-b', {
        since_id: 0,
        timeout_sec: 1,
      });
      const elapsed = Date.now() - start;

      expect(result.messages).toHaveLength(0);
      expect(result.cursor).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2000);
    });

    it('only wakes for messages addressed to the waiting agent', async () => {
      const waitPromise = waitForMessage(ctx.db, ctx.workspaceId, 'agent-b', {
        since_id: 0,
        timeout_sec: 2,
      });

      // Send to a different agent first — should NOT wake agent-b
      setTimeout(() => {
        sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
          to: 'agent-c',
          message: 'not for you',
          tags: [],
        });
      }, 30);

      // Then send to agent-b — SHOULD wake it
      setTimeout(() => {
        sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
          to: 'agent-b',
          message: 'for you',
          tags: [],
        });
      }, 80);

      const result = await waitPromise;
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('for you');
    });

    it('isolates by workspace — other workspace messages do not wake the waiter', async () => {
      const otherWorkspace = 'other-workspace';
      ctx.rawDb.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(otherWorkspace, 'Other');

      const start = Date.now();
      const waitPromise = waitForMessage(ctx.db, ctx.workspaceId, 'agent-b', {
        since_id: 0,
        timeout_sec: 1,
      });

      setTimeout(() => {
        sendMessage(ctx.db, otherWorkspace, 'agent-a', {
          to: 'agent-b',
          message: 'wrong workspace',
          tags: [],
        });
      }, 50);

      const result = await waitPromise;
      const elapsed = Date.now() - start;
      expect(result.messages).toHaveLength(0);
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });

    it('returns zero-timeout immediately with empty result', async () => {
      const start = Date.now();
      const result = await waitForMessage(ctx.db, ctx.workspaceId, 'agent-b', {
        since_id: 0,
        timeout_sec: 0,
      });
      const elapsed = Date.now() - start;

      expect(result.messages).toHaveLength(0);
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('HTTP: GET /api/v1/messages/wait', () => {
    it('requires since_id', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/messages/wait', {
        headers: authHeaders(ctx.apiKey, 'agent-b'),
      });
      expect(res.status).toBe(400);
    });

    it('returns immediately when messages exist', async () => {
      const headers = authHeaders(ctx.apiKey, 'agent-a');
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers,
        body: { to: 'agent-b', message: 'existing', tags: [] },
      });

      const start = Date.now();
      const res = await request(
        ctx.app,
        'GET',
        '/api/v1/messages/wait?since_id=0&timeout_sec=30',
        { headers: authHeaders(ctx.apiKey, 'agent-b') },
      );
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(500);
    });

    it('times out when no messages', async () => {
      const res = await request(
        ctx.app,
        'GET',
        '/api/v1/messages/wait?since_id=0&timeout_sec=1',
        { headers: authHeaders(ctx.apiKey, 'agent-b') },
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages).toHaveLength(0);
      expect(data.cursor).toBe(0);
    });
  });
});
