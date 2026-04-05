import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Messages API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /api/v1/messages — send_message', () => {
    it('should send a message between agents', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: 'agent-b',
          message: 'Hello from agent-a',
          tags: ['greeting'],
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.messageId).toBeGreaterThan(0);
    });

    it('should block secrets in messages', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: 'agent-b',
          message: 'Use key AKIAIOSFODNN7EXAMPLE for auth',
          tags: [],
        },
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });

    it('should reject invalid input', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: '',
          message: '',
          tags: [],
        },
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/messages — get_messages', () => {
    beforeEach(async () => {
      // Send messages to agent-b from agent-a
      for (let i = 1; i <= 3; i++) {
        await request(ctx.app, 'POST', '/api/v1/messages', {
          headers: authHeaders(ctx.apiKey, 'agent-a'),
          body: {
            to: 'agent-b',
            message: `Message ${i}`,
            tags: ['test'],
          },
        });
      }
      // Send a message to agent-c (should not appear for agent-b)
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: 'agent-c',
          message: 'Message for c',
          tags: [],
        },
      });
    });

    it('should get messages for a specific agent', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-b'),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages).toHaveLength(3);
      expect(data.cursor).toBeGreaterThan(0);
      expect(data.messages[0].fromAgent).toBe('agent-a');
      expect(data.messages[0].toAgent).toBe('agent-b');
    });

    it('should not see messages for other agents', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-b'),
      });

      const data = await res.json();
      for (const msg of data.messages) {
        expect(msg.toAgent).toBe('agent-b');
      }
      // agent-c's message should not appear
      expect(data.messages.every((m: any) => m.message !== 'Message for c')).toBe(true);
    });

    it('should paginate with since_id', async () => {
      const headers = authHeaders(ctx.apiKey, 'agent-b');

      // Get first page
      const res1 = await request(ctx.app, 'GET', '/api/v1/messages?limit=2', { headers });
      const data1 = await res1.json();
      expect(data1.messages).toHaveLength(2);

      // Get second page using cursor
      const res2 = await request(ctx.app, 'GET', `/api/v1/messages?since_id=${data1.cursor}`, { headers });
      const data2 = await res2.json();
      expect(data2.messages).toHaveLength(1);
      expect(data2.messages[0].message).toBe('Message 3');
    });

    it('should return empty when no messages', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-nobody'),
      });

      const data = await res.json();
      expect(data.messages).toHaveLength(0);
      expect(data.cursor).toBe(0);
    });

    it('should return messages in chronological order', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-b'),
      });

      const data = await res.json();
      for (let i = 1; i < data.messages.length; i++) {
        expect(data.messages[i].id).toBeGreaterThan(data.messages[i - 1].id);
      }
    });
  });
});
