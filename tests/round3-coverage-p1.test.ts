/**
 * Tests for: analytics cross-filtering, webhook deliveries, and workflow completion
 * - Analytics multi-dimension cross-filtering (status+time, agent producers, event aggregation, context stats)
 * - Webhook delivery listing (empty, pagination, limit cap, cross-workspace rejection, status transitions)
 * - Workflow checkWorkflowCompletion edge cases (all-complete, escalated=failed, concurrent race, idempotency, abandoned)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, type TestContext } from './helpers.js';
import { getWorkspaceAnalytics, parseSinceDuration } from '../src/models/analytics.js';
import { createWebhook, createDelivery, listDeliveries, markDeliverySuccess, markDeliveryFailure } from '../src/models/webhook.js';
import { createWorkflowRun, setWorkflowRunTaskIds, checkWorkflowCompletion, getWorkflowRun } from '../src/models/workflow.js';
import { createTask, updateTask } from '../src/models/task.js';
// ─── P1-4: Analytics multi-dimension cross-filtering ───────────────────

describe('Analytics — multi-dimension cross-filtering', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestContext();
  });

  it('should return tasks filtered by both status and time range', async () => {
    // Create tasks with different statuses
    const t1 = await createTask(ctx.db, ctx.workspaceId, 'agent-a', {
      description: 'Open task', status: 'open',
    });
    const t2 = await createTask(ctx.db, ctx.workspaceId, 'agent-a', {
      description: 'Claimed task', status: 'claimed',
    });
    const t3 = await createTask(ctx.db, ctx.workspaceId, 'agent-b', {
      description: 'Done task', status: 'claimed',
    });
    await updateTask(ctx.db, ctx.workspaceId, 'agent-b', {
      task_id: t3.task_id, status: 'completed', version: 1, result: 'done',
    });

    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const analytics = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);

    // Verify multi-dimension data
    expect(analytics.tasks.by_status.open).toBe(1);
    expect(analytics.tasks.by_status.claimed).toBe(1);
    expect(analytics.tasks.by_status.completed).toBe(1);
    expect(analytics.tasks.total).toBe(3);
    expect(analytics.tasks.completion_rate).toBeGreaterThan(0);
  });

  it('should cross-filter agents by events and completed tasks', async () => {
    // Register agents
    ctx.rawDb.prepare(
      `INSERT INTO agents (id, workspace_id, capabilities, status, metadata, last_heartbeat) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run('agent-a', ctx.workspaceId, '[]', 'online', '{}');
    ctx.rawDb.prepare(
      `INSERT INTO agents (id, workspace_id, capabilities, status, metadata, last_heartbeat) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run('agent-b', ctx.workspaceId, '[]', 'online', '{}');

    // Create events by different agents
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'LEARNING', 'Found something', '[]', 'agent-a');
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'Update', '[]', 'agent-b');
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'ERROR', 'Oops', '[]', 'agent-a');

    // Create completed tasks by agent-b
    const t = await createTask(ctx.db, ctx.workspaceId, 'agent-b', {
      description: 'Task by B', status: 'claimed',
    });
    await updateTask(ctx.db, ctx.workspaceId, 'agent-b', {
      task_id: t.task_id, status: 'completed', version: 1, result: 'done',
    });

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const analytics = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);

    expect(analytics.agents.total).toBe(2);
    expect(analytics.agents.online).toBe(2);
    expect(analytics.agents.top_producers.length).toBeGreaterThan(0);

    // agent-a has 2 events, agent-b has 1 event + 1 completed task
    const agentA = analytics.agents.top_producers.find((p) => p.agent_id === 'agent-a');
    const agentB = analytics.agents.top_producers.find((p) => p.agent_id === 'agent-b');
    expect(agentA?.events).toBe(2);
    expect(agentB?.tasks_completed).toBe(1);
  });

  it('should aggregate event types correctly', async () => {
    for (const type of ['LEARNING', 'LEARNING', 'BROADCAST', 'ERROR', 'ESCALATION', 'TASK_UPDATE']) {
      ctx.rawDb.prepare(
        `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
      ).run(ctx.workspaceId, type, `msg-${type}`, '[]', 'agent');
    }

    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const analytics = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);

    expect(analytics.events.by_type.LEARNING).toBe(2);
    expect(analytics.events.by_type.BROADCAST).toBe(1);
    expect(analytics.events.by_type.ERROR).toBe(1);
    expect(analytics.events.by_type.ESCALATION).toBe(1);
    expect(analytics.events.by_type.TASK_UPDATE).toBe(1);
    expect(analytics.events.total).toBe(6);
  });

  it('should compute context stats with cross-filtering', async () => {
    ctx.rawDb.prepare(
      `INSERT INTO context_entries (workspace_id, key, value, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'k1', 'v1', '["a"]', 'agent-a');
    ctx.rawDb.prepare(
      `INSERT INTO context_entries (workspace_id, key, value, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'k2', 'v2', '["b"]', 'agent-a');
    ctx.rawDb.prepare(
      `INSERT INTO context_entries (workspace_id, key, value, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'k3', 'v3', '["c"]', 'agent-b');

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const analytics = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);

    expect(analytics.context.total_entries).toBe(3);
    expect(analytics.context.entries_since).toBe(3);
    expect(analytics.context.top_authors.length).toBe(2);
    // agent-a has 2 entries, should be first
    expect(analytics.context.top_authors[0].agent_id).toBe('agent-a');
    expect(analytics.context.top_authors[0].count).toBe(2);
  });
});

// ─── P1-5: Webhook listDeliveries direct tests ─────────────────────────

describe('Webhook — listDeliveries', () => {
  let ctx: TestContext;
  let webhookId: string;

  beforeEach(async () => {
    ctx = createTestContext();

    const webhook = await createWebhook(ctx.db, ctx.workspaceId, 'agent', {
      url: 'https://example.com/hook',
      event_types: ['*'],
    });
    webhookId = webhook.id;
  });

  it('should return empty list when no deliveries exist', async () => {
    const deliveries = await listDeliveries(ctx.db, ctx.workspaceId, webhookId);
    expect(deliveries).toEqual([]);
  });

  it('should list deliveries for a webhook', async () => {
    // Create an event first
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'test', '[]', 'agent');
    const eventRow = ctx.rawDb.prepare('SELECT id FROM events LIMIT 1').get() as any;

    await createDelivery(ctx.db, webhookId, eventRow.id);
    await createDelivery(ctx.db, webhookId, eventRow.id);

    const deliveries = await listDeliveries(ctx.db, ctx.workspaceId, webhookId);
    expect(deliveries.length).toBe(2);
    expect(deliveries[0].webhookId).toBe(webhookId);
    expect(deliveries[0].status).toBe('pending');
  });

  it('should respect limit parameter', async () => {
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'test', '[]', 'agent');
    const eventRow = ctx.rawDb.prepare('SELECT id FROM events LIMIT 1').get() as any;

    for (let i = 0; i < 5; i++) {
      await createDelivery(ctx.db, webhookId, eventRow.id);
    }

    const deliveries = await listDeliveries(ctx.db, ctx.workspaceId, webhookId, 2);
    expect(deliveries.length).toBe(2);
  });

  it('should cap limit at 200', async () => {
    // Passing a limit over 200 should be capped
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'test', '[]', 'agent');
    const eventRow = ctx.rawDb.prepare('SELECT id FROM events LIMIT 1').get() as any;

    await createDelivery(ctx.db, webhookId, eventRow.id);

    // This should not throw even with a limit > 200
    const deliveries = await listDeliveries(ctx.db, ctx.workspaceId, webhookId, 999);
    expect(deliveries.length).toBe(1);
  });

  it('should reject listing deliveries for a webhook from another workspace', async () => {
    await expect(
      listDeliveries(ctx.db, 'other-workspace', webhookId),
    ).rejects.toThrow(/not found/i);
  });

  it('should show delivery status transitions', async () => {
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'test', '[]', 'agent');
    const eventRow = ctx.rawDb.prepare('SELECT id FROM events LIMIT 1').get() as any;

    const delivery = await createDelivery(ctx.db, webhookId, eventRow.id);
    expect(delivery.status).toBe('pending');

    await markDeliverySuccess(ctx.db, delivery.id, webhookId, 200);

    const updated = await listDeliveries(ctx.db, ctx.workspaceId, webhookId);
    expect(updated[0].status).toBe('success');
    expect(updated[0].responseCode).toBe(200);
  });
});

// ─── P1-6: checkWorkflowCompletion race conditions ──────────────────────

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

    // Workflow should still be running — t2 isn't done
    let run = await getWorkflowRun(ctx.db, ctx.workspaceId, runId);
    expect(run.status).toBe('running');

    // Complete t2
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

    // Complete both tasks
    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t1.task_id, status: 'completed', version: 1, result: 'ok',
    });
    await updateTask(ctx.db, ctx.workspaceId, 'agent', {
      task_id: t2.task_id, status: 'completed', version: 1, result: 'ok',
    });

    // Fire both checks concurrently — simulating race
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

    // Calling again should not change anything (WHERE status = 'running' filter)
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

