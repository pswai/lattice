import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Context API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /api/v1/context — save_context', () => {
    it('should save a new context entry', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'stripe-retry',
          value: 'Stripe retries webhooks 3 times with exponential backoff',
          tags: ['stripe', 'webhooks'],
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.key).toBe('stripe-retry');
      expect(data.created).toBe(true);
      expect(data.id).toBeGreaterThan(0);
    });

    it('should replace an existing entry with the same key', async () => {
      const headers = authHeaders(ctx.apiKey);
      const body = {
        key: 'my-key',
        value: 'original value',
        tags: ['test'],
      };

      await request(ctx.app, 'POST', '/api/v1/context', { headers, body });

      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: { ...body, value: 'updated value' },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.created).toBe(false);
    });

    it('should save context with empty tags array', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'no-tags',
          value: 'entry with no tags',
          tags: [],
        },
      });

      expect(res.status).toBe(201);
    });

    it('should auto-broadcast LEARNING event on save', async () => {
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'test-key',
          value: 'test value',
          tags: ['test'],
        },
      });

      // Check events table for the auto-broadcast
      const res = await request(ctx.app, 'GET', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      const learningEvents = data.events.filter(
        (e: any) => e.eventType === 'LEARNING' && e.message.includes('test-key'),
      );
      expect(learningEvents.length).toBeGreaterThan(0);
    });

    it('should block content with secrets', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'bad-entry',
          value: 'my key is AKIAIOSFODNN7EXAMPLE',
          tags: [],
        },
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });

    it('should block secrets in the key field', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'AKIAIOSFODNN7EXAMPLE',
          value: 'safe value',
          tags: [],
        },
      });

      expect(res.status).toBe(422);
    });

    it('should reject missing key', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { value: 'test', tags: [] },
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('VALIDATION_ERROR');
    });

    it('should reject empty key', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: '', value: 'test', tags: [] },
      });

      expect(res.status).toBe(400);
    });

    it('should persist data across reads', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: { key: 'persist-test', value: 'persisted value', tags: ['persist'] },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/context?query=persisted', {
        headers,
      });

      const data = await res.json();
      expect(data.entries.length).toBeGreaterThan(0);
      expect(data.entries[0].value).toBe('persisted value');
    });
  });

  describe('GET /api/v1/context — get_context', () => {
    beforeEach(async () => {
      const headers = authHeaders(ctx.apiKey);
      // Seed some context entries
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: { key: 'stripe-webhooks', value: 'Stripe webhooks retry 3x', tags: ['stripe', 'webhooks'] },
      });
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: { key: 'auth-middleware', value: 'Auth requires X-Request-ID header', tags: ['auth', 'api'] },
      });
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: { key: 'db-migrations', value: 'Run migrations with prisma migrate', tags: ['database', 'prisma'] },
      });
    });

    it('should search by text query', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=stripe', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.entries.length).toBeGreaterThan(0);
      expect(data.entries[0].key).toBe('stripe-webhooks');
    });

    it('should filter by tags', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?tags=auth', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.entries.length).toBe(1);
      expect(data.entries[0].key).toBe('auth-middleware');
    });

    it('should combine query and tag filter', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=retry&tags=stripe', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.entries.length).toBe(1);
      expect(data.entries[0].key).toBe('stripe-webhooks');
    });

    it('should return empty results for non-matching query', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=nonexistent', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.entries).toHaveLength(0);
      expect(data.total).toBe(0);
    });

    it('should return empty results for non-matching tag', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?tags=nonexistent', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.entries).toHaveLength(0);
    });

    it('should respect limit parameter', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?tags=stripe,auth,database&limit=1', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.entries.length).toBeLessThanOrEqual(1);
    });

    it('should return all entries when no query or tags provided', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.entries.length).toBeGreaterThan(0);
    });

    it('should support OR matching on multiple tags', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?tags=stripe,auth', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      // Should find both stripe-webhooks and auth-middleware entries
      expect(data.entries.length).toBe(2);
    });
  });
});
