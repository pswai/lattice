import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('Dashboard', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('GET / returns HTML', async () => {
    const res = await ctx.app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    const body = await res.text();
    // React app or fallback message — either way it's valid HTML
    expect(body).toContain('<html');
  });

  it('GET / does not require authentication', async () => {
    const res = await ctx.app.request('/');
    expect(res.status).toBe(200);
  });

  it('SSE stream accepts ?token= query param for EventSource compatibility', async () => {
    const res = await ctx.app.request(
      '/api/v1/events/stream?token=' + encodeURIComponent(ctx.apiKey),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    // Cancel the stream to clean up
    await res.body?.cancel();
  });
});

// ─── Dashboard snapshot endpoint (from phase3-deferred) ───────────────

describe('Dashboard snapshot', () => {
  it('returns combined agents, tasks, analytics, events', async () => {
    const ctx = createTestContext();

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
