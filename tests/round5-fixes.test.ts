/**
 * Tests for: scheduler lifecycle and MCP read tool protocol coverage
 * - Service lifecycle: startScheduler returns clearable timer handle
 * - MCP read tool direct tests (get_context, list_tasks, get_task, list_agents, get_messages, get_updates)
 * - MCP list_tasks status filtering
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, authHeaders, request, testConfig, type TestContext } from './helpers.js';
import { createTask } from '../src/models/task.js';
import { definePlaybook } from '../src/models/playbook.js';
import { defineProfile } from '../src/models/profile.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';

// ─── H1: Model-layer secret scanning ───────────────────────────────────

describe('H1 — Model-layer secret scanning (protects both REST and model)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('createTask — model layer', () => {
    it('should reject task with secret in description at model layer', async () => {
      await expect(
        createTask(ctx.db, ctx.workspaceId, 'agent', {
          description: 'Deploy with AKIAIOSFODNN7EXAMPLE',
          status: 'open',
        }),
      ).rejects.toThrow(/secret/i);
    });

    it('should allow clean descriptions at model layer', async () => {
      const result = await createTask(ctx.db, ctx.workspaceId, 'agent', {
        description: 'Normal deployment task',
        status: 'open',
      });
      expect(result.task_id).toBeGreaterThan(0);
    });
  });

  describe('createTask — REST route', () => {
    it('should reject task with secret via REST POST /tasks', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Use key AKIAIOSFODNN7EXAMPLE' },
      });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('SECRET_DETECTED');
    });
  });

  describe('definePlaybook — model layer', () => {
    it('should reject playbook with secret in task description at model layer', async () => {
      await expect(
        definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-pb',
          description: 'Test',
          tasks: [{ description: 'Use sk_live_1234567890abcdefghijklmn' }],
        }),
      ).rejects.toThrow(/secret/i);
    });

    it('should reject playbook with secret in description at model layer', async () => {
      await expect(
        definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-pb-desc',
          description: 'Deploy with AKIAIOSFODNN7EXAMPLE',
          tasks: [{ description: 'Clean step' }],
        }),
      ).rejects.toThrow(/secret/i);
    });
  });

  describe('definePlaybook — REST route', () => {
    it('should reject playbook with secret via REST', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'rest-bad-pb',
          description: 'safe',
          tasks: [{ description: 'Deploy with AKIAIOSFODNN7EXAMPLE' }],
        },
      });
      expect(res.status).toBe(422);
    });
  });

  describe('defineProfile — model layer', () => {
    it('should reject profile with secret in system_prompt at model layer', async () => {
      await expect(
        defineProfile(ctx.db, ctx.workspaceId, 'agent', {
          name: 'bad-prof',
          description: 'Test profile',
          system_prompt: 'Use api_key=SuperSecretKey12345678 for everything',
        }),
      ).rejects.toThrow(/secret/i);
    });
  });

  describe('defineProfile — REST route', () => {
    it('should reject profile with secret via REST', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'rest-bad-prof',
          description: 'safe',
          system_prompt: 'Use AKIAIOSFODNN7EXAMPLE to auth',
        },
      });
      expect(res.status).toBe(422);
    });
  });
});

// ─── H2: Body limit stream validation ───────────────────────────────────

describe('H2 — Body limit stream validation', () => {
  it('should reject requests exceeding body limit via Content-Length', async () => {
    const config = testConfig({ maxBodyBytes: 1024 });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const bigBody = JSON.stringify({ key: 'x', value: 'a'.repeat(2000), tags: [] });
    const res = await request(app, 'POST', '/api/v1/context', {
      headers: {
        ...authHeaders('ltk_test_key_12345678901234567890'),
        'Content-Length': String(Buffer.byteLength(bigBody)),
      },
      body: JSON.parse(bigBody),
    });
    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('should allow requests within body limit', async () => {
    const config = testConfig({ maxBodyBytes: 10_000 });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const res = await request(app, 'POST', '/api/v1/context', {
      headers: authHeaders('ltk_test_key_12345678901234567890'),
      body: { key: 'small', value: 'hello', tags: [] },
    });
    expect(res.status).toBe(201);
  });

  it('should skip limit check for GET requests', async () => {
    const config = testConfig({ maxBodyBytes: 1 }); // 1 byte limit
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const res = await request(app, 'GET', '/api/v1/context?query=test', {
      headers: authHeaders('ltk_test_key_12345678901234567890'),
    });
    expect(res.status).toBe(200);
  });

  it('should pass through when maxBytes is 0 (disabled)', async () => {
    const config = testConfig({ maxBodyBytes: 0 });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const res = await request(app, 'POST', '/api/v1/context', {
      headers: authHeaders('ltk_test_key_12345678901234567890'),
      body: { key: 'any-size', value: 'a'.repeat(5000), tags: [] },
    });
    expect(res.status).toBe(201);
  });
});

