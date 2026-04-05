import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('Inbound endpoints — CRUD (management)', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });

  it('creates an endpoint and returns a 32-char endpoint_key', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/inbound', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: {
        name: 'github-star',
        action_type: 'broadcast_event',
        action_config: { event_type: 'BROADCAST', tags: ['github'] },
      },
    });
    expect(res.status).toBe(201);
    const ep = await res.json();
    expect(ep.name).toBe('github-star');
    expect(ep.actionType).toBe('broadcast_event');
    expect(ep.endpointKey).toMatch(/^[a-f0-9]{32}$/);
    expect(ep.active).toBe(true);
    expect(ep.teamId).toBe(ctx.teamId);
  });

  it('rejects invalid action_type', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/inbound', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { name: 'x', action_type: 'bogus' },
    });
    expect(res.status).toBe(400);
  });

  it('requires a name', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/inbound', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { action_type: 'create_task' },
    });
    expect(res.status).toBe(400);
  });

  it('lists endpoints for the team', async () => {
    await request(ctx.app, 'POST', '/api/v1/inbound', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { name: 'a', action_type: 'save_context' },
    });
    await request(ctx.app, 'POST', '/api/v1/inbound', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { name: 'b', action_type: 'broadcast_event' },
    });
    const res = await request(ctx.app, 'GET', '/api/v1/inbound', {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.endpoints.map((e: { name: string }) => e.name).sort()).toEqual(['a', 'b']);
  });

  it('deletes an endpoint', async () => {
    const createRes = await request(ctx.app, 'POST', '/api/v1/inbound', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: { name: 'del', action_type: 'broadcast_event' },
    });
    const ep = await createRes.json();
    const delRes = await request(ctx.app, 'DELETE', `/api/v1/inbound/${ep.id}`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    expect(delRes.status).toBe(200);
    const body = await delRes.json();
    expect(body.deleted).toBe(true);
  });

  it('returns 404 when deleting a non-existent endpoint', async () => {
    const res = await request(ctx.app, 'DELETE', '/api/v1/inbound/99999', {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    expect(res.status).toBe(404);
  });

  it('requires auth for management endpoints', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/inbound', {
      headers: { 'Content-Type': 'application/json' },
      body: { name: 'x', action_type: 'broadcast_event' },
    });
    expect(res.status).toBe(401);
  });
});

