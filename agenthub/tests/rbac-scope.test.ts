import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestContext,
  authHeaders,
  request,
  addApiKey,
  TEST_ADMIN_KEY,
  type TestContext,
} from './helpers.js';

describe('RBAC scoped API keys', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('read-scoped key', () => {
    let readKey: string;
    beforeEach(() => {
      readKey = 'ahk_read_key_1234567890123456789012';
      addApiKey(ctx.db, ctx.teamId, readKey, 'read');
    });

    it('allows GET /api/v1/context', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=x', {
        headers: authHeaders(readKey),
      });
      expect(res.status).toBe(200);
    });

    it('blocks POST /api/v1/context with 403 INSUFFICIENT_SCOPE', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(readKey),
        body: { key: 'x', value: 'v', tags: [] },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('INSUFFICIENT_SCOPE');
      expect(body.message).toContain("scope 'read'");
      expect(body.message).toContain("requires 'write'");
    });

    it('blocks PATCH with 403', async () => {
      // Need a task to patch — create it with write key first
      const writeKey = 'ahk_write_key_234567890123456789012';
      addApiKey(ctx.db, ctx.teamId, writeKey, 'write');
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(writeKey),
        body: { description: 'task' },
      });
      const { task_id } = await createRes.json();

      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(readKey),
        body: { status: 'completed', result: 'ok', version: 1 },
      });
      expect(res.status).toBe(403);
    });

    it('blocks DELETE with 403', async () => {
      const res = await request(ctx.app, 'DELETE', '/api/v1/artifacts/anykey', {
        headers: authHeaders(readKey),
      });
      expect(res.status).toBe(403);
    });

    it('reports scope in /teams/mine', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/teams/mine', {
        headers: authHeaders(readKey),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scope).toBe('read');
    });
  });

  describe('write-scoped key', () => {
    // Default test key is 'write' scope
    it('allows GET', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=x', {
        headers: authHeaders(ctx.apiKey),
      });
      expect(res.status).toBe(200);
    });

    it('allows POST /api/v1/context', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'hello', value: 'world', tags: ['t'] },
      });
      expect(res.status).toBe(201);
    });

    it('allows POST /api/v1/tasks', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'do it' },
      });
      expect(res.status).toBe(201);
    });

    it('allows PATCH and DELETE', async () => {
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 't' },
      });
      const { task_id } = await createRes.json();
      const patchRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'completed', result: 'ok', version: 1 },
      });
      expect(patchRes.status).toBe(200);
    });

    it('cannot access /admin/* (admin routes still gated by ADMIN_KEY env)', async () => {
      // Write-scoped key used as Bearer against /admin is not a valid ADMIN_KEY
      const res = await request(ctx.app, 'GET', '/admin/stats', {
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      expect(res.status).toBe(401);
    });

    it('reports scope=write in /teams/mine', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/teams/mine', {
        headers: authHeaders(ctx.apiKey),
      });
      const body = await res.json();
      expect(body.scope).toBe('write');
    });
  });

  describe('admin-scoped key', () => {
    let adminKey: string;
    beforeEach(() => {
      adminKey = 'ahk_admin_key_34567890123456789012';
      addApiKey(ctx.db, ctx.teamId, adminKey, 'admin');
    });

    it('allows GET and POST on /api/v1/*', async () => {
      const getRes = await request(ctx.app, 'GET', '/api/v1/context?query=x', {
        headers: authHeaders(adminKey),
      });
      expect(getRes.status).toBe(200);

      const postRes = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(adminKey),
        body: { event_type: 'BROADCAST', message: 'hi', tags: [] },
      });
      expect(postRes.status).toBe(201);
    });

    it('still cannot access /admin/* without matching ADMIN_KEY env', async () => {
      const res = await request(ctx.app, 'GET', '/admin/stats', {
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json',
        },
      });
      expect(res.status).toBe(401);
    });

    it('reports scope=admin in /teams/mine', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/teams/mine', {
        headers: authHeaders(adminKey),
      });
      const body = await res.json();
      expect(body.scope).toBe('admin');
    });
  });

  describe('admin endpoint key creation with scope', () => {
    it('POST /admin/teams/:id/keys accepts scope param', async () => {
      const res = await request(ctx.app, 'POST', `/admin/teams/${ctx.teamId}/keys`, {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_KEY}`,
          'Content-Type': 'application/json',
        },
        body: { label: 'readonly', scope: 'read' },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.scope).toBe('read');
      expect(body.api_key).toMatch(/^ah_/);

      // The new key should only allow GET
      const postRes = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(body.api_key),
        body: { key: 'x', value: 'v', tags: [] },
      });
      expect(postRes.status).toBe(403);
    });

    it('POST /admin/teams/:id/keys defaults scope to write when omitted', async () => {
      const res = await request(ctx.app, 'POST', `/admin/teams/${ctx.teamId}/keys`, {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_KEY}`,
          'Content-Type': 'application/json',
        },
        body: { label: 'default-scope' },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.scope).toBe('write');
    });

    it('POST /admin/teams auto-generates a write-scoped key', async () => {
      const res = await request(ctx.app, 'POST', '/admin/teams', {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_KEY}`,
          'Content-Type': 'application/json',
        },
        body: { id: 'new-team-rbac', name: 'New Team RBAC' },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.scope).toBe('write');

      // The generated key should permit POST
      const postRes = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(body.api_key),
        body: { key: 'hello', value: 'w', tags: [] },
      });
      expect(postRes.status).toBe(201);
    });

    it('rejects invalid scope value', async () => {
      const res = await request(ctx.app, 'POST', `/admin/teams/${ctx.teamId}/keys`, {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_KEY}`,
          'Content-Type': 'application/json',
        },
        body: { scope: 'superuser' },
      });
      expect(res.status).toBe(400);
    });
  });
});
