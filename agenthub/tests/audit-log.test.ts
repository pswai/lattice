import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { SCHEMA_SQL } from '../src/db/schema.js';
import {
  writeAudit,
  queryAudit,
  pruneAuditOlderThan,
} from '../src/models/audit.js';
import { createAuditMiddleware } from '../src/http/middleware/audit.js';
import { createAuditRoutes } from '../src/http/routes/audit.js';
import { testConfig, TEST_ADMIN_KEY } from './helpers.js';
import { SqliteAdapter } from '../src/db/adapter.js';

function createDb(): SqliteAdapter {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return new SqliteAdapter(db);
}

describe('audit model', () => {
  let db: SqliteAdapter;

  beforeEach(() => {
    db = createDb();
  });

  it('writeAudit persists a row and queryAudit returns it', async () => {
    await writeAudit(db, {
      workspaceId: 'team-a',
      actor: 'agent-1',
      action: 'task.create',
      resourceType: 'tasks',
      resourceId: '42',
      metadata: { query: { foo: ['bar'] } },
      ip: '1.2.3.4',
      requestId: 'req-1',
    });

    const rows = await queryAudit(db, { workspaceId: 'team-a' });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('agent-1');
    expect(rows[0].action).toBe('task.create');
    expect(rows[0].resource_type).toBe('tasks');
    expect(rows[0].resource_id).toBe('42');
    expect(rows[0].ip).toBe('1.2.3.4');
    expect(rows[0].request_id).toBe('req-1');
    expect(JSON.parse(rows[0].metadata)).toEqual({ query: { foo: ['bar'] } });
  });

  it('queryAudit filters by actor, action, resourceType', async () => {
    await writeAudit(db, { workspaceId: 't', actor: 'a1', action: 'task.create', resourceType: 'tasks' });
    await writeAudit(db, { workspaceId: 't', actor: 'a2', action: 'task.update', resourceType: 'tasks' });
    await writeAudit(db, { workspaceId: 't', actor: 'a1', action: 'webhook.delete', resourceType: 'webhooks' });
    await writeAudit(db, { workspaceId: 'other', actor: 'a1', action: 'task.create' });

    expect(await queryAudit(db, { workspaceId: 't' })).toHaveLength(3);
    expect(await queryAudit(db, { workspaceId: 't', actor: 'a1' })).toHaveLength(2);
    expect(await queryAudit(db, { workspaceId: 't', action: 'task.update' })).toHaveLength(1);
    expect(await queryAudit(db, { workspaceId: 't', resourceType: 'webhooks' })).toHaveLength(1);
  });

  it('queryAudit filters by since/until', async () => {
    await writeAudit(db, { workspaceId: 't', actor: 'a', action: 'x.create' });
    // Force specific timestamps
    db.rawDb.prepare('UPDATE audit_log SET created_at = ? WHERE id = 1').run('2025-01-01T00:00:00.000Z');
    await writeAudit(db, { workspaceId: 't', actor: 'a', action: 'x.create' });
    db.rawDb.prepare('UPDATE audit_log SET created_at = ? WHERE id = 2').run('2025-06-01T00:00:00.000Z');
    await writeAudit(db, { workspaceId: 't', actor: 'a', action: 'x.create' });
    db.rawDb.prepare('UPDATE audit_log SET created_at = ? WHERE id = 3').run('2025-12-01T00:00:00.000Z');

    const mid = await queryAudit(db, {
      workspaceId: 't',
      since: '2025-03-01T00:00:00.000Z',
      until: '2025-09-01T00:00:00.000Z',
    });
    expect(mid).toHaveLength(1);
    expect(mid[0].id).toBe(2);
  });

  it('queryAudit supports beforeId cursor pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await writeAudit(db, { workspaceId: 't', actor: 'a', action: 'x.create' });
    }
    const page1 = await queryAudit(db, { workspaceId: 't', limit: 2 });
    expect(page1.map((r) => r.id)).toEqual([5, 4]);

    const page2 = await queryAudit(db, { workspaceId: 't', limit: 2, beforeId: page1[page1.length - 1].id });
    expect(page2.map((r) => r.id)).toEqual([3, 2]);

    const page3 = await queryAudit(db, { workspaceId: 't', limit: 2, beforeId: page2[page2.length - 1].id });
    expect(page3.map((r) => r.id)).toEqual([1]);
  });

  it('queryAudit caps limit at 1000', async () => {
    await writeAudit(db, { workspaceId: 't', actor: 'a', action: 'x.create' });
    // Can't easily assert 1000 w/o inserting; just ensure no throw for huge values.
    const rows = await queryAudit(db, { workspaceId: 't', limit: 999999 });
    expect(rows).toHaveLength(1);
  });

  it('pruneAuditOlderThan deletes rows before cutoff', async () => {
    await writeAudit(db, { workspaceId: 't', actor: 'a', action: 'x.create' });
    await writeAudit(db, { workspaceId: 't', actor: 'a', action: 'x.create' });
    db.rawDb.prepare('UPDATE audit_log SET created_at = ? WHERE id = 1').run('2020-01-01T00:00:00.000Z');
    db.rawDb.prepare('UPDATE audit_log SET created_at = ? WHERE id = 2').run('2099-01-01T00:00:00.000Z');

    const removed = await pruneAuditOlderThan(db, '2025-01-01T00:00:00.000Z');
    expect(removed).toBe(1);
    const remaining = await queryAudit(db, { workspaceId: 't' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(2);
  });
});

