import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';

function extractSessionCookie(res: Response): string {
  const h = res.headers.get('set-cookie') || '';
  const m = h.match(/ah_session=([^;]*)/);
  return m ? m[1] : '';
}

async function req(
  app: Hono,
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers['Cookie'] = `ah_session=${opts.cookie}`;
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

describe('PATCH /workspaces/:id', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db, () => createMcpServer(db), testConfig());
  });

  it('owner renames (200)', async () => {
    const cookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie,
      body: { id: 'ws', name: 'Old' },
    });
    const res = await req(app, 'PATCH', '/workspaces/ws', {
      cookie,
      body: { name: 'New Name' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { team_id: string; name: string };
    expect(body).toEqual({ team_id: 'ws', name: 'New Name' });
    const row = db.prepare('SELECT name FROM teams WHERE id = ?').get('ws') as { name: string };
    expect(row.name).toBe('New Name');
  });

  it('admin renames (200)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'Old' },
    });
    const adminCookie = await signup(app, 'a@example.com');
    db.prepare(
      "INSERT INTO team_memberships (user_id, team_id, role) SELECT id, 'ws', 'admin' FROM users WHERE email = 'a@example.com'",
    ).run();
    const res = await req(app, 'PATCH', '/workspaces/ws', {
      cookie: adminCookie,
      body: { name: 'Admin Renamed' },
    });
    expect(res.status).toBe(200);
  });

  it('member cannot rename (403)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'Old' },
    });
    const memberCookie = await signup(app, 'm@example.com');
    db.prepare(
      "INSERT INTO team_memberships (user_id, team_id, role) SELECT id, 'ws', 'member' FROM users WHERE email = 'm@example.com'",
    ).run();
    const res = await req(app, 'PATCH', '/workspaces/ws', {
      cookie: memberCookie,
      body: { name: 'Nope' },
    });
    expect(res.status).toBe(403);
  });

  it('404 on non-existent workspace', async () => {
    const cookie = await signup(app, 'o@example.com');
    const res = await req(app, 'PATCH', '/workspaces/nothere', {
      cookie,
      body: { name: 'Nope' },
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid name', async () => {
    const cookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie,
      body: { id: 'ws', name: 'Old' },
    });
    const res = await req(app, 'PATCH', '/workspaces/ws', {
      cookie,
      body: { name: '' },
    });
    expect(res.status).toBe(400);
  });
});
