import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import {
  createWorkflowRun,
  setWorkflowRunTaskIds,
  getWorkflowRun,
  cancelWorkflowRun,
} from '../src/models/workflow.js';
import { createTask } from '../src/models/task.js';
import { definePlaybook, runPlaybook } from '../src/models/playbook.js';
import { registerAgent, listAgents } from '../src/models/agent.js';

// ─── Feature 1: cancel_workflow_run ─────────────────────────────

describe('cancelWorkflowRun', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('cancels a running workflow and abandons non-terminal tasks', async () => {
    // Set up playbook and run it
    await definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
      name: 'cancel-test',
      description: 'test playbook',
      tasks: [{ description: 'task A' }, { description: 'task B' }, { description: 'task C' }],
    });
    const { workflow_run_id, created_task_ids } = await runPlaybook(
      ctx.db, ctx.workspaceId, 'agent', 'cancel-test',
    );

    // Claim one task (leave others open)
    const [t1] = created_task_ids;
    await ctx.db.run(
      "UPDATE tasks SET status = 'claimed', claimed_by = 'agent' WHERE id = ?", t1,
    );

    // Cancel the workflow
    const result = await cancelWorkflowRun(ctx.db, ctx.workspaceId, 'cancel-agent', workflow_run_id);

    expect(result.workflow_run_id).toBe(workflow_run_id);
    expect(result.status).toBe('failed');
    expect(result.cancelled_tasks).toBe(3); // all 3 were open or claimed

    // Verify run status
    const run = await getWorkflowRun(ctx.db, ctx.workspaceId, workflow_run_id);
    expect(run.status).toBe('failed');
    expect(run.completedAt).not.toBeNull();

    // Verify all tasks are abandoned
    for (const task of run.tasks) {
      expect(task.status).toBe('abandoned');
    }
  });

  it('does not abandon already-completed tasks', async () => {
    await definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
      name: 'partial-cancel',
      description: 'test',
      tasks: [{ description: 'task A' }, { description: 'task B' }],
    });
    const { workflow_run_id, created_task_ids } = await runPlaybook(
      ctx.db, ctx.workspaceId, 'agent', 'partial-cancel',
    );
    const [t1, t2] = created_task_ids;

    // Complete t1
    await ctx.db.run("UPDATE tasks SET status = 'claimed', version = 2 WHERE id = ?", t1);
    await ctx.db.run("UPDATE tasks SET status = 'completed', result = 'done', version = 3 WHERE id = ?", t1);

    const result = await cancelWorkflowRun(ctx.db, ctx.workspaceId, 'agent', workflow_run_id);
    expect(result.cancelled_tasks).toBe(1); // only t2 was open

    const run = await getWorkflowRun(ctx.db, ctx.workspaceId, workflow_run_id);
    const t1Status = run.tasks.find((t) => t.id === t1)?.status;
    const t2Status = run.tasks.find((t) => t.id === t2)?.status;
    expect(t1Status).toBe('completed');
    expect(t2Status).toBe('abandoned');
  });

  it('throws when cancelling an already-completed run', async () => {
    const runId = await createWorkflowRun(ctx.db, ctx.workspaceId, 'test-pb', 'agent');
    const t = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'only', status: 'open',
    });
    await setWorkflowRunTaskIds(ctx.db, runId, [t.task_id]);

    // Mark run as completed directly
    await ctx.db.run(
      "UPDATE workflow_runs SET status = 'completed', completed_at = ? WHERE id = ?",
      new Date().toISOString(), runId,
    );

    await expect(
      cancelWorkflowRun(ctx.db, ctx.workspaceId, 'agent', runId),
    ).rejects.toThrow(/already completed/);
  });

  it('throws when cancelling a non-existent run', async () => {
    await expect(
      cancelWorkflowRun(ctx.db, ctx.workspaceId, 'agent', 99999),
    ).rejects.toThrow(/not found/i);
  });

  it('works via REST API POST /workflow-runs/:id/cancel', async () => {
    const headers = authHeaders(ctx.apiKey);

    // Create playbook and run via REST
    await request(ctx.app, 'POST', '/api/v1/playbooks', {
      headers,
      body: { name: 'rest-cancel', description: 'test', tasks: [{ description: 'step 1' }] },
    });
    const runRes = await request(ctx.app, 'POST', '/api/v1/playbooks/rest-cancel/run', { headers });
    expect(runRes.status).toBe(201);
    const { workflow_run_id } = await runRes.json();

    // Cancel via REST
    const cancelRes = await request(ctx.app, 'POST', `/api/v1/workflow-runs/${workflow_run_id}/cancel`, { headers });
    expect(cancelRes.status).toBe(200);
    const body = await cancelRes.json();
    expect(body.status).toBe('failed');
    expect(body.cancelled_tasks).toBe(1);
  });
});

