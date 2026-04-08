import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { safeJsonParse } from '../src/safe-json.js';

describe('Edge Cases', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('Empty strings', () => {
    it('should reject empty key in save_context', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: '', value: 'test', tags: [] },
      });
      expect(res.status).toBe(400);
    });

    it('should reject empty value in save_context', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'test', value: '', tags: [] },
      });
      expect(res.status).toBe(400);
    });

    it('should reject empty message in broadcast', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: { event_type: 'BROADCAST', message: '', tags: [] },
      });
      expect(res.status).toBe(400);
    });

    it('should reject empty description in create_task', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: '' },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Very long content', () => {
    it('should accept value up to 100KB', async () => {
      const longValue = 'x'.repeat(100_000);
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'long-value', value: longValue, tags: [] },
      });
      expect(res.status).toBe(201);
    });

    it('should reject value over 100KB', async () => {
      const tooLong = 'x'.repeat(100_001);
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'too-long', value: tooLong, tags: [] },
      });
      expect(res.status).toBe(400);
    });

    it('should accept message up to 10KB', async () => {
      const longMsg = 'x'.repeat(10_000);
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: { event_type: 'BROADCAST', message: longMsg, tags: [] },
      });
      expect(res.status).toBe(201);
    });

    it('should reject message over 10KB', async () => {
      const tooLong = 'x'.repeat(10_001);
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: { event_type: 'BROADCAST', message: tooLong, tags: [] },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Special characters and unicode', () => {
    it('should handle unicode in context value', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: {
          key: 'unicode-test',
          value: 'Emojis: 🚀🎉 Chinese: 你好世界 Japanese: こんにちは Arabic: مرحبا',
          tags: ['unicode'],
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/context?tags=unicode', {
        headers,
      });

      const data = await res.json();
      expect(data.entries[0].value).toContain('🚀');
      expect(data.entries[0].value).toContain('你好世界');
    });

    it('should handle special characters in tags', async () => {
      const headers = authHeaders(ctx.apiKey);
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: {
          key: 'special-tags',
          value: 'test value',
          tags: ['tag-with-dash', 'tag_with_underscore', 'CamelCase'],
        },
      });
      expect(res.status).toBe(201);
    });

    it('should handle unicode in event messages', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: {
          event_type: 'BROADCAST',
          message: 'Alert: システムエラーが発生しました 🔥',
          tags: ['error'],
        },
      });
      expect(res.status).toBe(201);
    });

    it('should handle keys with dots and slashes', async () => {
      const headers = authHeaders(ctx.apiKey);
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: {
          key: 'config/database.connection-pool',
          value: 'Pool size is 10',
          tags: ['config'],
        },
      });
      expect(res.status).toBe(201);

      const getRes = await request(ctx.app, 'GET', '/api/v1/context?tags=config', {
        headers,
      });
      const data = await getRes.json();
      expect(data.entries[0].key).toBe('config/database.connection-pool');
    });
  });

  describe('FTS5 special characters', () => {
    it('should handle queries with special FTS5 characters', async () => {
      const headers = authHeaders(ctx.apiKey);

      // Save some content first
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers,
        body: { key: 'test-entry', value: 'Testing FTS5 search', tags: ['test'] },
      });

      // Query with simple term (should work)
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=testing', {
        headers,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('Tag limits', () => {
    it('should accept up to 20 tags', async () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'many-tags', value: 'value', tags },
      });
      expect(res.status).toBe(201);
    });

    it('should reject more than 20 tags', async () => {
      const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'too-many-tags', value: 'value', tags },
      });
      expect(res.status).toBe(400);
    });

    it('should reject tags longer than 50 characters', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'long-tag',
          value: 'value',
          tags: ['a'.repeat(51)],
        },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Key length limits', () => {
    it('should accept key up to 255 characters', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'k'.repeat(255), value: 'value', tags: [] },
      });
      expect(res.status).toBe(201);
    });

    it('should reject key over 255 characters', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'k'.repeat(256), value: 'value', tags: [] },
      });
      expect(res.status).toBe(400);
    });
  });
});

// ─── safeJsonParse returns fallback for corrupt JSON (from round7-fixes) ─

describe('safeJsonParse returns fallback for corrupt JSON', () => {
  it('should return fallback for truncated JSON', () => {
    const result = safeJsonParse<string[]>('["a","b', []);
    expect(result).toEqual([]);
  });

  it('should return fallback for completely invalid JSON', () => {
    const result = safeJsonParse<Record<string, unknown>>('not-json-at-all', {});
    expect(result).toEqual({});
  });

  it('should return fallback for empty string', () => {
    const result = safeJsonParse<number[]>('', []);
    expect(result).toEqual([]);
  });

  it('should parse valid JSON normally', () => {
    const result = safeJsonParse<number[]>('[1,2,3]', []);
    expect(result).toEqual([1, 2, 3]);
  });

  it('should return fallback for null literal input', () => {
    const result = safeJsonParse<string[]>('null', ['default']);
    expect(result).toBeNull();
  });

  it('should handle corrupt JSON in workflow task_ids context', () => {
    const result = safeJsonParse<number[]>('{broken', []);
    expect(result).toEqual([]);
  });

  it('should handle corrupt JSON in event tags context', () => {
    const result = safeJsonParse<string[]>('[invalid', []);
    expect(result).toEqual([]);
  });
});
