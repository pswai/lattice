import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Messages — Advanced Scenarios', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('Message isolation between agents', () => {
    it('should deliver messages only to the intended recipient', async () => {
      // Agent A sends to Agent B
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: { to: 'agent-b', message: 'Secret for B only', tags: ['private'] },
      });

      // Agent A sends to Agent C
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: { to: 'agent-c', message: 'Secret for C only', tags: ['private'] },
      });

      // Agent B should only see their message
      const bRes = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-b'),
      });
      const bData = await bRes.json();
      expect(bData.messages).toHaveLength(1);
      expect(bData.messages[0].message).toBe('Secret for B only');
      expect(bData.messages[0].fromAgent).toBe('agent-a');

      // Agent C should only see their message
      const cRes = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-c'),
      });
      const cData = await cRes.json();
      expect(cData.messages).toHaveLength(1);
      expect(cData.messages[0].message).toBe('Secret for C only');

      // Agent A (sender) should see no messages (they're the sender, not recipient)
      const aRes = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
      });
      const aData = await aRes.json();
      expect(aData.messages).toHaveLength(0);
    });

    it('should allow bidirectional messaging', async () => {
      // Agent A sends to Agent B
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: { to: 'agent-b', message: 'Hello B', tags: [] },
      });

      // Agent B sends to Agent A
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-b'),
        body: { to: 'agent-a', message: 'Hello A', tags: [] },
      });

      // Agent A sees reply from B
      const aRes = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
      });
      const aData = await aRes.json();
      expect(aData.messages).toHaveLength(1);
      expect(aData.messages[0].message).toBe('Hello A');
      expect(aData.messages[0].fromAgent).toBe('agent-b');

      // Agent B sees message from A
      const bRes = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-b'),
      });
      const bData = await bRes.json();
      expect(bData.messages).toHaveLength(1);
      expect(bData.messages[0].message).toBe('Hello B');
      expect(bData.messages[0].fromAgent).toBe('agent-a');
    });
  });

  describe('Secret scanning in messages', () => {
    it('should block messages containing AWS access keys', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: 'agent-b',
          message: 'Use this key: AKIAIOSFODNN7EXAMPLE',
          tags: [],
        },
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });

    it('should block messages containing GitHub tokens', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: 'agent-b',
          message: 'My token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
          tags: [],
        },
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });

    it('should block messages containing database connection strings', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: 'agent-b',
          message: 'Connect to postgresql://admin:s3cret@db.host.com:5432/mydb',
          tags: [],
        },
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });

    it('should allow messages without secrets', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: 'agent-b',
          message: 'The API endpoint is https://api.example.com/v1/users',
          tags: ['api'],
        },
      });
      expect(res.status).toBe(201);
    });
  });

  describe('Pagination with since_id cursor', () => {
    it('should paginate through messages using cursor', async () => {
      // Send 5 messages to agent-b
      for (let i = 1; i <= 5; i++) {
        await request(ctx.app, 'POST', '/api/v1/messages', {
          headers: authHeaders(ctx.apiKey, 'agent-a'),
          body: { to: 'agent-b', message: `Message ${i}`, tags: ['batch'] },
        });
      }

      const headers = authHeaders(ctx.apiKey, 'agent-b');

      // Page 1: get first 2 messages
      const page1 = await request(ctx.app, 'GET', '/api/v1/messages?limit=2', { headers });
      const data1 = await page1.json();
      expect(data1.messages).toHaveLength(2);
      expect(data1.messages[0].message).toBe('Message 1');
      expect(data1.messages[1].message).toBe('Message 2');
      expect(data1.cursor).toBeGreaterThan(0);

      // Page 2: get next 2 messages using cursor
      const page2 = await request(ctx.app, 'GET', `/api/v1/messages?limit=2&since_id=${data1.cursor}`, { headers });
      const data2 = await page2.json();
      expect(data2.messages).toHaveLength(2);
      expect(data2.messages[0].message).toBe('Message 3');
      expect(data2.messages[1].message).toBe('Message 4');

      // Page 3: get remaining messages
      const page3 = await request(ctx.app, 'GET', `/api/v1/messages?since_id=${data2.cursor}`, { headers });
      const data3 = await page3.json();
      expect(data3.messages).toHaveLength(1);
      expect(data3.messages[0].message).toBe('Message 5');

      // Page 4: no more messages
      const page4 = await request(ctx.app, 'GET', `/api/v1/messages?since_id=${data3.cursor}`, { headers });
      const data4 = await page4.json();
      expect(data4.messages).toHaveLength(0);
      // Cursor should stay at last position
      expect(data4.cursor).toBe(data3.cursor);
    });
  });

  describe('Messages to non-existent agents', () => {
    it('should save messages to unregistered recipients for later delivery', async () => {
      // Send to agent that doesn't exist yet
      const sendRes = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: {
          to: 'future-agent',
          message: 'When you come online, read this',
          tags: ['onboarding'],
        },
      });
      expect(sendRes.status).toBe(201);

      // The future agent can read the message when it registers later
      const getRes = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'future-agent'),
      });
      const data = await getRes.json();
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].message).toBe('When you come online, read this');
      expect(data.messages[0].fromAgent).toBe('agent-a');
    });

    it('should accumulate messages for unregistered recipients', async () => {
      // Multiple senders send to future agent
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: { to: 'new-hire', message: 'Welcome!', tags: [] },
      });
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'agent-b'),
        body: { to: 'new-hire', message: 'Your task is ready', tags: [] },
      });

      // New hire gets all messages
      const getRes = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'new-hire'),
      });
      const data = await getRes.json();
      expect(data.messages).toHaveLength(2);
      expect(data.messages[0].fromAgent).toBe('agent-a');
      expect(data.messages[1].fromAgent).toBe('agent-b');
    });
  });

  describe('Message ordering and tags', () => {
    it('should return messages in chronological order', async () => {
      for (let i = 1; i <= 4; i++) {
        await request(ctx.app, 'POST', '/api/v1/messages', {
          headers: authHeaders(ctx.apiKey, `sender-${i}`),
          body: { to: 'collector', message: `Msg ${i}`, tags: [] },
        });
      }

      const res = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'collector'),
      });
      const data = await res.json();
      expect(data.messages).toHaveLength(4);
      for (let i = 1; i < data.messages.length; i++) {
        expect(data.messages[i].id).toBeGreaterThan(data.messages[i - 1].id);
      }
    });

    it('should preserve tags on messages', async () => {
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'tagger'),
        body: { to: 'reader', message: 'Tagged message', tags: ['urgent', 'bug-fix'] },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'reader'),
      });
      const data = await res.json();
      expect(data.messages[0].tags).toEqual(['urgent', 'bug-fix']);
    });
  });
});
