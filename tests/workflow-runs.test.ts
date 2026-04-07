import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Workflow runs API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  async function definePlaybook(
    headers: Record<string, string>,
    name: string,
    tasks: Array<{ description: string }>,
  ): Promise<void> {
    await request(ctx.app, 'POST', '/api/v1/playbooks', {
      headers,
      body: { name, description: `desc ${name}`, tasks },
    });
  }

  async function runPlaybook(
    headers: Record<string, string>,
    name: string,
  ): Promise<{ workflow_run_id: number; created_task_ids: number[] }> {
    const res = await request(ctx.app, 'POST', `/api/v1/playbooks/${name}/run`, { headers });
    expect(res.status).toBe(201);
    return res.json();
  }

  it('running a playbook creates a workflow_run with task_ids', async () => {
    const headers = authHeaders(ctx.apiKey);
    await definePlaybook(headers, 'wf1', [
      { description: 'a' },
      { description: 'b' },
    ]);

    const { workflow_run_id, created_task_ids } = await runPlaybook(headers, 'wf1');
    expect(workflow_run_id).toBeGreaterThan(0);
    expect(created_task_ids).toHaveLength(2);

    const getRes = await request(ctx.app, 'GET', `/api/v1/workflow-runs/${workflow_run_id}`, { headers });
    expect(getRes.status).toBe(200);
    const run = await getRes.json();
    expect(run.id).toBe(workflow_run_id);
    expect(run.playbookName).toBe('wf1');
    expect(run.status).toBe('running');
    expect(run.taskIds).toEqual(created_task_ids);
    expect(run.tasks).toHaveLength(2);
    expect(run.completedAt).toBeNull();
  });

  it('completing all tasks marks workflow completed', async () => {
    const headers = authHeaders(ctx.apiKey);
    await definePlaybook(headers, 'wf-complete', [
      { description: 'a' },
      { description: 'b' },
    ]);
    const { workflow_run_id, created_task_ids } = await runPlaybook(headers, 'wf-complete');

    for (const id of created_task_ids) {
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${id}`, {
        headers,
        body: { status: 'claimed', version: 1 },
      });
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${id}`, {
        headers,
        body: { status: 'completed', result: 'ok', version: 2 },
      });
    }

    const getRes = await request(ctx.app, 'GET', `/api/v1/workflow-runs/${workflow_run_id}`, { headers });
    const run = await getRes.json();
    expect(run.status).toBe('completed');
    expect(run.completedAt).not.toBeNull();
  });

  it('escalated task marks workflow failed', async () => {
    const headers = authHeaders(ctx.apiKey);
    await definePlaybook(headers, 'wf-fail', [
      { description: 'a' },
      { description: 'b' },
    ]);
    const { workflow_run_id, created_task_ids } = await runPlaybook(headers, 'wf-fail');
    const [id1, id2] = created_task_ids;

    // Complete one
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${id1}`, {
      headers, body: { status: 'claimed', version: 1 },
    });
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${id1}`, {
      headers, body: { status: 'completed', result: 'ok', version: 2 },
    });

    // Escalate the other
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${id2}`, {
      headers, body: { status: 'claimed', version: 1 },
    });
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${id2}`, {
      headers, body: { status: 'escalated', result: 'stuck', version: 2 },
    });

    const getRes = await request(ctx.app, 'GET', `/api/v1/workflow-runs/${workflow_run_id}`, { headers });
    const run = await getRes.json();
    expect(run.status).toBe('failed');
    expect(run.completedAt).not.toBeNull();
  });

  it('abandoned task marks workflow failed once all terminal', async () => {
    const headers = authHeaders(ctx.apiKey);
    await definePlaybook(headers, 'wf-abandon', [{ description: 'only' }]);
    const { workflow_run_id, created_task_ids } = await runPlaybook(headers, 'wf-abandon');
    const [id] = created_task_ids;

    await request(ctx.app, 'PATCH', `/api/v1/tasks/${id}`, {
      headers, body: { status: 'claimed', version: 1 },
    });
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${id}`, {
      headers, body: { status: 'abandoned', version: 2 },
    });

    const getRes = await request(ctx.app, 'GET', `/api/v1/workflow-runs/${workflow_run_id}`, { headers });
    const run = await getRes.json();
    expect(run.status).toBe('failed');
  });

  it('workflow stays running while some tasks are still open', async () => {
    const headers = authHeaders(ctx.apiKey);
    await definePlaybook(headers, 'wf-partial', [
      { description: 'a' },
      { description: 'b' },
    ]);
    const { workflow_run_id, created_task_ids } = await runPlaybook(headers, 'wf-partial');
    const [id1] = created_task_ids;

    await request(ctx.app, 'PATCH', `/api/v1/tasks/${id1}`, {
      headers, body: { status: 'claimed', version: 1 },
    });
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${id1}`, {
      headers, body: { status: 'completed', result: 'ok', version: 2 },
    });

    const getRes = await request(ctx.app, 'GET', `/api/v1/workflow-runs/${workflow_run_id}`, { headers });
    const run = await getRes.json();
    expect(run.status).toBe('running');
    expect(run.completedAt).toBeNull();
  });

  it('list filters by status', async () => {
    const headers = authHeaders(ctx.apiKey);
    await definePlaybook(headers, 'pa', [{ description: 'only' }]);
    await definePlaybook(headers, 'pb', [{ description: 'only' }]);

    const run1 = await runPlaybook(headers, 'pa');
    const run2 = await runPlaybook(headers, 'pb');

    // Complete run1
    const [t1] = run1.created_task_ids;
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${t1}`, {
      headers, body: { status: 'claimed', version: 1 },
    });
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${t1}`, {
      headers, body: { status: 'completed', result: 'ok', version: 2 },
    });

    const listRunning = await request(ctx.app, 'GET', '/api/v1/workflow-runs?status=running', { headers });
    const runningData = await listRunning.json();
    expect(runningData.total).toBe(1);
    expect(runningData.workflow_runs[0].id).toBe(run2.workflow_run_id);

    const listCompleted = await request(ctx.app, 'GET', '/api/v1/workflow-runs?status=completed', { headers });
    const completedData = await listCompleted.json();
    expect(completedData.total).toBe(1);
    expect(completedData.workflow_runs[0].id).toBe(run1.workflow_run_id);

    const listAll = await request(ctx.app, 'GET', '/api/v1/workflow-runs', { headers });
    const allData = await listAll.json();
    expect(allData.total).toBe(2);
    expect(allData.workflow_runs[0].taskCount).toBe(1);
  });

  it('returns 404 for unknown workflow run', async () => {
    const headers = authHeaders(ctx.apiKey);
    const res = await request(ctx.app, 'GET', '/api/v1/workflow-runs/999', { headers });
    expect(res.status).toBe(404);
  });
});
