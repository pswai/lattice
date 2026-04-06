import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createTestDb,
  setupTeam,
  testConfig,
  TEST_ADMIN_KEY,
  request,
  authHeaders,
} from './helpers.js';
import { createAdminKeyRoutes } from '../src/http/routes/admin-keys.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import type Database from 'better-sqlite3';

function adminHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_ADMIN_KEY}`,
    'Content-Type': 'application/json',
  };
}

function buildRouter(db: Database.Database): Hono {
  const app = new Hono();
  app.route('/admin', createAdminKeyRoutes(db, testConfig()));
  return app;
}

describe('admin-keys routes', () => {
  let db: Database.Database;
  let teamId: string;
  let apiKey: string;
  let router: Hono;

  beforeEach(() => {
    db = createTestDb();
    const t = setupTeam(db);
    teamId = t.teamId;
    apiKey = t.apiKey;
    router = buildRouter(db);
  });

  it('requires admin bearer auth', async () => {
    const res = await router.request(`/admin/teams/${teamId}/keys`);
    expect(res.status).toBe(401);
  });

  it('GET lists keys without exposing hash or raw key', async () => {
    const res = await router.request(`/admin/teams/${teamId}/keys`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.keys)).toBe(true);
    expect(data.keys.length).toBeGreaterThanOrEqual(1);
    const k = data.keys[0];
    expect(k).toHaveProperty('id');
    expect(k).toHaveProperty('label');
    expect(k).toHaveProperty('scope');
    expect(k).toHaveProperty('created_at');
    expect(k).toHaveProperty('last_used_at');
    expect(k).toHaveProperty('expires_at');
    expect(k).toHaveProperty('revoked_at');
    expect(k).not.toHaveProperty('key_hash');
    expect(k).not.toHaveProperty('api_key');
    // ensure raw apiKey value never present in serialized body
    const raw = JSON.stringify(data);
    expect(raw).not.toContain(apiKey);
  });

  it('GET 404s for nonexistent team', async () => {
    const res = await router.request('/admin/teams/ghost/keys', {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('POST creates a key with optional expires_in_days', async () => {
    const res = await router.request(`/admin/teams/${teamId}/keys`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ label: 'ci', scope: 'read', expires_in_days: 7 }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.api_key).toMatch(/^lt_/);
    expect(data.label).toBe('ci');
    expect(data.scope).toBe('read');
    expect(data.expires_at).toBeTruthy();
  });

  it('POST rotate issues new key and revokes old', async () => {
    // First create a key to rotate.
    const createRes = await router.request(`/admin/teams/${teamId}/keys`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ label: 'rotate-me', scope: 'write' }),
    });
    const created = await createRes.json();
    const keyId = created.id;

    const rotateRes = await router.request(
      `/admin/teams/${teamId}/keys/${keyId}/rotate`,
      { method: 'POST', headers: adminHeaders() },
    );
    expect(rotateRes.status).toBe(201);
    const rotated = await rotateRes.json();
    expect(rotated.api_key).toMatch(/^lt_/);
    expect(rotated.api_key).not.toBe(created.api_key);
    expect(rotated.rotated_from).toBe(keyId);
    expect(rotated.label).toBe('rotate-me');
    expect(rotated.scope).toBe('write');

    // Old key now has revoked_at set.
    const row = db
      .prepare('SELECT revoked_at FROM api_keys WHERE id = ?')
      .get(keyId) as { revoked_at: string | null };
    expect(row.revoked_at).not.toBeNull();
  });

  it('POST rotate 404s for unknown key', async () => {
    const res = await router.request(
      `/admin/teams/${teamId}/keys/99999/rotate`,
      { method: 'POST', headers: adminHeaders() },
    );
    expect(res.status).toBe(404);
  });

  it('POST revoke marks key revoked', async () => {
    const createRes = await router.request(`/admin/teams/${teamId}/keys`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ label: 'kill-me' }),
    });
    const { id: keyId } = await createRes.json();

    const res = await router.request(`/admin/keys/${keyId}/revoke`, {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revoked).toBe(true);

    const row = db
      .prepare('SELECT revoked_at FROM api_keys WHERE id = ?')
      .get(keyId) as { revoked_at: string | null };
    expect(row.revoked_at).not.toBeNull();
  });

  it('revoked key is rejected by auth middleware (end-to-end)', async () => {
    // use the full app
    const config = testConfig();
    const fullApp = createApp(db, () => createMcpServer(db), config);

    // Create a fresh key via admin-keys router
    const createRes = await router.request(`/admin/teams/${teamId}/keys`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ label: 'e2e', scope: 'write' }),
    });
    const created = await createRes.json();

    // It works initially
    const ok = await request(fullApp, 'GET', '/api/v1/tasks', {
      headers: authHeaders(created.api_key),
    });
    expect(ok.status).toBe(200);

    // Revoke it
    await router.request(`/admin/keys/${created.id}/revoke`, {
      method: 'POST',
      headers: adminHeaders(),
    });

    // Now rejected
    const denied = await request(fullApp, 'GET', '/api/v1/tasks', {
      headers: authHeaders(created.api_key),
    });
    expect(denied.status).toBe(401);
  });
});
