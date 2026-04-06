import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, testConfig, setupWorkspace, createTestContext } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { __resetRateLimit } from '../src/http/middleware/rate-limit.js';
import { __resetForgotPasswordRateLimit } from '../src/http/routes/auth.js';
import { createEmailSender, clearStubEmails, getLastStubEmails } from '../src/services/email.js';
import type { Hono } from 'hono';
import type { SqliteAdapter } from '../src/db/adapter.js';

function extractSessionCookie(res: Response): string {
  const sc = res.headers.get('set-cookie') || '';
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

// ────────────────────────────────────────────────────────────
// 3A: Password Reset Flow
// ────────────────────────────────────────────────────────────
describe('Password reset flow', () => {
  let db: SqliteAdapter;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    const config = testConfig();
    const emailSender = createEmailSender(config);
    app = createApp(db, () => createMcpServer(db), config, emailSender);
    __resetForgotPasswordRateLimit();
    clearStubEmails();
  });

  it('forgot-password always returns 200 (no leak)', async () => {
    // Non-existent email
    const res = await jsonRequest(app, 'POST', '/auth/forgot-password', {
      email: 'nobody@example.com',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBeTruthy();
  });

  it('forgot-password + reset-password full flow', async () => {
    // Sign up a user
    const signup = await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'reset@example.com',
      password: 'original-password',
    });
    expect(signup.status).toBe(201);

    // Request a password reset
    const forgotRes = await jsonRequest(app, 'POST', '/auth/forgot-password', {
      email: 'reset@example.com',
    });
    expect(forgotRes.status).toBe(200);

    // Wait a tick for fire-and-forget email promise to resolve
    await new Promise((r) => setTimeout(r, 10));

    const emails = getLastStubEmails();
    const resetEmail = emails.find((e) => e.subject.includes('Reset'));
    expect(resetEmail).toBeTruthy();
    const tokenMatch = resetEmail!.body.match(/token=([A-Za-z0-9_-]+)/);
    expect(tokenMatch).toBeTruthy();
    const rawToken = tokenMatch![1];

    // Reset the password
    const resetRes = await jsonRequest(app, 'POST', '/auth/reset-password', {
      token: rawToken,
      password: 'new-password-123',
    });
    expect(resetRes.status).toBe(200);

    // Old password should fail
    const loginOld = await jsonRequest(app, 'POST', '/auth/login', {
      email: 'reset@example.com',
      password: 'original-password',
    });
    expect(loginOld.status).toBe(401);

    // New password should work
    const loginNew = await jsonRequest(app, 'POST', '/auth/login', {
      email: 'reset@example.com',
      password: 'new-password-123',
    });
    expect(loginNew.status).toBe(200);
  });

  it('reset-password rejects used token', async () => {
    await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'used@example.com',
      password: 'original-pass',
    });
    await jsonRequest(app, 'POST', '/auth/forgot-password', {
      email: 'used@example.com',
    });

    // Wait a tick for fire-and-forget email promise to resolve
    await new Promise((r) => setTimeout(r, 10));
    const emails = getLastStubEmails();
    const resetEmail = emails.find((e) => e.to === 'used@example.com' && e.subject.includes('Reset'));
    const rawToken = resetEmail!.body.match(/token=([A-Za-z0-9_-]+)/)![1];

    // First use succeeds
    const r1 = await jsonRequest(app, 'POST', '/auth/reset-password', {
      token: rawToken,
      password: 'new-pass-12345',
    });
    expect(r1.status).toBe(200);

    // Second use fails
    const r2 = await jsonRequest(app, 'POST', '/auth/reset-password', {
      token: rawToken,
      password: 'another-pass-12345',
    });
    expect(r2.status).toBe(400);
  });

  it('reset-password rejects bogus token', async () => {
    const res = await jsonRequest(app, 'POST', '/auth/reset-password', {
      token: 'bogus-token',
      password: 'new-pass-12345',
    });
    expect(res.status).toBe(400);
  });

  it('reset-password rejects short password', async () => {
    const res = await jsonRequest(app, 'POST', '/auth/reset-password', {
      token: 'some-token',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('forgot-password rate limits after 3 requests per email per hour', async () => {
    __resetForgotPasswordRateLimit();

    // First 3 requests should succeed (and not create reset tokens for non-existent email)
    for (let i = 0; i < 3; i++) {
      const res = await jsonRequest(app, 'POST', '/auth/forgot-password', {
        email: 'ratelimit@example.com',
      });
      expect(res.status).toBe(200);
    }

    // 4th request should still return 200 (no info leak) but be silently rate-limited
    const res4 = await jsonRequest(app, 'POST', '/auth/forgot-password', {
      email: 'ratelimit@example.com',
    });
    expect(res4.status).toBe(200);

    // Sign up a user and verify that the rate-limited email doesn't create a token
    await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'ratelimit@example.com',
      password: 'longenough-pass',
    });

    // Clear the stub emails
    clearStubEmails();

    // This request should be rate-limited and NOT send an email
    const res5 = await jsonRequest(app, 'POST', '/auth/forgot-password', {
      email: 'ratelimit@example.com',
    });
    expect(res5.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    const rateLimitEmails = getLastStubEmails();
    const resetEmails = rateLimitEmails.filter((e) => e.subject.includes('Reset'));
    expect(resetEmails).toHaveLength(0);

    // A different email should NOT be rate limited
    __resetForgotPasswordRateLimit(); // reset to allow this fresh email
    const res6 = await jsonRequest(app, 'POST', '/auth/forgot-password', {
      email: 'other@example.com',
    });
    expect(res6.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────
// 3B: GDPR Data Deletion
// ────────────────────────────────────────────────────────────
describe('GDPR account deletion', () => {
  let db: SqliteAdapter;
  let app: Hono;

  beforeEach(() => {
    db = createTestDb();
    const config = testConfig();
    app = createApp(db, () => createMcpServer(db), config);
  });

  it('deletes user account and owned workspace data', async () => {
    // Create user
    const signup = await jsonRequest(app, 'POST', '/auth/signup', {
      email: 'gdpr@example.com',
      password: 'longenough-pass',
    });
    expect(signup.status).toBe(201);
    const cookie = extractSessionCookie(signup);
    const { user } = (await signup.json()) as { user: { id: string } };

    // Create a workspace owned by this user
    const wsId = 'gdpr-ws';
    db.rawDb.prepare('INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)').run(
      wsId, 'GDPR workspace', user.id,
    );
    db.rawDb.prepare('INSERT INTO workspace_memberships (user_id, workspace_id, role) VALUES (?, ?, ?)').run(
      user.id, wsId, 'owner',
    );

    // Add some workspace data
    db.rawDb.prepare("INSERT INTO agents (id, workspace_id, capabilities, status, metadata) VALUES (?, ?, '[]', 'online', '{}')").run('a1', wsId);
    db.rawDb.prepare("INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, 'BROADCAST', 'test', '[]', 'a1')").run(wsId);
    db.rawDb.prepare("INSERT INTO tasks (workspace_id, description, status, created_by, priority) VALUES (?, 'task1', 'open', 'a1', 'P2')").run(wsId);
    db.rawDb.prepare("INSERT INTO context_entries (workspace_id, key, value, tags, created_by) VALUES (?, 'k1', 'v1', '[]', 'a1')").run(wsId);

    // Verify data exists
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?').get(wsId)).toEqual({ c: 1 });
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM users WHERE id = ?').get(user.id)).toEqual({ c: 1 });

    // Delete account
    const del = await jsonRequest(app, 'DELETE', '/auth/account', undefined, cookie);
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as {
      message: string;
      summary: { user_id: string; email: string; workspaces_deleted: { id: string; name: string }[] };
    };
    expect(delBody.message).toBe('Account deleted');
    expect(delBody.summary.user_id).toBe(user.id);
    expect(delBody.summary.email).toBe('gdpr@example.com');
    expect(delBody.summary.workspaces_deleted).toHaveLength(1);
    expect(delBody.summary.workspaces_deleted[0].id).toBe(wsId);

    // Verify everything is gone
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM users WHERE id = ?').get(user.id)).toEqual({ c: 0 });
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(user.id)).toEqual({ c: 0 });
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM workspaces WHERE id = ?').get(wsId)).toEqual({ c: 0 });
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?').get(wsId)).toEqual({ c: 0 });
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM events WHERE workspace_id = ?').get(wsId)).toEqual({ c: 0 });
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?').get(wsId)).toEqual({ c: 0 });
    expect(db.rawDb.prepare('SELECT COUNT(*) as c FROM context_entries WHERE workspace_id = ?').get(wsId)).toEqual({ c: 0 });
  });

  it('requires session auth', async () => {
    const res = await jsonRequest(app, 'DELETE', '/auth/account');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────
// 3C: Per-Workspace Rate Limits
// ────────────────────────────────────────────────────────────
describe('Per-workspace rate limiter', () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it('returns 429 when workspace exceeds limit', async () => {
    const db = createTestDb();
    const { apiKey } = setupWorkspace(db, 'ws-rl');
    const config = testConfig({ rateLimitPerMinuteWorkspace: 3 });
    const app = createApp(db, () => createMcpServer(db), config);

    // First 3 requests should succeed
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/api/v1/agents', {
        headers: { Authorization: `Bearer ${apiKey}`, 'X-Agent-ID': 'test' },
      });
      expect(res.status).toBe(200);
    }

    // 4th request should be rate limited
    const res = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${apiKey}`, 'X-Agent-ID': 'test' },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('RATE_LIMITED');
    expect(body.message).toContain('Workspace');
    expect(res.headers.get('X-RateLimit-Workspace-Remaining')).toBe('0');
  });

  it('aggregates across different API keys in same workspace', async () => {
    const db = createTestDb();
    const { apiKey: key1 } = setupWorkspace(db, 'ws-shared');
    // Add a second key for the same workspace
    const { createHash } = await import('crypto');
    const key2 = 'ltk_second_key_000000000000000000';
    const hash2 = createHash('sha256').update(key2).digest('hex');
    db.rawDb.prepare('INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
      'ws-shared', hash2, 'second', 'write',
    );

    const config = testConfig({ rateLimitPerMinuteWorkspace: 2 });
    const app = createApp(db, () => createMcpServer(db), config);

    // 1 request from key1
    const r1 = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${key1}`, 'X-Agent-ID': 'a' },
    });
    expect(r1.status).toBe(200);

    // 1 request from key2
    const r2 = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${key2}`, 'X-Agent-ID': 'b' },
    });
    expect(r2.status).toBe(200);

    // 3rd request from either key should be rate limited (limit=2)
    const r3 = await app.request('/api/v1/agents', {
      headers: { Authorization: `Bearer ${key1}`, 'X-Agent-ID': 'a' },
    });
    expect(r3.status).toBe(429);
  });
});

// ────────────────────────────────────────────────────────────
// 3D: Dashboard Snapshot endpoint
// ────────────────────────────────────────────────────────────
describe('Dashboard snapshot', () => {
  it('returns combined agents, tasks, analytics, events', async () => {
    const ctx = createTestContext();

    // Seed some data
    ctx.rawDb.prepare("INSERT INTO agents (id, workspace_id, capabilities, status, metadata) VALUES (?, ?, '[]', 'online', '{}')").run('snap-agent', ctx.workspaceId);
    ctx.rawDb.prepare("INSERT INTO tasks (workspace_id, description, status, created_by, priority) VALUES (?, 'snap task', 'open', 'snap-agent', 'P2')").run(ctx.workspaceId);
    ctx.rawDb.prepare("INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, 'BROADCAST', 'snap event', '[]', 'snap-agent')").run(ctx.workspaceId);

    const res = await ctx.app.request('/api/v1/dashboard-snapshot', {
      headers: { Authorization: `Bearer ${ctx.apiKey}`, 'X-Agent-ID': 'test' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].id).toBe('snap-agent');

    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].description).toBe('snap task');

    expect(body.recentEvents).toHaveLength(1);
    expect(body.recentEvents[0].message).toBe('snap event');

    expect(body.analytics).toBeTruthy();
    expect(body.analytics.tasks).toBeTruthy();
    expect(body.analytics.events).toBeTruthy();
    expect(body.analytics.agents).toBeTruthy();
  });

  it('requires auth', async () => {
    const ctx = createTestContext();
    const res = await ctx.app.request('/api/v1/dashboard-snapshot');
    expect(res.status).toBe(401);
  });
});
