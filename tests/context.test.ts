import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { saveContext, getContext } from '../src/models/context.js';

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

// ─── Context UPDATE tracks updated_by/updated_at (from round3-fixes) ──

describe('Context UPDATE tracks updated_by/updated_at', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should set updated_by and updated_at on context update', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent-a', {
      key: 'shared-key', value: 'original value', tags: ['test'],
    });

    const row1 = ctx.rawDb.prepare(
      'SELECT updated_by, updated_at FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'shared-key') as any;
    expect(row1.updated_by).toBeNull();
    expect(row1.updated_at).toBeNull();

    await saveContext(ctx.db, ctx.workspaceId, 'agent-b', {
      key: 'shared-key', value: 'updated value', tags: ['test'],
    });

    const row2 = ctx.rawDb.prepare(
      'SELECT updated_by, updated_at, created_by FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'shared-key') as any;
    expect(row2.updated_by).toBe('agent-b');
    expect(row2.updated_at).toBeTruthy();
    expect(row2.created_by).toBe('agent-a');
  });

  it('should not set updated_by on initial insert', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent-a', {
      key: 'new-key', value: 'new value', tags: [],
    });

    const row = ctx.rawDb.prepare(
      'SELECT updated_by, updated_at FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'new-key') as any;
    expect(row.updated_by).toBeNull();
    expect(row.updated_at).toBeNull();
  });

  it('should expose updatedBy and updatedAt in context search results', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent-a', {
      key: 'search-key', value: 'searchable context value here', tags: ['test'],
    });
    await saveContext(ctx.db, ctx.workspaceId, 'agent-b', {
      key: 'search-key', value: 'updated searchable context value here', tags: ['test'],
    });

    const result = await getContext(ctx.db, ctx.workspaceId, { query: 'searchable context', tags: ['test'] });
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].updatedBy).toBe('agent-b');
    expect(result.entries[0].updatedAt).toBeTruthy();
  });

  it('should track updater via REST API', async () => {
    const headers = authHeaders(ctx.apiKey, 'agent-a');
    await request(ctx.app, 'POST', '/api/v1/context', {
      headers,
      body: { key: 'rest-key', value: 'original', tags: ['rest'] },
    });

    const headersB = authHeaders(ctx.apiKey, 'agent-b');
    await request(ctx.app, 'POST', '/api/v1/context', {
      headers: headersB,
      body: { key: 'rest-key', value: 'updated', tags: ['rest'] },
    });

    const row = ctx.rawDb.prepare(
      'SELECT updated_by FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'rest-key') as any;
    expect(row.updated_by).toBe('agent-b');
  });
});

// ─── Context timestamps use consistent clock (from round4-fixes) ──────

describe('Context timestamps use consistent clock', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should use ISO 8601 format for both created_at and updated_at', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent-a', {
      key: 'clock-test', value: 'original', tags: [],
    });

    const row1 = ctx.rawDb.prepare(
      'SELECT created_at, updated_at FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'clock-test') as any;

    expect(row1.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    await saveContext(ctx.db, ctx.workspaceId, 'agent-b', {
      key: 'clock-test', value: 'updated', tags: [],
    });

    const row2 = ctx.rawDb.prepare(
      'SELECT created_at, updated_at FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'clock-test') as any;

    expect(new Date(row2.created_at).getTime()).toBeGreaterThan(0);
    expect(new Date(row2.updated_at).getTime()).toBeGreaterThan(0);
    expect(new Date(row2.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row2.created_at).getTime(),
    );
  });
});
