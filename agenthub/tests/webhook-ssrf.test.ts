import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('webhook CREATE rejects SSRF-prone URLs', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('blocks 127.0.0.1 with 400', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'http://127.0.0.1:8080/hook' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/BLOCKED_URL/);
  });

  it('blocks 169.254.169.254 (cloud metadata) with 400', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toMatch(/BLOCKED_URL/);
  });

  it('allows https://api.example.com with 201', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'https://api.example.com/hook' },
    });
    expect(res.status).toBe(201);
  });
});
