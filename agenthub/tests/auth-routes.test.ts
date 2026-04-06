import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

function extractSetCookie(res: Response): string {
  const h = res.headers.get('set-cookie');
  return h || '';
}

function extractSessionCookie(res: Response): string {
  const sc = extractSetCookie(res);
  const m = sc.match(/lt_session=([^;]*)/);
  return m ? m[1] : '';
}

async function jsonRequest(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = `lt_session=${cookie}`;
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('/auth/* routes', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    app = createApp(db, () => createMcpServer(db), testConfig());
  });

  it('signup → /me → logout flow', async () => {
    const signup = await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'Alice@Example.com',
      password: 'longenough-pass',
      name: 'Alice',
    });
    expect(signup.status).toBe(201);
    const body = (await signup.json()) as {
      user: { id: string; email: string; name: string };
      email_verification_token?: string;
    };
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.name).toBe('Alice');
    expect(body.email_verification_token).toBeTruthy();

    const cookie = extractSessionCookie(signup);
    expect(cookie.length).toBeGreaterThan(10);
    const sc = extractSetCookie(signup);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain('Path=/');
    expect(sc).not.toContain('Secure'); // testConfig has cookieSecure=false

    const me = await jsonRequest(app, 'GET', '/auth/me', undefined, cookie);
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { email: string }; memberships: unknown[] };
    expect(meBody.user.email).toBe('alice@example.com');
    expect(meBody.memberships).toEqual([]);

    const logout = await jsonRequest(app, 'POST', '/auth/logout', undefined, cookie);
    expect(logout.status).toBe(204);
    expect(extractSetCookie(logout)).toContain('Max-Age=0');

    const meAfter = await jsonRequest(app, 'GET', '/auth/me', undefined, cookie);
    expect(meAfter.status).toBe(401);
  });

  it('rejects duplicate signup', async () => {
    await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'bob@example.com',
      password: 'longenough-pass',
    });
    const dup = await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'BOB@example.com',
      password: 'otherpass11',
    });
    expect(dup.status).toBe(400);
  });

  it('rejects invalid email / short password', async () => {
    const badEmail = await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'notanemail',
      password: 'longenough-pass',
    });
    expect(badEmail.status).toBe(400);
    const badPass = await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'ok@example.com',
      password: 'short',
    });
    expect(badPass.status).toBe(400);
  });

  it('login succeeds with correct credentials', async () => {
    await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'carol@example.com',
      password: 'longenough-pass',
    });
    const login = await jsonRequest(app, 'POST', '/auth/login', {
      email: 'carol@example.com',
      password: 'longenough-pass',
    });
    expect(login.status).toBe(200);
    expect(extractSessionCookie(login).length).toBeGreaterThan(10);
  });

  it('login 401s on wrong password', async () => {
    await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'dave@example.com',
      password: 'longenough-pass',
    });
    const login = await jsonRequest(app, 'POST', '/auth/login', {
      email: 'dave@example.com',
      password: 'wrongpass1',
    });
    expect(login.status).toBe(401);
  });

  it('/me 401s without session cookie', async () => {
    const me = await jsonRequest(app, 'GET', '/auth/me');
    expect(me.status).toBe(401);
  });

  it('expired session is rejected', async () => {
    const signup = await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'eve@example.com',
      password: 'longenough-pass',
    });
    const cookie = extractSessionCookie(signup);
    // force expiry
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const me = await jsonRequest(app, 'GET', '/auth/me', undefined, cookie);
    expect(me.status).toBe(401);
  });

  it('verify-email marks user verified', async () => {
    const signup = await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'frank@example.com',
      password: 'longenough-pass',
    });
    const { email_verification_token, user } = (await signup.json()) as {
      email_verification_token: string;
      user: { id: string };
    };
    const verify = await jsonRequest(app, 'POST', '/auth/verify-email', {
      token: email_verification_token,
    });
    expect(verify.status).toBe(204);

    const row = db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(user.id) as {
      email_verified_at: string | null;
    };
    expect(row.email_verified_at).not.toBeNull();

    // Second use of same token fails.
    const reverify = await jsonRequest(app, 'POST', '/auth/verify-email', {
      token: email_verification_token,
    });
    expect(reverify.status).toBe(400);
  });

  it('verify-email rejects bogus tokens', async () => {
    const res = await jsonRequest(app, 'POST', '/auth/verify-email', { token: 'nope' });
    expect(res.status).toBe(400);
  });
});
