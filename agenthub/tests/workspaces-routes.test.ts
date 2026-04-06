import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import type Database from 'better-sqlite3';
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
  opts: { body?: unknown; cookie?: string; apiKey?: string; agentId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers['Cookie'] = `lt_session=${opts.cookie}`;
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;
  if (opts.agentId) headers['X-Agent-ID'] = opts.agentId;
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

describe('/workspaces routes', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db, () => createMcpServer(db), testConfig());
  });

  it('full self-serve SaaS loop: signup → create workspace → use API key → list → delete', async () => {
    const cookie = await signup(app, 'alice@example.com');

    // Create workspace
    const create = await req(app, 'POST', '/workspaces', {
      cookie,
      body: { id: 'acme-corp', name: 'Acme Corp' },
    });
    expect(create.status).toBe(201);
    const { workspace_id, api_key, scope, role } = (await create.json()) as {
      workspace_id: string;
      api_key: string;
      scope: string;
      role: string;
    };
    expect(workspace_id).toBe('acme-corp');
    expect(api_key).toMatch(/^lt_[a-f0-9]{48}$/);
    expect(scope).toBe('write');
    expect(role).toBe('owner');

    // API key actually works against the regular API
    const ctxPost = await req(app, 'POST', '/api/v1/context', {
      apiKey: api_key,
      agentId: 'alice-bot',
      body: { key: 'greeting', value: 'hello from saas', tags: [] },
    });
    expect(ctxPost.status).toBe(201);

    const ctxGet = await req(app, 'GET', '/api/v1/context?query=greeting', {
      apiKey: api_key,
      agentId: 'alice-bot',
    });
    expect(ctxGet.status).toBe(200);

    // List workspaces
    const list = await req(app, 'GET', '/workspaces', { cookie });
    expect(list.status).toBe(200);
    const { workspaces } = (await list.json()) as {
      workspaces: Array<{ workspace_id: string; name: string; role: string }>;
    };
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].workspace_id).toBe('acme-corp');
    expect(workspaces[0].role).toBe('owner');

    // Delete workspace cascades
    const del = await req(app, 'DELETE', '/workspaces/acme-corp', { cookie });
    expect(del.status).toBe(204);

    expect(
      (db.prepare('SELECT COUNT(*) as c FROM workspaces WHERE id = ?').get('acme-corp') as { c: number })
        .c,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) as c FROM api_keys WHERE workspace_id = ?').get('acme-corp') as {
        c: number;
      }).c,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) as c FROM workspace_memberships WHERE workspace_id = ?').get('acme-corp') as {
        c: number;
      }).c,
    ).toBe(0);

    // Stale API key is now unauthorized
    const stale = await req(app, 'GET', '/api/v1/context?query=greeting', {
      apiKey: api_key,
      agentId: 'alice-bot',
    });
    expect(stale.status).toBe(401);
  });

  it('requires a session for all workspace routes', async () => {
    const c1 = await req(app, 'POST', '/workspaces', { body: { id: 'x', name: 'X' } });
    expect(c1.status).toBe(401);
    const c2 = await req(app, 'GET', '/workspaces');
    expect(c2.status).toBe(401);
    const c3 = await req(app, 'DELETE', '/workspaces/x');
    expect(c3.status).toBe(401);
  });

  it('validates slug and name', async () => {
    const cookie = await signup(app, 'bob@example.com');
    const badSlug = await req(app, 'POST', '/workspaces', {
      cookie,
      body: { id: 'Has Spaces', name: 'Nope' },
    });
    expect(badSlug.status).toBe(400);
    const badName = await req(app, 'POST', '/workspaces', {
      cookie,
      body: { id: 'ok-slug', name: '' },
    });
    expect(badName.status).toBe(400);
  });

  it('rejects duplicate workspace IDs', async () => {
    const cookie = await signup(app, 'carol@example.com');
    const first = await req(app, 'POST', '/workspaces', {
      cookie,
      body: { id: 'shared', name: 'First' },
    });
    expect(first.status).toBe(201);
    const dup = await req(app, 'POST', '/workspaces', {
      cookie,
      body: { id: 'shared', name: 'Second' },
    });
    expect(dup.status).toBe(400);
  });

  it('non-owner cannot delete workspace', async () => {
    const aliceCookie = await signup(app, 'alice2@example.com');
    const create = await req(app, 'POST', '/workspaces', {
      cookie: aliceCookie,
      body: { id: 'private', name: 'Private' },
    });
    expect(create.status).toBe(201);

    // Dave has a session but no membership
    const daveCookie = await signup(app, 'dave2@example.com');
    const del = await req(app, 'DELETE', '/workspaces/private', { cookie: daveCookie });
    expect(del.status).toBe(404);

    // Add dave as a member (non-owner) and try again
    db.prepare(
      "INSERT INTO workspace_memberships (user_id, workspace_id, role) SELECT id, 'private', 'member' FROM users WHERE email = 'dave2@example.com'",
    ).run();
    const del2 = await req(app, 'DELETE', '/workspaces/private', { cookie: daveCookie });
    expect(del2.status).toBe(403);
  });

  it('/me reflects memberships after workspace create', async () => {
    const cookie = await signup(app, 'eve@example.com');
    await req(app, 'POST', '/workspaces', {
      cookie,
      body: { id: 'eve-ws', name: "Eve's WS" },
    });
    const me = await req(app, 'GET', '/auth/me', { cookie });
    const body = (await me.json()) as {
      memberships: Array<{ workspace_id: string; role: string }>;
    };
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].workspace_id).toBe('eve-ws');
    expect(body.memberships[0].role).toBe('owner');
  });
});
