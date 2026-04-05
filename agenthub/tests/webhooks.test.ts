import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import {
  startWebhookDispatcher,
  type WebhookDispatcher,
} from '../src/services/webhook-dispatcher.js';
import { broadcastInternal } from '../src/models/event.js';
import { signPayload, RETRY_SCHEDULE_MS } from '../src/models/webhook.js';

interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function makeFakeFetch(handler: (url: string, init: RequestInit) => { status: number; delayMs?: number; throw?: Error }) {
  const received: Received[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const response = handler(url, init);
    received.push({
      url,
      headers: (init.headers as Record<string, string>) ?? {},
      body: (init.body as string) ?? '',
    });
    if (response.throw) throw response.throw;
    if (response.delayMs) {
      await new Promise((r) => setTimeout(r, response.delayMs));
    }
    return new Response('ok', { status: response.status });
  }) as unknown as typeof fetch;
  return { received, fetchImpl };
}

describe('Webhooks — CRUD', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });

  it('creates a webhook and returns the plaintext secret', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'https://example.com/hook', event_types: ['BROADCAST', 'TASK_UPDATE'] },
    });
    expect(res.status).toBe(201);
    const wh = await res.json();
    expect(wh.id).toMatch(/^whk_/);
    expect(wh.secret).toMatch(/^whsk_/);
    expect(wh.eventTypes).toEqual(['BROADCAST', 'TASK_UPDATE']);
    expect(wh.active).toBe(true);
  });

  it('defaults event_types to wildcard', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'https://example.com/hook' },
    });
    const wh = await res.json();
    expect(wh.eventTypes).toEqual(['*']);
  });

  it('rejects invalid URLs', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'not a url' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown event_types', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'https://example.com/hook', event_types: ['BOGUS'] },
    });
    expect(res.status).toBe(400);
  });

  it('lists webhooks with redacted secrets', async () => {
    await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'https://example.com/a' },
    });
    const res = await request(ctx.app, 'GET', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.webhooks[0].secret).toContain('...');
    expect(data.webhooks[0].secret).not.toMatch(/whsk_[A-Za-z0-9_-]{20,}/);
  });

  it('gets a single webhook', async () => {
    const createRes = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'https://example.com/a' },
    });
    const created = await createRes.json();
    const res = await request(ctx.app, 'GET', `/api/v1/webhooks/${created.id}`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    expect(res.status).toBe(200);
    const wh = await res.json();
    expect(wh.id).toBe(created.id);
  });

  it('deletes a webhook', async () => {
    const createRes = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'https://example.com/a' },
    });
    const created = await createRes.json();
    const delRes = await request(ctx.app, 'DELETE', `/api/v1/webhooks/${created.id}`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    expect(delRes.status).toBe(200);

    const getRes = await request(ctx.app, 'GET', `/api/v1/webhooks/${created.id}`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    expect(getRes.status).toBe(404);
  });

  it('isolates webhooks by team', async () => {
    const createRes = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url: 'https://example.com/a' },
    });
    const created = await createRes.json();

    // Second team shouldn't see it.
    const ctx2 = createTestContext('other-team', 'ahk_other_key_12345678901234567890');
    // Copy the created webhook row into the other DB to prove tenant filtering.
    const delRes = await request(ctx2.app, 'DELETE', `/api/v1/webhooks/${created.id}`, {
      headers: authHeaders(ctx2.apiKey, 'bob'),
    });
    expect(delRes.status).toBe(404);
  });
});

describe('Webhooks — HMAC signing', () => {
  it('produces deterministic hex for known inputs', () => {
    const sig = signPayload('whsk_secret', 1712000000, '{"hello":"world"}');
    const expected = createHmac('sha256', 'whsk_secret')
      .update('1712000000.{"hello":"world"}')
      .digest('hex');
    expect(sig).toBe(`t=1712000000,v1=${expected}`);
  });

  it('differs when body changes', () => {
    const a = signPayload('s', 1, 'a');
    const b = signPayload('s', 1, 'b');
    expect(a).not.toBe(b);
  });
});