// ─── Feature 2: Agent discovery filters ─────────────────────────

describe('Agent discovery filters', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('filters by active_within_minutes', async () => {
    // Register two agents
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'recent-agent',
      capabilities: ['code'],
      metadata: {},
    });
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'stale-agent',
      capabilities: ['code'],
      metadata: {},
    });

    // Make stale-agent's heartbeat old
    const oldTime = new Date(Date.now() - 120 * 60 * 1000).toISOString(); // 2 hours ago
    await ctx.db.run(
      'UPDATE agents SET last_heartbeat = ? WHERE id = ? AND workspace_id = ?',
      oldTime, 'stale-agent', ctx.workspaceId,
    );

    // Filter for agents active within 60 minutes
    const result = await listAgents(ctx.db, ctx.workspaceId, { active_within_minutes: 60 });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe('recent-agent');

    // Without filter, both are returned
    const allResult = await listAgents(ctx.db, ctx.workspaceId, {});
    expect(allResult.agents).toHaveLength(2);
  });

  it('filters by metadata_contains', async () => {
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'python-agent',
      capabilities: [],
      metadata: { language: 'python', team: 'backend' },
    });
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'js-agent',
      capabilities: [],
      metadata: { language: 'javascript', team: 'frontend' },
    });

    const result = await listAgents(ctx.db, ctx.workspaceId, { metadata_contains: 'python' });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe('python-agent');

    const backendResult = await listAgents(ctx.db, ctx.workspaceId, { metadata_contains: 'backend' });
    expect(backendResult.agents).toHaveLength(1);
    expect(backendResult.agents[0].id).toBe('python-agent');
  });

  it('combines filters', async () => {
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'match-agent',
      capabilities: ['review'],
      status: 'online',
      metadata: { role: 'reviewer' },
    });
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'no-match-agent',
      capabilities: ['review'],
      status: 'offline',
      metadata: { role: 'reviewer' },
    });

    const result = await listAgents(ctx.db, ctx.workspaceId, {
      status: 'online',
      metadata_contains: 'reviewer',
      active_within_minutes: 60,
    });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe('match-agent');
  });

  it('works via REST API with query params', async () => {
    const headers = authHeaders(ctx.apiKey);

    // Register agents via REST
    await request(ctx.app, 'POST', '/api/v1/agents', {
      headers,
      body: { agent_id: 'rest-agent-1', capabilities: ['code'], metadata: { env: 'production' } },
    });
    await request(ctx.app, 'POST', '/api/v1/agents', {
      headers,
      body: { agent_id: 'rest-agent-2', capabilities: ['code'], metadata: { env: 'staging' } },
    });

    // Filter by metadata_contains
    const res = await request(ctx.app, 'GET', '/api/v1/agents?metadata_contains=production', { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].id).toBe('rest-agent-1');

    // Filter by active_within_minutes
    const res2 = await request(ctx.app, 'GET', '/api/v1/agents?active_within_minutes=60', { headers });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.agents).toHaveLength(2);
  });
});
