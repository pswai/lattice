import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('Dashboard', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('GET / returns HTML with AgentHub Dashboard title', async () => {
    const res = await ctx.app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('<title>AgentHub Dashboard</title>');
  });

  it('GET / does not require authentication', async () => {
    const res = await ctx.app.request('/');
    expect(res.status).toBe(200);
  });

  it('HTML contains all expected dashboard sections', async () => {
    const res = await ctx.app.request('/');
    const body = await res.text();
    // Agent list panel
    expect(body).toContain('id="agents"');
    // Task board columns
    expect(body).toContain('id="tasks-open"');
    expect(body).toContain('id="tasks-claimed"');
    expect(body).toContain('id="tasks-completed"');
    // Event feed
    expect(body).toContain('id="feed"');
    // Analytics cards
    expect(body).toContain('id="a-tasks"');
    expect(body).toContain('id="a-events"');
    expect(body).toContain('id="a-agents"');
    expect(body).toContain('id="a-completion"');
    // First-run setup form
    expect(body).toContain('id="setup"');
    expect(body).toContain('id="key-input"');
    // SSE connection to events stream with token param
    expect(body).toContain('/api/v1/events/stream?token=');
  });

  it('HTML contains v2 tabs and new section containers', async () => {
    const res = await ctx.app.request('/');
    const body = await res.text();
    // Tab nav
    expect(body).toContain('data-tab="overview"');
    expect(body).toContain('data-tab="graph"');
    expect(body).toContain('data-tab="artifacts"');
    expect(body).toContain('data-tab="playbooks"');
    // Tab panels
    expect(body).toContain('id="tab-overview"');
    expect(body).toContain('id="tab-graph"');
    expect(body).toContain('id="tab-artifacts"');
    expect(body).toContain('id="tab-playbooks"');
    // Graph SVG
    expect(body).toContain('id="graph-svg"');
    // Artifacts grid
    expect(body).toContain('id="artifacts-grid"');
    // Playbooks list
    expect(body).toContain('id="playbooks-list"');
    // Modal + toast helpers
    expect(body).toContain('id="modal"');
    // API endpoint references
    expect(body).toContain('/tasks/graph');
    expect(body).toContain('/artifacts');
    expect(body).toContain('/playbooks');
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
