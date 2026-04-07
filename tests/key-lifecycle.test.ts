import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import {
  createTestContext,
  request,
  authHeaders,
  type TestContext,
} from './helpers.js';
import { __resetAuthThrottle } from '../src/http/middleware/auth.js';

describe('API key lifecycle', () => {
  let ctx: TestContext;

  beforeEach(() => {
    __resetAuthThrottle();
    ctx = createTestContext();
  });

  it('rejects an expired key with 401', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const keyHash = createHash('sha256').update(ctx.apiKey).digest('hex');
    ctx.db
      .prepare('UPDATE api_keys SET expires_at = ? WHERE key_hash = ?')
      .run(past, keyHash);

    const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(401);
  });

  it('accepts a non-expired key', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const keyHash = createHash('sha256').update(ctx.apiKey).digest('hex');
    ctx.db
      .prepare('UPDATE api_keys SET expires_at = ? WHERE key_hash = ?')
      .run(future, keyHash);

    const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a revoked key with 401', async () => {
    const keyHash = createHash('sha256').update(ctx.apiKey).digest('hex');
    ctx.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE key_hash = ?')
      .run(new Date().toISOString(), keyHash);

    const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(401);
  });

  it('updates last_used_at on auth success', async () => {
    const keyHash = createHash('sha256').update(ctx.apiKey).digest('hex');
    const before = ctx.db
      .prepare('SELECT last_used_at FROM api_keys WHERE key_hash = ?')
      .get(keyHash) as { last_used_at: string | null };
    expect(before.last_used_at).toBeNull();

    const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);

    const after = ctx.db
      .prepare('SELECT last_used_at FROM api_keys WHERE key_hash = ?')
      .get(keyHash) as { last_used_at: string | null };
    expect(after.last_used_at).not.toBeNull();
  });

  it('throttles last_used_at updates (no update within 60s)', async () => {
    const keyHash = createHash('sha256').update(ctx.apiKey).digest('hex');

    await request(ctx.app, 'GET', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
    });
    const after1 = ctx.db
      .prepare('SELECT last_used_at FROM api_keys WHERE key_hash = ?')
      .get(keyHash) as { last_used_at: string | null };

    // Manually clear the column to see if a second auth within window updates.
    ctx.db
      .prepare('UPDATE api_keys SET last_used_at = NULL WHERE key_hash = ?')
      .run(keyHash);

    await request(ctx.app, 'GET', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
    });
    const after2 = ctx.db
      .prepare('SELECT last_used_at FROM api_keys WHERE key_hash = ?')
      .get(keyHash) as { last_used_at: string | null };

    expect(after1.last_used_at).not.toBeNull();
    expect(after2.last_used_at).toBeNull(); // throttle prevented update

    // Reset throttle and re-auth — now it should update.
    __resetAuthThrottle();
    await request(ctx.app, 'GET', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
    });
    const after3 = ctx.db
      .prepare('SELECT last_used_at FROM api_keys WHERE key_hash = ?')
      .get(keyHash) as { last_used_at: string | null };
    expect(after3.last_used_at).not.toBeNull();
  });

  it('existing keys with null expires_at/revoked_at still work', async () => {
    // createTestContext leaves expires_at/revoked_at null by default.
    const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
  });
});
