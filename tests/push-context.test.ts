import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Push-mode context recommendations', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  async function saveContextAs(agent: string, key: string, value: string, tags: string[]) {
    const res = await request(ctx.app, 'POST', '/api/v1/context', {
      headers: authHeaders(ctx.apiKey, agent),
      body: { key, value, tags },
    });
    if (res.status >= 300) {
      throw new Error(`saveContext failed: ${res.status} ${await res.text()}`);
    }
  }

  async function broadcastAs(agent: string, message: string, tags: string[]) {
    const res = await request(ctx.app, 'POST', '/api/v1/events', {
      headers: authHeaders(ctx.apiKey, agent),
      body: { event_type: 'BROADCAST', message, tags },
    });
    if (res.status >= 300) {
      throw new Error(`broadcast failed: ${res.status} ${await res.text()}`);
    }
  }

  async function getUpdates(agent: string, qs = ''): Promise<{
    events: Array<{ id: number }>;
    cursor: number;
    recommended_context?: Array<{ id: number; key: string; preview: string; tags: string[]; createdBy: string; createdAt: string }>;
  }> {
    const res = await request(ctx.app, 'GET', `/api/v1/events${qs ? '?' + qs : ''}`, {
      headers: authHeaders(ctx.apiKey, agent),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  it('returns entries whose tags match the caller recent broadcast tags', async () => {
    // Teammate saves entries with tag X
    await saveContextAs('alice', 'alice-finding-1', 'Auth endpoint returns 500 under load', ['auth', 'perf']);
    await saveContextAs('alice', 'alice-finding-2', 'Unrelated finding', ['database']);

    // Caller bob has recent activity with tag "auth"
    await broadcastAs('bob', 'Looking at auth flows', ['auth']);

    const data = await getUpdates('bob');
    expect(data.recommended_context).toBeDefined();
    const keys = data.recommended_context!.map(e => e.key);
    expect(keys).toContain('alice-finding-1');
    expect(keys).not.toContain('alice-finding-2');
  });

  it("includes own entries alongside teammate entries", async () => {
    // Bob broadcasts with tag "auth" and saves his own entry with tag "auth"
    await broadcastAs('bob', 'investigating auth', ['auth']);
    await saveContextAs('bob', 'bob-note', 'my own notes', ['auth']);
    await saveContextAs('alice', 'alice-note', 'teammate insight', ['auth']);

    const data = await getUpdates('bob');
    expect(data.recommended_context).toBeDefined();
    const keys = data.recommended_context!.map(e => e.key);
    // Both own and teammate entries are now included
    expect(keys).toContain('alice-note');
  });

  it('include_context=false skips the recommendation', async () => {
    await saveContextAs('alice', 'alice-entry', 'hello', ['auth']);
    await broadcastAs('bob', 'auth work', ['auth']);

    const data = await getUpdates('bob', 'include_context=false');
    expect(data.recommended_context).toBeUndefined();
  });

  it('falls back to most-recent team entries when caller has no recent activity', async () => {
    await saveContextAs('alice', 'entry-a', 'first', ['x']);
    await saveContextAs('carol', 'entry-b', 'second', ['y']);
    await saveContextAs('carol', 'entry-c', 'third', ['z']);

    // bob has never broadcast or saved
    const data = await getUpdates('bob');
    expect(data.recommended_context).toBeDefined();
    expect(data.recommended_context!.length).toBeGreaterThan(0);
    // Most-recent first
    expect(data.recommended_context![0].key).toBe('entry-c');
  });

  it('returns an empty array when no context entries exist', async () => {
    await broadcastAs('bob', 'hello', ['anything']);

    const data = await getUpdates('bob');
    expect(data.recommended_context).toBeDefined();
    expect(data.recommended_context).toEqual([]);
  });

  it('caps recommendations at 5 and truncates preview to 200 chars', async () => {
    const longValue = 'x'.repeat(500);
    for (let i = 0; i < 7; i++) {
      await saveContextAs('alice', `entry-${i}`, longValue, ['shared']);
    }
    await broadcastAs('bob', 'working on shared stuff', ['shared']);

    const data = await getUpdates('bob');
    expect(data.recommended_context!.length).toBeLessThanOrEqual(5);
    for (const rec of data.recommended_context!) {
      expect(rec.preview.length).toBeLessThanOrEqual(200);
    }
  });
});
