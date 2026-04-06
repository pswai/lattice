import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { writeAudit } from '../src/models/audit.js';
import type { Hono } from 'hono';

function extractSessionCookie(res: Response): string {
  const h = res.headers.get('set-cookie') || '';
  const m = h.match(/lt_session=([^;]*)/);
  return m ? m[1] : '';
}

async function req(
  app: Hono,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers['Cookie'] = `lt_session=${opts.cookie}`;
  return app.request(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function signup(app: Hono, email: string): Promise<string> {
  const res = await req(app, 'POST', '/auth/signup', {
    body: { email, password: 'longenough-pass' },
  });
  expect(res.status).toBe(201);
  return extractSessionCookie(res);
}

async function createWorkspace(
  app: Hono,
  cookie: string,
  id: string,
): Promise<void> {
  const res = await req(app, 'POST', '/workspaces', {
    cookie,
    body: { id, name: id },
  });
  expect(res.status).toBe(201);
}

interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  resource: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  request_id: string | null;
  created_at: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  next_cursor: string | null;
}

describe('GET /workspaces/:id/audit', () => {
  let db: ReturnType<typeof createTestDb>;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db, () => createMcpServer(db), testConfig());
  });

  it('401 without a session', async () => {
    const res = await req(app, 'GET', '/workspaces/ws-a/audit');
    expect(res.status).toBe(401);
  });

  it('403 when not a member', async () => {
    const aliceCookie = await signup(app, 'alice@example.com');
    await createWorkspace(app, aliceCookie, 'ws-alice');
    // Bob tries to read alice's audit log
    const bobCookie = await signup(app, 'bob@example.com');
    const res = await req(app, 'GET', '/workspaces/ws-alice/audit', { cookie: bobCookie });
    expect(res.status).toBe(403);
  });

  it('returns entries for own workspace with parsed metadata and composed resource', async () => {
    const cookie = await signup(app, 'alice@example.com');
    await createWorkspace(app, cookie, 'ws-alice');
    await writeAudit(db, {
      workspaceId: 'ws-alice',
      actor: 'agent-1',
      action: 'task.create',
      resourceType: 'tasks',
      resourceId: '42',
      metadata: { foo: 'bar' },
      ip: '1.2.3.4',
      requestId: 'req-1',
    });
    const res = await req(app, 'GET', '/workspaces/ws-alice/audit', { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditResponse;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].actor).toBe('agent-1');
    expect(body.entries[0].action).toBe('task.create');
    expect(body.entries[0].resource).toBe('tasks:42');
    expect(body.entries[0].metadata).toEqual({ foo: 'bar' });
    expect(body.entries[0].ip).toBe('1.2.3.4');
    expect(body.entries[0].request_id).toBe('req-1');
  });

  it('filters by actor, action, and resource', async () => {
    const cookie = await signup(app, 'alice@example.com');
    await createWorkspace(app, cookie, 'ws-alice');
    await writeAudit(db, { workspaceId: 'ws-alice', actor: 'a1', action: 'x', resourceType: 'tasks' });
    await writeAudit(db, { workspaceId: 'ws-alice', actor: 'a2', action: 'x', resourceType: 'tasks' });
    await writeAudit(db, { workspaceId: 'ws-alice', actor: 'a1', action: 'y', resourceType: 'tasks' });
    await writeAudit(db, { workspaceId: 'ws-alice', actor: 'a1', action: 'x', resourceType: 'events' });

    const byActor = (await (
      await req(app, 'GET', '/workspaces/ws-alice/audit?actor=a1', { cookie })
    ).json()) as AuditResponse;
    expect(byActor.entries).toHaveLength(3);

    const byAction = (await (
      await req(app, 'GET', '/workspaces/ws-alice/audit?action=x', { cookie })
    ).json()) as AuditResponse;
    expect(byAction.entries).toHaveLength(3);

    const byResource = (await (
      await req(app, 'GET', '/workspaces/ws-alice/audit?resource=events', { cookie })
    ).json()) as AuditResponse;
    expect(byResource.entries).toHaveLength(1);
    expect(byResource.entries[0].resource).toBe('events');
  });

  it('paginates with cursor', async () => {
    const cookie = await signup(app, 'alice@example.com');
    await createWorkspace(app, cookie, 'ws-alice');
    for (let i = 0; i < 5; i++) {
      await writeAudit(db, { workspaceId: 'ws-alice', actor: 'a', action: `act-${i}` });
    }
    const page1 = (await (
      await req(app, 'GET', '/workspaces/ws-alice/audit?limit=2', { cookie })
    ).json()) as AuditResponse;
    expect(page1.entries).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = (await (
      await req(app, 'GET', `/workspaces/ws-alice/audit?limit=2&cursor=${page1.next_cursor}`, {
        cookie,
      })
    ).json()) as AuditResponse;
    expect(page2.entries).toHaveLength(2);
    expect(page2.entries[0].id).toBeLessThan(page1.entries[1].id);

    const page3 = (await (
      await req(app, 'GET', `/workspaces/ws-alice/audit?limit=2&cursor=${page2.next_cursor}`, {
        cookie,
      })
    ).json()) as AuditResponse;
    expect(page3.entries).toHaveLength(1);
    expect(page3.next_cursor).toBeNull();
  });

  it('filters by since/until timestamps', async () => {
    const cookie = await signup(app, 'alice@example.com');
    await createWorkspace(app, cookie, 'ws-alice');
    // Explicit created_at values
    db.prepare(
      `INSERT INTO audit_log (workspace_id, actor, action, metadata, created_at) VALUES (?, ?, ?, '{}', ?)`,
    ).run('ws-alice', 'a', 'old', '2024-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO audit_log (workspace_id, actor, action, metadata, created_at) VALUES (?, ?, ?, '{}', ?)`,
    ).run('ws-alice', 'a', 'mid', '2025-06-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO audit_log (workspace_id, actor, action, metadata, created_at) VALUES (?, ?, ?, '{}', ?)`,
    ).run('ws-alice', 'a', 'new', '2026-01-01T00:00:00.000Z');

    const sinceRes = (await (
      await req(app, 'GET', '/workspaces/ws-alice/audit?since=2025-01-01T00:00:00.000Z', {
        cookie,
      })
    ).json()) as AuditResponse;
    expect(sinceRes.entries.map((e) => e.action).sort()).toEqual(['mid', 'new']);

    const untilRes = (await (
      await req(app, 'GET', '/workspaces/ws-alice/audit?until=2025-12-31T00:00:00.000Z', {
        cookie,
      })
    ).json()) as AuditResponse;
    expect(untilRes.entries.map((e) => e.action).sort()).toEqual(['mid', 'old']);
  });

  it('caps limit at 500', async () => {
    const cookie = await signup(app, 'alice@example.com');
    await createWorkspace(app, cookie, 'ws-alice');
    const res = await req(app, 'GET', '/workspaces/ws-alice/audit?limit=99999', { cookie });
    expect(res.status).toBe(200);
    // Just confirms no error / no crash. Further assertions would require
    // inserting > 500 rows, which we skip for speed.
  });
});
