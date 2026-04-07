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
