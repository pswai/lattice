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

function userIdByEmail(db: Database.Database, email: string): string {
  const row = db
    .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
    .get(email) as { id: string } | undefined;
  if (!row) throw new Error(`no user for ${email}`);
  return row.id;
}

function addMember(
  db: Database.Database,
  teamId: string,
  email: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
): string {
  const uid = userIdByEmail(db, email);
  db.prepare(
    'INSERT INTO team_memberships (user_id, team_id, role) VALUES (?, ?, ?)',
  ).run(uid, teamId, role);
  return uid;
}

describe('/workspaces/:id/members', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db, () => createMcpServer(db), testConfig());
  });

  it('lists members with email and role', async () => {
    const ownerCookie = await signup(app, 'owner@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    await signup(app, 'bob@example.com');
    addMember(db, 'ws', 'bob@example.com', 'member');

    const res = await req(app, 'GET', '/workspaces/ws/members', { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ email: string; role: string }>;
    expect(body).toHaveLength(2);
    const byEmail = Object.fromEntries(body.map((m) => [m.email, m.role]));
    expect(byEmail['owner@example.com']).toBe('owner');
    expect(byEmail['bob@example.com']).toBe('member');
  });

  it('owner promotes member to admin and demotes back', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    await signup(app, 'u@example.com');
    const uid = addMember(db, 'ws', 'u@example.com', 'member');

    const up = await req(app, 'PATCH', `/workspaces/ws/members/${uid}`, {
      cookie: ownerCookie,
      body: { role: 'admin' },
    });
    expect(up.status).toBe(200);
    const upBody = (await up.json()) as { role: string };
    expect(upBody.role).toBe('admin');

    const down = await req(app, 'PATCH', `/workspaces/ws/members/${uid}`, {
      cookie: ownerCookie,
      body: { role: 'member' },
    });
    expect(down.status).toBe(200);
  });

  it('non-owner PATCH returns 403', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    const adminCookie = await signup(app, 'a@example.com');
    const aid = addMember(db, 'ws', 'a@example.com', 'admin');
    await signup(app, 'm@example.com');
    const mid = addMember(db, 'ws', 'm@example.com', 'member');

    const res = await req(app, 'PATCH', `/workspaces/ws/members/${mid}`, {
      cookie: adminCookie,
      body: { role: 'viewer' },
    });
    expect(res.status).toBe(403);
    expect(aid).toBeTruthy();
  });

  it('cannot demote the last owner (409 LAST_OWNER_DEMOTION)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    const oid = userIdByEmail(db, 'o@example.com');
    const res = await req(app, 'PATCH', `/workspaces/ws/members/${oid}`, {
      cookie: ownerCookie,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('LAST_OWNER_DEMOTION');
  });

  it('second owner added then first can demote', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    await signup(app, 'o2@example.com');
    const o2id = addMember(db, 'ws', 'o2@example.com', 'member');
    // Promote o2 to owner
    const promote = await req(app, 'PATCH', `/workspaces/ws/members/${o2id}`, {
      cookie: ownerCookie,
      body: { role: 'owner' },
    });
    expect(promote.status).toBe(200);

    // Now first owner can demote self
    const oid = userIdByEmail(db, 'o@example.com');
    const demote = await req(app, 'PATCH', `/workspaces/ws/members/${oid}`, {
      cookie: ownerCookie,
      body: { role: 'admin' },
    });
    expect(demote.status).toBe(200);
  });

  it('member removes self (204)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    const memberCookie = await signup(app, 'm@example.com');
    const mid = addMember(db, 'ws', 'm@example.com', 'member');

    const res = await req(app, 'DELETE', `/workspaces/ws/members/${mid}`, {
      cookie: memberCookie,
    });
    expect(res.status).toBe(204);
  });

  it('owner removes member (204)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    await signup(app, 'm@example.com');
    const mid = addMember(db, 'ws', 'm@example.com', 'member');

    const res = await req(app, 'DELETE', `/workspaces/ws/members/${mid}`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(204);
  });

  it('owner cannot remove self if last owner (409)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    const oid = userIdByEmail(db, 'o@example.com');
    const res = await req(app, 'DELETE', `/workspaces/ws/members/${oid}`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('LAST_OWNER_REMOVAL');
  });

  it('non-owner cannot remove someone else (403)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    const memberCookie = await signup(app, 'm@example.com');
    addMember(db, 'ws', 'm@example.com', 'member');
    await signup(app, 'v@example.com');
    const vid = addMember(db, 'ws', 'v@example.com', 'viewer');

    const res = await req(app, 'DELETE', `/workspaces/ws/members/${vid}`, {
      cookie: memberCookie,
    });
    expect(res.status).toBe(403);
  });

  it('non-member cannot list members (404)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie: ownerCookie,
      body: { id: 'ws', name: 'WS' },
    });
    const strangerCookie = await signup(app, 'stranger@example.com');
    const res = await req(app, 'GET', '/workspaces/ws/members', { cookie: strangerCookie });
    expect(res.status).toBe(404);
  });
});