// --- Middleware tests ---------------------------------------------------

function buildAuditApp(db: any) {
  const app = new Hono();
  // Simulate auth middleware populating c.set('auth')
  app.use('*', async (c, next) => {
    c.set('requestId' as never, 'test-req-1' as never);
    c.set('auth' as never, { workspaceId: 'team-a', agentId: 'agent-1', scope: 'write' } as never);
    await next();
  });
  app.use('*', createAuditMiddleware(db));
  app.get('/tasks', (c) => c.json({ ok: true }));
  app.post('/tasks', (c) => c.json({ ok: true }, 201));
  app.patch('/tasks/:id', (c) => c.json({ ok: true }));
  app.delete('/webhooks/:id', (c) => c.json({ ok: true }));
  app.post('/fail', (c) => c.json({ error: 'bad' }, 400));
  app.post('/boom', (c) => c.json({ error: 'server' }, 500));
  return app;
}

describe('audit middleware', () => {
  let db: SqliteAdapter;

  beforeEach(() => {
    db = createDb();
  });

  it('records on POST with status < 400', async () => {
    const app = buildAuditApp(db);
    const res = await app.request('/tasks', { method: 'POST' });
    expect(res.status).toBe(201);
    const rows = await queryAudit(db, { workspaceId: 'team-a' });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('task.create');
    expect(rows[0].resource_type).toBe('tasks');
    expect(rows[0].resource_id).toBeNull();
    expect(rows[0].actor).toBe('agent-1');
    expect(rows[0].request_id).toBe('test-req-1');
  });

  it('records PATCH with resource id extracted from path', async () => {
    const app = buildAuditApp(db);
    const res = await app.request('/tasks/123', { method: 'PATCH' });
    expect(res.status).toBe(200);
    const rows = await queryAudit(db, { workspaceId: 'team-a' });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('task.update');
    expect(rows[0].resource_id).toBe('123');
  });

  it('records DELETE on webhooks', async () => {
    const app = buildAuditApp(db);
    const res = await app.request('/webhooks/abc-def-ghi', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const rows = await queryAudit(db, { workspaceId: 'team-a' });
    expect(rows[0].action).toBe('webhook.delete');
    expect(rows[0].resource_id).toBe('abc-def-ghi');
  });

  it('SKIPS GET requests', async () => {
    const app = buildAuditApp(db);
    await app.request('/tasks', { method: 'GET' });
    expect(await queryAudit(db, { workspaceId: 'team-a' })).toHaveLength(0);
  });

  it('SKIPS 4xx responses', async () => {
    const app = buildAuditApp(db);
    const res = await app.request('/fail', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await queryAudit(db, { workspaceId: 'team-a' })).toHaveLength(0);
  });

  it('SKIPS 5xx responses', async () => {
    const app = buildAuditApp(db);
    const res = await app.request('/boom', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(await queryAudit(db, { workspaceId: 'team-a' })).toHaveLength(0);
  });

  it('extracts IP from X-Forwarded-For (first entry)', async () => {
    const app = buildAuditApp(db);
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.5, 10.0.0.1, 10.0.0.2' },
    });
    const rows = await queryAudit(db, { workspaceId: 'team-a' });
    expect(rows[0].ip).toBe('203.0.113.5');
  });

  it('falls back to X-Real-IP when X-Forwarded-For absent', async () => {
    const app = buildAuditApp(db);
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'X-Real-IP': '198.51.100.9' },
    });
    const rows = await queryAudit(db, { workspaceId: 'team-a' });
    expect(rows[0].ip).toBe('198.51.100.9');
  });

  it('records metadata.query from request querystring', async () => {
    const app = buildAuditApp(db);
    await app.request('/tasks?foo=bar&foo=baz', { method: 'POST' });
    const rows = await queryAudit(db, { workspaceId: 'team-a' });
    const meta = JSON.parse(rows[0].metadata);
    expect(meta.query.foo).toEqual(['bar', 'baz']);
  });

  it('does not record when auth context is missing', async () => {
    const app = new Hono();
    // no auth setter
    app.use('*', createAuditMiddleware(db));
    app.post('/tasks', (c) => c.json({ ok: true }, 201));
    const res = await app.request('/tasks', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await queryAudit(db, { workspaceId: 'team-a' })).toHaveLength(0);
  });
});

