import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

async function createTask(ctx: TestContext, body: Record<string, unknown>) {
  const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
    headers: authHeaders(ctx.apiKey),
    body,
  });
  return res.json();
}

describe('Task Graph', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('returns empty graph when there are no tasks', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/tasks/graph', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ nodes: [], edges: [] });
  });

  it('returns nodes and edges for a graph with dependencies', async () => {
    const a = await createTask(ctx, { description: 'A', status: 'open' });
    const b = await createTask(ctx, { description: 'B', status: 'open' });
    const c = await createTask(ctx, {
      description: 'C',
      status: 'open',
      depends_on: [a.task_id, b.task_id],
    });

    const res = await request(ctx.app, 'GET', '/api/v1/tasks/graph', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(3);
    const ids = body.nodes.map((n: { id: number }) => n.id).sort();
    expect(ids).toEqual([a.task_id, b.task_id, c.task_id].sort());
    expect(body.edges).toHaveLength(2);
    expect(body.edges).toContainEqual({ from: a.task_id, to: c.task_id });
    expect(body.edges).toContainEqual({ from: b.task_id, to: c.task_id });

    // Node shape
    const node = body.nodes.find((n: { id: number }) => n.id === a.task_id);
    expect(node).toMatchObject({
      id: a.task_id,
      description: 'A',
      status: 'open',
      priority: 'P2',
    });
    expect(node).toHaveProperty('assignedTo');
    expect(node).toHaveProperty('claimedBy');
    expect(node).toHaveProperty('createdAt');
  });

  it('filters by status and prunes dangling edges', async () => {
    const a = await createTask(ctx, { description: 'A' }); // claimed by creator
    // Complete A
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${a.task_id}`, {
      headers: authHeaders(ctx.apiKey),
      body: { status: 'completed', result: 'done', version: 1 },
    });
    const b = await createTask(ctx, {
      description: 'B',
      status: 'open',
      depends_on: [a.task_id],
    });

    const res = await request(ctx.app, 'GET', '/api/v1/tasks/graph?status=open', {
      headers: authHeaders(ctx.apiKey),
    });
    const body = await res.json();
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].id).toBe(b.task_id);
    // Edge pruned because A is not in the filtered node set
    expect(body.edges).toEqual([]);
  });

  it('filters by workflow_run_id', async () => {
    const a = await createTask(ctx, { description: 'A', status: 'open' });
    const b = await createTask(ctx, { description: 'B', status: 'open' });
    const c = await createTask(ctx, { description: 'C', status: 'open' });

    // Build a workflow_run that includes only A and B
    ctx.rawDb.prepare(
      "INSERT INTO workflow_runs (workspace_id, playbook_name, started_by, task_ids, status) VALUES (?, ?, ?, ?, 'running')"
    ).run(ctx.workspaceId, 'pb', 'alice', JSON.stringify([a.task_id, b.task_id]));
    const wrId = ctx.rawDb.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };

    // Add a dep A -> B and A -> C
    ctx.rawDb.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)')
      .run(b.task_id, a.task_id);
    ctx.rawDb.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)')
      .run(c.task_id, a.task_id);

    const res = await request(
      ctx.app,
      'GET',
      `/api/v1/tasks/graph?workflow_run_id=${wrId.id}`,
      { headers: authHeaders(ctx.apiKey) },
    );
    const body = await res.json();
    expect(body.nodes).toHaveLength(2);
    const ids = body.nodes.map((n: { id: number }) => n.id).sort();
    expect(ids).toEqual([a.task_id, b.task_id].sort());
    // Only the edge within the filtered set survives
    expect(body.edges).toEqual([{ from: a.task_id, to: b.task_id }]);
  });

  it('caps node count by limit', async () => {
    for (let i = 0; i < 5; i++) {
      await createTask(ctx, { description: `T${i}`, status: 'open' });
    }

    const res = await request(ctx.app, 'GET', '/api/v1/tasks/graph?limit=3', {
      headers: authHeaders(ctx.apiKey),
    });
    const body = await res.json();
    expect(body.nodes).toHaveLength(3);
  });
});
