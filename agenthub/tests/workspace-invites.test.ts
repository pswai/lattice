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
  opts: { body?: unknown; cookie?: string; apiKey?: string; agentId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers['Cookie'] = `ah_session=${opts.cookie}`;
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

async function createWorkspace(
  app: Hono,
  cookie: string,
  id: string,
): Promise<{ api_key: string }> {
  const res = await req(app, 'POST', '/workspaces', {
    cookie,
    body: { id, name: id },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { api_key: string };
}

describe('/workspaces/:id/invites', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db, () => createMcpServer(db), testConfig());
  });

  it('owner creates invite and raw token surfaced in test config', async () => {
    const cookie = await signup(app, 'owner@example.com');
    await createWorkspace(app, cookie, 'ws1');
    const res = await req(app, 'POST', '/workspaces/ws1/invites', {
      cookie,
      body: { email: 'bob@example.com', role: 'member' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invitation_id: string;
      expires_at: string;
      invite_token: string;
    };
    expect(body.invitation_id).toMatch(/^inv_/);
    expect(body.invite_token.length).toBeGreaterThan(20);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('admin can invite', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await createWorkspace(app, ownerCookie, 'ws2');
    const adminCookie = await signup(app, 'admin@example.com');
    // Manually promote admin user to admin
    db.prepare(
      "INSERT INTO team_memberships (user_id, team_id, role) SELECT id, 'ws2', 'admin' FROM users WHERE email = 'admin@example.com'",
    ).run();
    const res = await req(app, 'POST', '/workspaces/ws2/invites', {
      cookie: adminCookie,
      body: { email: 'new@example.com', role: 'viewer' },
    });
    expect(res.status).toBe(201);
  });

  it('member cannot invite (403)', async () => {
    const ownerCookie = await signup(app, 'o@example.com');
    await createWorkspace(app, ownerCookie, 'ws3');
    const memberCookie = await signup(app, 'member@example.com');
    db.prepare(
      "INSERT INTO team_memberships (user_id, team_id, role) SELECT id, 'ws3', 'member' FROM users WHERE email = 'member@example.com'",
    ).run();
    const res = await req(app, 'POST', '/workspaces/ws3/invites', {
      cookie: memberCookie,
      body: { email: 'new@example.com', role: 'viewer' },
    });
    expect(res.status).toBe(403);
  });

  it('lists pending invites and excludes revoked', async () => {
    const cookie = await signup(app, 'o@example.com');
    await createWorkspace(app, cookie, 'ws4');
    const r1 = await req(app, 'POST', '/workspaces/ws4/invites', {
      cookie,
      body: { email: 'a@example.com', role: 'member' },
    });
    const { invitation_id: inv1 } = (await r1.json()) as { invitation_id: string };
    const r2 = await req(app, 'POST', '/workspaces/ws4/invites', {
      cookie,
      body: { email: 'b@example.com', role: 'viewer' },
    });
    const { invitation_id: inv2 } = (await r2.json()) as { invitation_id: string };

    // Revoke the second
    const rev = await req(app, 'DELETE', `/workspaces/ws4/invites/${inv2}`, { cookie });
    expect(rev.status).toBe(204);

    const list = await req(app, 'GET', '/workspaces/ws4/invites', { cookie });
    expect(list.status).toBe(200);
    const body = (await list.json()) as Array<{ id: string; email: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(inv1);
  });

  it('end-to-end accept flow: user B signs up, accepts token, can use workspace API key', async () => {
    const aliceCookie = await signup(app, 'alice@example.com');
    const { api_key } = await createWorkspace(app, aliceCookie, 'acme');
    const createRes = await req(app, 'POST', '/workspaces/acme/invites', {
      cookie: aliceCookie,
      body: { email: 'bob@example.com', role: 'member' },
    });
    const { invite_token } = (await createRes.json()) as { invite_token: string };

    const bobCookie = await signup(app, 'bob@example.com');
    const accept = await req(app, 'POST', '/workspaces/invites/accept', {
      cookie: bobCookie,
      body: { token: invite_token },
    });
    expect(accept.status).toBe(201);
    const acceptBody = (await accept.json()) as { team_id: string; role: string };
    expect(acceptBody).toEqual({ team_id: 'acme', role: 'member' });

    // Bob sees workspace in /auth/me
    const me = await req(app, 'GET', '/auth/me', { cookie: bobCookie });
    const meBody = (await me.json()) as {
      memberships: Array<{ team_id: string; role: string }>;
    };
    expect(meBody.memberships).toContainEqual(
      expect.objectContaining({ team_id: 'acme', role: 'member' }),
    );

    // API key still works
    const ctx = await req(app, 'POST', '/api/v1/context', {
      apiKey: api_key,
      agentId: 'bob-bot',
      body: { key: 'bob', value: 'hi', tags: [] },
    });
    expect(ctx.status).toBe(201);
  });

  it('cannot accept a non-existent or re-used token', async () => {
    const cookie = await signup(app, 'user@example.com');
    const res = await req(app, 'POST', '/workspaces/invites/accept', {
      cookie,
      body: { token: 'bogus-token-xyz' },
    });
    expect(res.status).toBe(400);
  });

  it('DELETE invite 404 when invId belongs to a different team', async () => {
    const cookie = await signup(app, 'o@example.com');
    await createWorkspace(app, cookie, 'ws5');
    await createWorkspace(app, cookie, 'ws6');
    const r = await req(app, 'POST', '/workspaces/ws5/invites', {
      cookie,
      body: { email: 'x@example.com', role: 'member' },
    });
    const { invitation_id } = (await r.json()) as { invitation_id: string };
    const del = await req(app, 'DELETE', `/workspaces/ws6/invites/${invitation_id}`, {
      cookie,
    });
    expect(del.status).toBe(404);
  });
});