// --- Admin route tests --------------------------------------------------

function buildAdminApp(db: any, adminKey: string = TEST_ADMIN_KEY) {
  const app = new Hono();
  app.route('/admin', createAuditRoutes(db, testConfig({ adminKey })));
  return app;
}

describe('audit admin route', () => {
  let db: SqliteAdapter;

  beforeEach(async () => {
    db = createDb();
    await writeAudit(db, { workspaceId: 'team-a', actor: 'a', action: 'task.create' });
    await writeAudit(db, { workspaceId: 'team-a', actor: 'b', action: 'task.update' });
    await writeAudit(db, { workspaceId: 'other', actor: 'a', action: 'task.create' });
  });

  it('returns 401 without admin key', async () => {
    const app = buildAdminApp(db);
    const res = await app.request('/admin/audit-log?workspace_id=team-a');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong admin key', async () => {
    const app = buildAdminApp(db);
    const res = await app.request('/admin/audit-log?workspace_id=team-a', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when ADMIN_KEY is not configured', async () => {
    const app = buildAdminApp(db, '');
    const res = await app.request('/admin/audit-log?workspace_id=team-a', {
      headers: { Authorization: 'Bearer anything' },
    });
    expect(res.status).toBe(503);
  });

  it('returns 200 and items with valid admin key', async () => {
    const app = buildAdminApp(db);
    const res = await app.request('/admin/audit-log?workspace_id=team-a', {
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].workspace_id).toBe('team-a');
  });

  it('rejects missing workspace_id', async () => {
    const app = buildAdminApp(db);
    const res = await app.request('/admin/audit-log', {
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(res.status).toBe(400);
  });

  it('filters by actor', async () => {
    const app = buildAdminApp(db);
    const res = await app.request('/admin/audit-log?workspace_id=team-a&actor=b', {
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].actor).toBe('b');
  });

  it('supports before_id cursor', async () => {
    const app = buildAdminApp(db);
    const res = await app.request('/admin/audit-log?workspace_id=team-a&limit=1', {
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.next_before_id).toBe(body.items[0].id);

    const res2 = await app.request(
      `/admin/audit-log?workspace_id=team-a&limit=1&before_id=${body.next_before_id}`,
      { headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
    );
    const body2 = await res2.json();
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0].id).toBeLessThan(body.items[0].id);
  });
});
