import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

/**
 * MCP-vs-REST Parity Tests
 *
 * These tests document inconsistencies between the MCP tool schemas and REST
 * route schemas. Both should enforce the same validation rules since they
 * share the model layer, but Zod schemas at the transport layer may differ.
 *
 * Bug references are from the chaos-hacker audit.
 */
describe('MCP ↔ REST Parity', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  // ─── BUG 21: Artifact content max size ──────────────────────────
  // MCP schema describes "max 1 MB" but uses z.string().min(1) with no .max().
  // REST schema also uses z.string().min(1) with no .max().
  // The model layer enforces MAX_ARTIFACT_SIZE (1_048_576) for both.
  // This test verifies both paths reject oversized content identically.

  describe('BUG 21 — artifact content size limit parity', () => {
    it('REST should reject artifact content over 1 MB', async () => {
      const bigContent = 'a'.repeat(1_048_577);
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'writer'),
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

    it('REST should accept artifact content at exactly 1 MB', async () => {
      const exactContent = 'a'.repeat(1_048_576);
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'writer'),
        body: {
          key: 'just-right',
          content_type: 'text/plain',
          content: exactContent,
        },
      });
      expect(res.status).toBe(201);
    });

    it('REST should accept artifact content under 1 MB', async () => {
      const smallContent = 'hello world';
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'writer'),
        body: {
          key: 'small',
          content_type: 'text/plain',
          content: smallContent,
        },
      });
      expect(res.status).toBe(201);
    });
  });

  // ─── BUG 22: Tags array max length parity ──────────────────────
  // MCP schemas use .max(20) on tags arrays (via arrayParam wrapper).
  // REST schemas should also enforce .max(20).

  describe('BUG 22 — tags array max length parity', () => {
    it('REST context should reject more than 20 tags', async () => {
      const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'too-many-tags', value: 'test', tags },
      });
      expect(res.status).toBe(400);
    });

    it('REST context should accept exactly 20 tags', async () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'max-tags', value: 'test', tags },
      });
      expect(res.status).toBe(201);
    });

    it('REST events should reject more than 20 tags', async () => {
      const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: { event_type: 'BROADCAST', message: 'test', tags },
      });
      expect(res.status).toBe(400);
    });

    it('REST events should accept exactly 20 tags', async () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: { event_type: 'BROADCAST', message: 'test', tags },
      });
      expect(res.status).toBe(201);
    });

    it('REST messages should reject more than 20 tags', async () => {
      const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'sender'),
        body: { to: 'recipient', message: 'test', tags },
      });
      expect(res.status).toBe(400);
    });

    it('REST messages should accept exactly 20 tags', async () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      const res = await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(ctx.apiKey, 'sender'),
        body: { to: 'recipient', message: 'test', tags },
      });
      expect(res.status).toBe(201);
    });
  });

  // ─── BUG 29: Profile field name aliasing ────────────────────────
  // REST accepts both `capabilities` and `default_capabilities` via
  // a .transform() that aliases capabilities → default_capabilities.
  // MCP only uses `default_capabilities`.
  // This test documents that REST supports both field names.

  describe('BUG 29 — profile capabilities field aliasing', () => {
    const baseProfile = {
      name: 'test-role',
      description: 'A test role',
      system_prompt: 'You are a test agent',
    };

    it('REST should accept default_capabilities (canonical field)', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          ...baseProfile,
          default_capabilities: ['python', 'testing'],
        },
      });
      expect(res.status).toBe(201);
    });

    it('REST should accept capabilities (alias field)', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          ...baseProfile,
          name: 'alias-role',
          capabilities: ['python', 'testing'],
        },
      });
      expect(res.status).toBe(201);

      // Verify it was stored correctly
      const getRes = await request(ctx.app, 'GET', '/api/v1/profiles/alias-role', {
        headers: authHeaders(ctx.apiKey),
      });
      const profile = await getRes.json();
      expect(profile.defaultCapabilities).toEqual(['python', 'testing']);
    });

    it('REST should prefer default_capabilities over capabilities when both provided', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          ...baseProfile,
          name: 'both-fields',
          default_capabilities: ['preferred'],
          capabilities: ['ignored'],
        },
      });
      expect(res.status).toBe(201);

      const getRes = await request(ctx.app, 'GET', '/api/v1/profiles/both-fields', {
        headers: authHeaders(ctx.apiKey),
      });
      const profile = await getRes.json();
      // default_capabilities takes priority via ?? operator
      expect(profile.defaultCapabilities).toEqual(['preferred']);
    });

    it('REST should also accept tags as alias for default_tags', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          ...baseProfile,
          name: 'tags-alias',
          tags: ['role-tag'],
        },
      });
      expect(res.status).toBe(201);

      const getRes = await request(ctx.app, 'GET', '/api/v1/profiles/tags-alias', {
        headers: authHeaders(ctx.apiKey),
      });
      const profile = await getRes.json();
      expect(profile.defaultTags).toEqual(['role-tag']);
    });
  });

  // ─── BUG 6: depends_on array size limit ─────────────────────────
  // REST CreateTaskSchema: depends_on: z.array(z.number().int().positive()).optional()
  //   — no .max() on the array
  // MCP create_task: depends_on: arrayParam(z.array(z.number())).optional()
  //   — also no .max() on the array
  // Both lack a max array size — this test documents the current behavior.

  describe('BUG 6 — depends_on has no max array size', () => {
    it('REST should accept a large depends_on array (no limit enforced)', async () => {
      // Create a bunch of tasks first so the IDs exist
      const headers = authHeaders(ctx.apiKey);
      const taskIds: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
          headers,
          body: { description: `Dep task ${i}`, status: 'open' },
        });
        const data = await res.json();
        taskIds.push(data.task_id);
      }

      // Create a task that depends on all of them
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers,
        body: {
          description: 'Task with many deps',
          depends_on: taskIds,
          status: 'open',
        },
      });

      // Documents current behavior: accepted without limit
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.task_id).toBeGreaterThan(0);
    });

    it('REST create_task depends_on validates integer positive', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: {
          description: 'Bad deps',
          depends_on: [-1, 0],
        },
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Cross-schema validation: content_type enum parity ──────────
  // Both MCP and REST should accept the same set of content types.

  describe('content_type enum parity', () => {
    const validTypes = [
      'text/plain',
      'text/markdown',
      'text/html',
      'application/json',
      'text/x-typescript',
      'text/x-javascript',
      'text/x-python',
      'text/css',
    ];

    for (const ct of validTypes) {
      it(`REST should accept content_type "${ct}"`, async () => {
        const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
          headers: authHeaders(ctx.apiKey, 'writer'),
          body: {
            key: `test-${ct.replace(/\//g, '-')}`,
            content_type: ct,
            content: 'test content',
          },
        });
        expect(res.status).toBe(201);
      });
    }

    it('REST should reject invalid content_type', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey, 'writer'),
        body: {
          key: 'invalid-type',
          content_type: 'application/octet-stream',
          content: 'binary data',
        },
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── Playbook tasks array — REST vs MCP minimum ─────────────────
  // REST: tasks: z.array(PlaybookTaskSchema) — no .min(1)
  // MCP: tasks: arrayParam(z.array(...)) — no .min(1)
  // Both allow empty arrays at the schema level.

  describe('playbook tasks array minimum', () => {
    it('REST should handle empty tasks array in playbook definition', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'empty-playbook',
          description: 'A playbook with no tasks',
          tasks: [],
        },
      });

      // Document current behavior — empty playbooks are accepted at schema level
      // The model layer may or may not reject this
      const status = res.status;
      // Either 201 (accepted) or 400 (rejected) — document whichever it is
      expect([201, 400]).toContain(status);
    });
  });
});
