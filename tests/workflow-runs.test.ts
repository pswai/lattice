import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, authHeaders, request, type TestContext } from './helpers.js';
import { createWorkflowRun, setWorkflowRunTaskIds, checkWorkflowCompletion, getWorkflowRun } from '../src/models/workflow.js';
import { createTask, updateTask } from '../src/models/task.js';
import { definePlaybook, runPlaybook } from '../src/models/playbook.js';
import type { SqliteAdapter } from '../src/db/adapter.js';

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

// ─── checkWorkflowCompletion edge cases (from round3-coverage-p1) ─────

describe('Workflow — checkWorkflowCompletion edge cases', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should mark workflow completed when all tasks complete', async () => {
    const runId = await createWorkflowRun(ctx.db, ctx.workspaceId, 'test-pb', 'agent');

    const t1 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Task 1', status: 'claimed',
    });
    const t2 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Task 2', status: 'claimed',
    });
    await setWorkflowRunTaskIds(ctx.db, runId, [t1.task_id, t2.task_id]);

    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t1.task_id, status: 'completed', version: 1, result: 'ok',
    });
    await checkWorkflowCompletion(ctx.db, t1.task_id);

    let run = await getWorkflowRun(ctx.db, ctx.workspaceId, runId);
    expect(run.status).toBe('running');

    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t2.task_id, status: 'completed', version: 1, result: 'ok',
    });
    await checkWorkflowCompletion(ctx.db, t2.task_id);

    run = await getWorkflowRun(ctx.db, ctx.workspaceId, runId);
    expect(run.status).toBe('completed');
    expect(run.completedAt).toBeTruthy();
  });

  it('should mark workflow failed when any task is escalated', async () => {
    const runId = await createWorkflowRun(ctx.db, ctx.workspaceId, 'test-pb', 'agent');

    const t1 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Task 1', status: 'claimed',
    });
    const t2 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Task 2', status: 'claimed',
    });
    await setWorkflowRunTaskIds(ctx.db, runId, [t1.task_id, t2.task_id]);

    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t1.task_id, status: 'escalated', version: 1,
    });
    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t2.task_id, status: 'completed', version: 1, result: 'ok',
    });
    await checkWorkflowCompletion(ctx.db, t2.task_id);

    const run = await getWorkflowRun(ctx.db, ctx.workspaceId, runId);
    expect(run.status).toBe('failed');
  });

  it('should handle concurrent completion checks without double-completing', async () => {
    const runId = await createWorkflowRun(ctx.db, ctx.workspaceId, 'test-pb', 'agent');

    const t1 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Task 1', status: 'claimed',
    });
    const t2 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Task 2', status: 'claimed',
    });
    await setWorkflowRunTaskIds(ctx.db, runId, [t1.task_id, t2.task_id]);

    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t1.task_id, status: 'completed', version: 1, result: 'ok',
    });
    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t2.task_id, status: 'completed', version: 1, result: 'ok',
    });

    await Promise.all([
      checkWorkflowCompletion(ctx.db, t1.task_id),
      checkWorkflowCompletion(ctx.db, t2.task_id),
    ]);

    const run = await getWorkflowRun(ctx.db, ctx.workspaceId, runId);
    expect(run.status).toBe('completed');
  });

  it('should not update an already-completed workflow', async () => {
    const runId = await createWorkflowRun(ctx.db, ctx.workspaceId, 'test-pb', 'agent');

    const t1 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Task 1', status: 'claimed',
    });
    await setWorkflowRunTaskIds(ctx.db, runId, [t1.task_id]);

    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t1.task_id, status: 'completed', version: 1, result: 'ok',
    });
    await checkWorkflowCompletion(ctx.db, t1.task_id);

    const run1 = await getWorkflowRun(ctx.db, ctx.workspaceId, runId);
    expect(run1.status).toBe('completed');
    const completedAt = run1.completedAt;

    await checkWorkflowCompletion(ctx.db, t1.task_id);
    const run2 = await getWorkflowRun(ctx.db, ctx.workspaceId, runId);
    expect(run2.status).toBe('completed');
    expect(run2.completedAt).toBe(completedAt);
  });

  it('should handle workflow with abandoned tasks as failed', async () => {
    const runId = await createWorkflowRun(ctx.db, ctx.workspaceId, 'test-pb', 'agent');

    const t1 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Task 1', status: 'claimed',
    });
    await setWorkflowRunTaskIds(ctx.db, runId, [t1.task_id]);

    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t1.task_id, status: 'abandoned', version: 1,
    });
    await checkWorkflowCompletion(ctx.db, t1.task_id);

    const run = await getWorkflowRun(ctx.db, ctx.workspaceId, runId);
    expect(run.status).toBe('failed');
  });
});