describe('Inbound endpoints — receiver', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });

  async function createEndpoint(body: Record<string, unknown>) {
    const res = await request(ctx.app, 'POST', '/api/v1/inbound', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body,
    });
    return res.json();
  }

  it('returns 404 for an unknown endpoint_key', async () => {
    const res = await request(
      ctx.app,
      'POST',
      '/api/v1/inbound/deadbeefdeadbeefdeadbeefdeadbeef',
      { headers: { 'Content-Type': 'application/json' }, body: {} },
    );
    expect(res.status).toBe(404);
  });

  it('receiver does not require Authorization header (public)', async () => {
    const ep = await createEndpoint({
      name: 'public-ping',
      action_type: 'broadcast_event',
      action_config: { event_type: 'BROADCAST', tags: ['ping'] },
    });
    const res = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: { message: 'hello' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.action_taken.action).toBe('broadcast_event');
    expect(typeof data.action_taken.event_id).toBe('number');
  });

  it('create_task action creates a task from payload.description', async () => {
    const ep = await createEndpoint({
      name: 'bug-intake',
      action_type: 'create_task',
    });
    const res = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: { description: 'Fix the login bug' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action_taken.action).toBe('create_task');
    const taskId = data.action_taken.task_id;

    // Verify task exists via authenticated API
    const taskRes = await request(ctx.app, 'GET', `/api/v1/tasks/${taskId}`, {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    expect(taskRes.status).toBe(200);
    const task = await taskRes.json();
    expect(task.description).toBe('Fix the login bug');
    expect(task.status).toBe('open');
  });

  it('create_task supports description_template substitution', async () => {
    const ep = await createEndpoint({
      name: 'tpl',
      action_type: 'create_task',
      action_config: {
        description_template: 'Ticket {{ticket.id}}: {{ticket.title}}',
      },
    });
    const res = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: { ticket: { id: 'T-42', title: 'broken' } },
    });
    const data = await res.json();
    const taskRes = await request(
      ctx.app,
      'GET',
      `/api/v1/tasks/${data.action_taken.task_id}`,
      { headers: authHeaders(ctx.apiKey, 'alice') },
    );
    const task = await taskRes.json();
    expect(task.description).toBe('Ticket T-42: broken');
  });

  it('save_context action persists payload.value with configured key', async () => {
    const ep = await createEndpoint({
      name: 'metric-saver',
      action_type: 'save_context',
      action_config: { key: 'metric-{{source}}', tags: ['metric'] },
    });
    const res = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: { source: 'cron', value: '42' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action_taken.action).toBe('save_context');
    expect(data.action_taken.key).toBe('metric-cron');

    const ctxRes = await request(
      ctx.app,
      'GET',
      '/api/v1/context?tags=metric',
      { headers: authHeaders(ctx.apiKey, 'alice') },
    );
    const entries = await ctxRes.json();
    expect(entries.entries.length).toBeGreaterThan(0);
    expect(entries.entries[0].value).toBe('42');
  });

  it('run_playbook action runs a playbook with vars_from_payload', async () => {
    // Define a playbook first
    await request(ctx.app, 'POST', '/api/v1/playbooks', {
      headers: authHeaders(ctx.apiKey, 'alice'),
      body: {
        name: 'incident-response',
        description: 'respond to incident',
        tasks: [
          { description: 'Triage {{vars.title}} at severity {{vars.severity}}' },
          { description: 'Post-mortem for {{vars.title}}' },
        ],
      },
    });

    const ep = await createEndpoint({
      name: 'pager',
      action_type: 'run_playbook',
      action_config: {
        playbook_name: 'incident-response',
        vars_from_payload: ['title', 'severity'],
      },
    });

    const res = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: { title: 'DB down', severity: 'P1', extra: 'ignored' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action_taken.action).toBe('run_playbook');
    expect(data.action_taken.created_task_ids).toHaveLength(2);
    expect(typeof data.action_taken.workflow_run_id).toBe('number');

    // Verify tasks were created with vars substituted
    const tasksRes = await request(ctx.app, 'GET', '/api/v1/tasks?status=open', {
      headers: authHeaders(ctx.apiKey, 'alice'),
    });
    const tasksData = await tasksRes.json();
    const descs = tasksData.tasks.map((t: { description: string }) => t.description).sort();
    expect(descs).toEqual([
      'Post-mortem for DB down',
      'Triage DB down at severity P1',
    ]);
  });

  it('run_playbook action fails with 400 when playbook_name is missing', async () => {
    const ep = await createEndpoint({
      name: 'bad-pager',
      action_type: 'run_playbook',
      action_config: {},
    });
    const res = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('verifies HMAC signature when secret is set', async () => {
    const ep = await createEndpoint({
      name: 'signed',
      action_type: 'broadcast_event',
      hmac_secret: 'super-secret-value',
    });
    const body = JSON.stringify({ message: 'authenticated' });

    // Without signature → 401
    const noSig = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.parse(body),
    });
    expect(noSig.status).toBe(401);

    // With valid signature → 200
    const withSig = await ctx.app.request(`/api/v1/inbound/${ep.endpointKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentHub-Signature': sign('super-secret-value', body),
      },
      body,
    });
    expect(withSig.status).toBe(200);

    // With wrong signature → 401
    const badSig = await ctx.app.request(`/api/v1/inbound/${ep.endpointKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentHub-Signature': 'sha256=deadbeef',
      },
      body,
    });
    expect(badSig.status).toBe(401);
  });

  it('returns 404 when endpoint is disabled (via direct DB update)', async () => {
    const ep = await createEndpoint({
      name: 'toggle',
      action_type: 'broadcast_event',
    });
    ctx.db
      .prepare('UPDATE inbound_endpoints SET active = 0 WHERE id = ?')
      .run(ep.id);
    const res = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: {},
    });
    expect(res.status).toBe(404);
  });

  it('rejects non-JSON bodies', async () => {
    const ep = await createEndpoint({
      name: 'strict',
      action_type: 'broadcast_event',
    });
    const res = await ctx.app.request(`/api/v1/inbound/${ep.endpointKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects create_task without description or template', async () => {
    const ep = await createEndpoint({
      name: 'needs-desc',
      action_type: 'create_task',
    });
    const res = await request(ctx.app, 'POST', `/api/v1/inbound/${ep.endpointKey}`, {
      headers: { 'Content-Type': 'application/json' },
      body: { foo: 'bar' },
    });
    expect(res.status).toBe(400);
  });
});
