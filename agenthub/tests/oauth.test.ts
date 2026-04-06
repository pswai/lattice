import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

function extractCookie(res: Response, name: string): string {
  // Response headers collapse Set-Cookie into a comma-joined string.
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie;
  const all = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : [];
  const joined = all.length > 0 ? all.join('\n') : res.headers.get('set-cookie') || '';
  const m = joined.match(new RegExp(`${name}=([^;\\s]*)`));
  return m ? m[1] : '';
}

function setupApp(overrides?: Record<string, unknown>) {
  const db = createTestDb();
  const app = createApp(
    db,
    () => createMcpServer(db),
    testConfig({
      githubOAuthClientId: 'test_client_id',
      githubOAuthClientSecret: 'test_client_secret',
      githubOAuthRedirectUri: 'http://localhost:3000/auth/oauth/github/callback',
      appBaseUrl: 'http://localhost:3000',
      ...overrides,
    }),
  );
  return { db, app };
}

describe('/auth/oauth/github', () => {
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    const s = setupApp();
    db = s.db;
    app = s.app;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /github redirects with client_id and state', async () => {
    const res = await app.request('/auth/oauth/github', { method: 'GET', redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('https://github.com/login/oauth/authorize');
    expect(loc).toContain('client_id=test_client_id');
    expect(loc).toContain('scope=user');
    expect(loc).toMatch(/state=[A-Za-z0-9_-]+/);
    const state = extractCookie(res, 'oauth_state');
    expect(state.length).toBeGreaterThan(8);
    expect(loc).toContain(`state=${state}`);
  });

  it('GET /github returns 503 when clientId is not configured', async () => {
    const db2 = createTestDb();
    const app2 = createApp(
      db2,
      () => createMcpServer(db2),
      testConfig({ githubOAuthClientId: '' }),
    );
    const res = await app2.request('/auth/oauth/github', { method: 'GET' });
    expect(res.status).toBe(503);
  });

  it('callback rejects on state mismatch', async () => {
    const res = await app.request('/auth/oauth/github/callback?code=abc&state=wrong', {
      method: 'GET',
      headers: { Cookie: 'oauth_state=correct' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('STATE_MISMATCH');
  });

  it('callback returns 400 when code is missing', async () => {
    const res = await app.request('/auth/oauth/github/callback?state=s', {
      method: 'GET',
      headers: { Cookie: 'oauth_state=s' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('MISSING_CODE');
  });

  it('callback returns 400 when state cookie is missing', async () => {
    const res = await app.request('/auth/oauth/github/callback?code=abc&state=s', {
      method: 'GET',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('MISSING_STATE');
  });

  it('happy path: creates user + identity + session cookie + 302 redirect', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      if (u.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_token' }), { status: 200 });
      }
      if (u.endsWith('/user')) {
        return new Response(
          JSON.stringify({ id: 12345, login: 'alice', name: 'Alice Smith', email: null }),
          { status: 200 },
        );
      }
      if (u.endsWith('/user/emails')) {
        return new Response(
          JSON.stringify([
            { email: 'alice@example.com', primary: true, verified: true },
            { email: 'alt@example.com', primary: false, verified: true },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const res = await app.request(
      '/auth/oauth/github/callback?code=thecode&state=abc123',
      { method: 'GET', headers: { Cookie: 'oauth_state=abc123' }, redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3000');
    const sessionCookie = extractCookie(res, 'lt_session');
    expect(sessionCookie.length).toBeGreaterThan(10);

    // User + identity persisted.
    const idRow = db
      .prepare('SELECT user_id, email FROM oauth_identities WHERE provider = ? AND provider_uid = ?')
      .get('github', '12345') as { user_id: string; email: string } | undefined;
    expect(idRow).toBeDefined();
    expect(idRow!.email).toBe('alice@example.com');
    const userRow = db
      .prepare('SELECT email, email_verified_at FROM users WHERE id = ?')
      .get(idRow!.user_id) as { email: string; email_verified_at: string | null };
    expect(userRow.email).toBe('alice@example.com');
    expect(userRow.email_verified_at).not.toBeNull();

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('links identity to existing user with same email (no duplicate user)', async () => {
    // Seed a user with verified email alice@example.com (verification required for OAuth linking).
    db.prepare(
      "INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ('u_existing', 'alice@example.com', 'x:y', '2024-01-01T00:00:00Z')",
    ).run();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      if (u.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_token' }), { status: 200 });
      }
      if (u.endsWith('/user')) {
        return new Response(
          JSON.stringify({ id: 9999, login: 'alice', name: 'Alice', email: null }),
          { status: 200 },
        );
      }
      if (u.endsWith('/user/emails')) {
        return new Response(
          JSON.stringify([{ email: 'alice@example.com', primary: true, verified: true }]),
          { status: 200 },
        );
      }
      throw new Error('nope');
    });

    const res = await app.request(
      '/auth/oauth/github/callback?code=c&state=s',
      { method: 'GET', headers: { Cookie: 'oauth_state=s' }, redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
    expect(userCount.c).toBe(1);
    const idRow = db
      .prepare('SELECT user_id FROM oauth_identities WHERE provider_uid = ?')
      .get('9999') as { user_id: string };
    expect(idRow.user_id).toBe('u_existing');
  });

  it('second callback with same provider_uid returns the existing user', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      if (u.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (u.endsWith('/user')) {
        return new Response(
          JSON.stringify({ id: 42, login: 'bob', name: 'Bob', email: null }),
          { status: 200 },
        );
      }
      if (u.endsWith('/user/emails')) {
        return new Response(
          JSON.stringify([{ email: 'bob@example.com', primary: true, verified: true }]),
          { status: 200 },
        );
      }
      throw new Error('nope');
    });

    const res1 = await app.request('/auth/oauth/github/callback?code=c&state=s', {
      method: 'GET',
      headers: { Cookie: 'oauth_state=s' },
      redirect: 'manual',
    });
    expect(res1.status).toBe(302);
    const res2 = await app.request('/auth/oauth/github/callback?code=c2&state=s2', {
      method: 'GET',
      headers: { Cookie: 'oauth_state=s2' },
      redirect: 'manual',
    });
    expect(res2.status).toBe(302);

    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
    expect(userCount.c).toBe(1);
    const idCount = db
      .prepare('SELECT COUNT(*) as c FROM oauth_identities')
      .get() as { c: number };
    expect(idCount.c).toBe(1);
  });
});
