import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Artifacts API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /api/v1/artifacts — save_artifact', () => {
    it('should save an HTML artifact', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'designer'),
        body: {
          key: 'landing-page',
          content_type: 'text/html',
          content: '<html><body><h1>Hello</h1></body></html>',
          metadata: { title: 'Landing' },
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeGreaterThan(0);
      expect(data.key).toBe('landing-page');
      expect(data.created).toBe(true);
      expect(data.size).toBe(40);
    });

    it('should save a markdown artifact', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'writer'),
        body: {
          key: 'report.md',
          content_type: 'text/markdown',
          content: '# Report\n\nSome content.',
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.created).toBe(true);
    });

    it('should save a JSON artifact', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'analyst'),
        body: {
          key: 'data.json',
          content_type: 'application/json',
          content: JSON.stringify({ foo: 'bar', n: 42 }),
        },
      });

      expect(res.status).toBe(201);
    });

    it('should reject content exceeding 1 MB', async () => {
      const bigContent = 'a'.repeat(1_048_577);
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'spammer'),
        body: {
          key: 'too-big',
          content_type: 'text/plain',
          content: bigContent,
        },
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid content_type', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'sneaky'),
        body: {
          key: 'evil.bin',
          content_type: 'application/octet-stream',
          content: 'hello',
        },
      });

      expect(res.status).toBe(400);
    });

    it('should block secrets in content', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'leaker'),
        body: {
          key: 'config.txt',
          content_type: 'text/plain',
          content: 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
        },
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });

    it('should upsert on same key', async () => {
      const headers = authHeaders(ctx.apiKey, 'writer');

      const r1 = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers,
        body: { key: 'doc', content_type: 'text/plain', content: 'v1' },
      });
      const d1 = await r1.json();
      expect(d1.created).toBe(true);

      const r2 = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers,
        body: { key: 'doc', content_type: 'text/plain', content: 'v2 updated' },
      });
      const d2 = await r2.json();
      expect(d2.created).toBe(false);
      expect(d2.id).toBe(d1.id);

      const r3 = await request(ctx.app, 'GET', '/api/v1/artifacts/doc', { headers });
      const d3 = await r3.json();
      expect(d3.content).toBe('v2 updated');
    });
  });

  describe('GET /api/v1/artifacts — list_artifacts', () => {
    beforeEach(async () => {
      const headers = authHeaders(ctx.apiKey, 'seeder');
      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers,
        body: { key: 'a.html', content_type: 'text/html', content: '<p>a</p>' },
      });
      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers,
        body: { key: 'b.html', content_type: 'text/html', content: '<p>b</p>' },
      });
      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers,
        body: { key: 'c.json', content_type: 'application/json', content: '{}' },
      });
    });

    it('should list all artifacts without content', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'seeder'),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.total).toBe(3);
      expect(data.artifacts).toHaveLength(3);
      // Summaries must not include content
      for (const a of data.artifacts) {
        expect(a.content).toBeUndefined();
        expect(a.size).toBeGreaterThan(0);
        expect(a.key).toBeDefined();
      }
    });

    it('should filter by content_type', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/artifacts?content_type=text/html', {
        headers: authHeaders(ctx.apiKey, 'seeder'),
      });
      const data = await res.json();
      expect(data.total).toBe(2);
      expect(data.artifacts).toHaveLength(2);
      for (const a of data.artifacts) {
        expect(a.contentType).toBe('text/html');
      }
    });
  });

  describe('GET /api/v1/artifacts/:key — get_artifact', () => {
    it('should return artifact with full content', async () => {
      const headers = authHeaders(ctx.apiKey, 'writer');
      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers,
        body: {
          key: 'full',
          content_type: 'text/markdown',
          content: '# Hello',
          metadata: { author: 'writer' },
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/artifacts/full', { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.key).toBe('full');
      expect(data.content).toBe('# Hello');
      expect(data.contentType).toBe('text/markdown');
      expect(data.metadata).toEqual({ author: 'writer' });
    });

    it('should 404 for missing artifact', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/artifacts/missing', {
        headers: authHeaders(ctx.apiKey, 'anyone'),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/artifacts/:key', () => {
    it('should delete an artifact', async () => {
      const headers = authHeaders(ctx.apiKey, 'writer');
      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers,
        body: { key: 'trash', content_type: 'text/plain', content: 'bye' },
      });

      const delRes = await request(ctx.app, 'DELETE', '/api/v1/artifacts/trash', { headers });
      expect(delRes.status).toBe(200);
      const data = await delRes.json();
      expect(data.deleted).toBe(true);

      const getRes = await request(ctx.app, 'GET', '/api/v1/artifacts/trash', { headers });
      expect(getRes.status).toBe(404);
    });

    it('should 404 when deleting missing artifact', async () => {
      const res = await request(ctx.app, 'DELETE', '/api/v1/artifacts/missing', {
        headers: authHeaders(ctx.apiKey, 'anyone'),
      });
      expect(res.status).toBe(404);
    });
  });
});
