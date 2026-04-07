/**
 * Tests for: per-workspace rate limiting and dashboard snapshot endpoint
 * - Per-workspace rate limiter (429 on exceed, aggregates across API keys in same workspace)
 * - Dashboard snapshot endpoint (combined agents/tasks/analytics/events, requires auth)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, testConfig, setupWorkspace, createTestContext } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { __resetRateLimit } from '../src/http/middleware/rate-limit.js';

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
