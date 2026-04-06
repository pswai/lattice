import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';

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

async function login(app: Hono, email: string): Promise<string> {
  const res = await req(app, 'POST', '/auth/login', {
    body: { email, password: 'longenough-pass' },
  });
  expect(res.status).toBe(200);
  return extractSessionCookie(res);
}

describe('/auth/sessions', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db, () => createMcpServer(db), testConfig());
  });

  it('lists sessions with current flag', async () => {
    const c1 = await signup(app, 'a@example.com');
    const res = await req(app, 'GET', '/auth/sessions', { cookie: c1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; current: boolean }>;
    expect(body).toHaveLength(1);
    expect(body[0].current).toBe(true);
  });

  it('creating a second session shows two with current=true on one', async () => {
    const c1 = await signup(app, 'a@example.com');
    const c2 = await login(app, 'a@example.com');
    expect(c1).not.toBe(c2);

    const res = await req(app, 'GET', '/auth/sessions', { cookie: c2 });
    const body = (await res.json()) as Array<{ id: string; current: boolean }>;
    expect(body).toHaveLength(2);
    const currentCount = body.filter((s) => s.current).length;
    expect(currentCount).toBe(1);
  });

  it('deletes a specific session by id', async () => {
    const c1 = await signup(app, 'a@example.com');
    const c2 = await login(app, 'a@example.com');
    const list = await req(app, 'GET', '/auth/sessions', { cookie: c2 });
    const body = (await list.json()) as Array<{ id: string; current: boolean }>;
    const other = body.find((s) => !s.current)!;
    const del = await req(app, 'DELETE', `/auth/sessions/${other.id}`, { cookie: c2 });
    expect(del.status).toBe(204);
    // c1 no longer valid
    const me = await req(app, 'GET', '/auth/me', { cookie: c1 });
    expect(me.status).toBe(401);
  });

  it('delete-all revokes others but not current', async () => {
    const c1 = await signup(app, 'a@example.com');
    const c2 = await login(app, 'a@example.com');
    const c3 = await login(app, 'a@example.com');
    const res = await req(app, 'DELETE', '/auth/sessions', { cookie: c3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: number };
    expect(body.revoked).toBe(2);
    // c3 still valid
    const me = await req(app, 'GET', '/auth/me', { cookie: c3 });
    expect(me.status).toBe(200);
    // c1, c2 invalid
    expect((await req(app, 'GET', '/auth/me', { cookie: c1 })).status).toBe(401);
    expect((await req(app, 'GET', '/auth/me', { cookie: c2 })).status).toBe(401);
  });

  it('cannot revoke another user\'s session (404)', async () => {
    const aliceCookie = await signup(app, 'alice@example.com');
    const bobCookie = await signup(app, 'bob@example.com');
    const list = await req(app, 'GET', '/auth/sessions', { cookie: bobCookie });
    const body = (await list.json()) as Array<{ id: string }>;
    const bobSessionId = body[0].id;
    const del = await req(app, 'DELETE', `/auth/sessions/${bobSessionId}`, {
      cookie: aliceCookie,
    });
    expect(del.status).toBe(404);
    // Bob's session still works
    const me = await req(app, 'GET', '/auth/me', { cookie: bobCookie });
    expect(me.status).toBe(200);
  });
});