// ─── Workflow race with empty task_ids (from round7-fixes) ────────────

describe('Workflow completes even if task finishes during task_ids window', () => {
  let db: SqliteAdapter;
  const ws = 'test-team';

  beforeEach(() => {
    db = createTestDb();
    setupWorkspace(db, ws);
  });

  it('should complete workflow when task finishes before setWorkflowRunTaskIds', async () => {
    const runId = await createWorkflowRun(db, ws, 'fast-playbook', 'agent');

    const { task_id } = await createTask(db, ws, 'agent', {
      description: 'fast task',
      status: 'claimed',
    });
    await updateTask(db, ws, 'agent', {
      task_id,
      status: 'completed',
      result: 'done fast',
      version: 1,
    });

    await setWorkflowRunTaskIds(db, runId, [task_id]);
    await checkWorkflowCompletion(db, task_id);

    const run = await getWorkflowRun(db, ws, runId);
    expect(run.status).toBe('completed');
    expect(run.completedAt).not.toBeNull();
  });

  it('should mark workflow as failed if task is escalated during race window', async () => {
    const runId = await createWorkflowRun(db, ws, 'fail-playbook', 'agent');

    const { task_id } = await createTask(db, ws, 'agent', {
      description: 'escalated task',
      status: 'claimed',
    });
    await updateTask(db, ws, 'agent', {
      task_id,
      status: 'escalated',
      result: 'cannot handle',
      version: 1,
    });

    await setWorkflowRunTaskIds(db, runId, [task_id]);
    await checkWorkflowCompletion(db, task_id);

    const run = await getWorkflowRun(db, ws, runId);
    expect(run.status).toBe('failed');
  });

  it('should not complete workflow when some tasks are still running', async () => {
    const runId = await createWorkflowRun(db, ws, 'mixed-playbook', 'agent');

    const t1 = await createTask(db, ws, 'agent', { description: 'done', status: 'claimed' });
    const t2 = await createTask(db, ws, 'agent', { description: 'still open', status: 'open' });

    await updateTask(db, ws, 'agent', {
      task_id: t1.task_id,
      status: 'completed',
      result: 'ok',
      version: 1,
    });

    await setWorkflowRunTaskIds(db, runId, [t1.task_id, t2.task_id]);
    await checkWorkflowCompletion(db, t1.task_id);

    const run = await getWorkflowRun(db, ws, runId);
    expect(run.status).toBe('running');
  });

  it('runPlaybook re-checks completion after setWorkflowRunTaskIds (integration)', async () => {
    await definePlaybook(db, ws, 'agent', {
      name: 'one-step',
      description: 'single step playbook',
      tasks: [{ description: 'only step' }],
    });

    const result = await runPlaybook(db, ws, 'agent', 'one-step');
    const taskId = result.created_task_ids[0];

    await updateTask(db, ws, 'agent', {
      task_id: taskId,
      status: 'claimed',
      version: 1,
    });
    await updateTask(db, ws, 'agent', {
      task_id: taskId,
      status: 'completed',
      result: 'done',
      version: 2,
    });

    const run = await getWorkflowRun(db, ws, result.workflow_run_id);
    expect(run.status).toBe('completed');
  });
});