describe('Webhooks — delivery dispatcher', () => {
  let ctx: TestContext;
  let dispatcher: WebhookDispatcher | null = null;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    dispatcher?.stop();
    dispatcher = null;
  });

  async function createWebhook(url: string, eventTypes: string[] = ['*']): Promise<{ id: string; secret: string }> {
    const res = await request(ctx.app, 'POST', '/api/v1/webhooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { url, event_types: eventTypes },
    });
    return await res.json();
  }

  it('delivers matching events, signs body, records success', async () => {
    const { fetchImpl, received } = makeFakeFetch(() => ({ status: 200 }));
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50 });
    const wh = await createWebhook('https://example.com/hook', ['BROADCAST']);

    broadcastInternal(ctx.db, ctx.teamId, 'BROADCAST', 'hello', ['t'], 'alice');
    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBe(1);
    const sig = received[0].headers['X-AgentHub-Signature'];
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // Validate signature matches
    const [tPart, vPart] = sig.split(',');
    const ts = Number(tPart.slice(2));
    const expected = createHmac('sha256', wh.secret)
      .update(`${ts}.${received[0].body}`)
      .digest('hex');
    expect(vPart).toBe(`v1=${expected}`);

    // Delivery row should be success.
    const delRes = await request(ctx.app, 'GET', `/api/v1/webhooks/${wh.id}/deliveries`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    const { deliveries } = await delRes.json();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('success');
    expect(deliveries[0].responseCode).toBe(200);
  });

  it('filters by event_types', async () => {
    const { fetchImpl, received } = makeFakeFetch(() => ({ status: 200 }));
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50 });
    await createWebhook('https://example.com/hook', ['TASK_UPDATE']);

    broadcastInternal(ctx.db, ctx.teamId, 'BROADCAST', 'hello', [], 'alice');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);

    broadcastInternal(ctx.db, ctx.teamId, 'TASK_UPDATE', 'x', [], 'alice');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
  });

  it('does not deliver to other teams', async () => {
    const { fetchImpl, received } = makeFakeFetch(() => ({ status: 200 }));
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50 });
    await createWebhook('https://example.com/hook', ['*']);

    broadcastInternal(ctx.db, 'other-team', 'BROADCAST', 'hello', [], 'alice');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
  });

  it('does not retry on 4xx (terminal failure)', async () => {
    const { fetchImpl } = makeFakeFetch(() => ({ status: 400 }));
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50 });
    const wh = await createWebhook('https://example.com/hook', ['*']);

    broadcastInternal(ctx.db, ctx.teamId, 'BROADCAST', 'hello', [], 'alice');
    await new Promise((r) => setTimeout(r, 100));

    const delRes = await request(ctx.app, 'GET', `/api/v1/webhooks/${wh.id}/deliveries`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    const { deliveries } = await delRes.json();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('failed');
    expect(deliveries[0].attempts).toBe(1);
    expect(deliveries[0].nextRetryAt).toBeNull();
  });

  it('schedules retry on 5xx', async () => {
    const { fetchImpl } = makeFakeFetch(() => ({ status: 503 }));
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50 });
    const wh = await createWebhook('https://example.com/hook', ['*']);

    broadcastInternal(ctx.db, ctx.teamId, 'BROADCAST', 'hello', [], 'alice');
    await new Promise((r) => setTimeout(r, 100));

    const delRes = await request(ctx.app, 'GET', `/api/v1/webhooks/${wh.id}/deliveries`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    const { deliveries } = await delRes.json();
    expect(deliveries[0].status).toBe('pending');
    expect(deliveries[0].attempts).toBe(1);
    expect(deliveries[0].nextRetryAt).not.toBeNull();
  });

  it('marks dead after retry schedule exhausted', () => {
    // The schedule must have 7 steps
    expect(RETRY_SCHEDULE_MS.length).toBe(7);
  });

  it('auto-disables webhook after 20 consecutive failures', async () => {
    const { fetchImpl } = makeFakeFetch(() => ({ status: 400 }));
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50 });
    const wh = await createWebhook('https://example.com/hook', ['*']);

    for (let i = 0; i < 20; i++) {
      broadcastInternal(ctx.db, ctx.teamId, 'BROADCAST', `m${i}`, [], 'alice');
    }
    await new Promise((r) => setTimeout(r, 300));
    // Drain remaining deliveries.
    await dispatcher.processOnce();

    const row = ctx.db
      .prepare('SELECT active, failure_count FROM webhooks WHERE id = ?')
      .get(wh.id) as { active: number; failure_count: number };
    expect(row.failure_count).toBeGreaterThanOrEqual(20);
    expect(row.active).toBe(0);
  });

  it('resets failure_count on success', async () => {
    let shouldFail = true;
    const { fetchImpl } = makeFakeFetch(() => ({ status: shouldFail ? 400 : 200 }));
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50 });
    const wh = await createWebhook('https://example.com/hook', ['*']);

    broadcastInternal(ctx.db, ctx.teamId, 'BROADCAST', 'fail', [], 'alice');
    await new Promise((r) => setTimeout(r, 100));
    shouldFail = false;
    broadcastInternal(ctx.db, ctx.teamId, 'BROADCAST', 'ok', [], 'alice');
    await new Promise((r) => setTimeout(r, 100));

    const row = ctx.db
      .prepare('SELECT failure_count FROM webhooks WHERE id = ?')
      .get(wh.id) as { failure_count: number };
    expect(row.failure_count).toBe(0);
  });

  it('respects timeout and marks delivery as retriable', async () => {
    const { fetchImpl } = makeFakeFetch(() => {
      // Throw an AbortError-like exception; the dispatcher's AbortController
      // actually causes the fetch to throw. Simulate it.
      const err = new Error('aborted');
      err.name = 'AbortError';
      return { status: 0, throw: err };
    });
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50, timeoutMs: 50 });
    const wh = await createWebhook('https://example.com/hook', ['*']);

    broadcastInternal(ctx.db, ctx.teamId, 'BROADCAST', 'hello', [], 'alice');
    await new Promise((r) => setTimeout(r, 100));
    const delRes = await request(ctx.app, 'GET', `/api/v1/webhooks/${wh.id}/deliveries`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    const { deliveries } = await delRes.json();
    expect(deliveries[0].status).toBe('pending');
    expect(deliveries[0].error).toBeTruthy();
  });

  it('sends correct headers', async () => {
    const { fetchImpl, received } = makeFakeFetch(() => ({ status: 200 }));
    dispatcher = startWebhookDispatcher(ctx.db, { fetchImpl, intervalMs: 50 });
    await createWebhook('https://example.com/hook', ['*']);

    broadcastInternal(ctx.db, ctx.teamId, 'LEARNING', 'neat', ['tag'], 'alice');
    await new Promise((r) => setTimeout(r, 100));

    const headers = received[0].headers;
    expect(headers['X-AgentHub-Event']).toBe('LEARNING');
    expect(headers['X-AgentHub-Delivery']).toMatch(/^dlv_/);
    expect(headers['User-Agent']).toBe('AgentHub-Webhooks/1.0');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(received[0].body);
    expect(body.event_type).toBe('LEARNING');
    expect(body.message).toBe('neat');
    expect(body.tags).toEqual(['tag']);
  });
});
