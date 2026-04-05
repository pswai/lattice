import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Tasks API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /api/v1/tasks — create_task', () => {
    it('should create a task and auto-claim', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Fix webhook handler' },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.task_id).toBeGreaterThan(0);
      expect(data.status).toBe('claimed');
      expect(data.claimed_by).toBe('test-agent');
    });

    it('should create an open task when status is open', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Available task', status: 'open' },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.status).toBe('open');
      expect(data.claimed_by).toBeNull();
    });

    it('should auto-broadcast TASK_UPDATE event on creation', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers,
        body: { description: 'Test task' },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/events', { headers });
      const data = await res.json();
      const taskEvents = data.events.filter(
        (e: any) => e.eventType === 'TASK_UPDATE' && e.message.includes('Test task'),
      );
      expect(taskEvents.length).toBeGreaterThan(0);
    });

    it('should reject empty description', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: '' },
      });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/v1/tasks/:id — update_task', () => {
    let taskId: number;

    beforeEach(async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Test task for update' },
      });
      const data = await res.json();
      taskId = data.task_id;
    });

    it('should complete a task', async () => {
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${taskId}`, {
        headers: authHeaders(ctx.apiKey),
        body: {
          status: 'completed',
          result: 'Fixed the webhook handler',
          version: 1,
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('completed');
      expect(data.version).toBe(2);
    });

    it('should abandon a task', async () => {
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${taskId}`, {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'abandoned', version: 1 },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('abandoned');
    });

    it('should escalate a task', async () => {
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${taskId}`, {
        headers: authHeaders(ctx.apiKey),
        body: {
          status: 'escalated',
          result: 'Need human review',
          version: 1,
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('escalated');
    });

    it('should return 404 for non-existent task', async () => {
      const res = await request(ctx.app, 'PATCH', '/api/v1/tasks/99999', {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'completed', version: 1 },
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('NOT_FOUND');
    });

    it('should return 400 for invalid task ID', async () => {
      const res = await request(ctx.app, 'PATCH', '/api/v1/tasks/abc', {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'completed', version: 1 },
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid status transition', async () => {
      // Complete the task first
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${taskId}`, {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'completed', result: 'Done', version: 1 },
      });

      // Try to claim a completed task — invalid transition
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${taskId}`, {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'claimed', version: 2 },
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('INVALID_TRANSITION');
    });

    it('should save result as context entry on completion', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${taskId}`, {
        headers,
        body: {
          status: 'completed',
          result: 'Fixed with idempotency key',
          version: 1,
        },
      });

      // Check that context entry was created
      const res = await request(ctx.app, 'GET', `/api/v1/context?query=idempotency`, {
        headers,
      });

      const data = await res.json();
      const taskResult = data.entries.find((e: any) => e.key === `task-result-${taskId}`);
      expect(taskResult).toBeDefined();
      expect(taskResult.value).toBe('Fixed with idempotency key');
    });

    it('should broadcast ESCALATION event on escalation', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${taskId}`, {
        headers,
        body: { status: 'escalated', result: 'Too complex', version: 1 },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/events', { headers });
      const data = await res.json();
      const escalations = data.events.filter((e: any) => e.eventType === 'ESCALATION');
      expect(escalations.length).toBeGreaterThan(0);
    });
  });

  describe('Task state machine', () => {
    it('should allow open → claimed', async () => {
      const headers = authHeaders(ctx.apiKey);

      // Create open task
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers,
        body: { description: 'Open task', status: 'open' },
      });
      const { task_id } = await createRes.json();

      // Claim it
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers,
        body: { status: 'claimed', version: 1 },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('claimed');
    });

    it('should allow claimed → completed', async () => {
      const headers = authHeaders(ctx.apiKey);
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers,
        body: { description: 'Task to complete' },
      });
      const { task_id } = await createRes.json();

      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers,
        body: { status: 'completed', result: 'Done', version: 1 },
      });

      expect(res.status).toBe(200);
    });

    it('should allow claimed → abandoned → claimed (re-claim)', async () => {
      const headers = authHeaders(ctx.apiKey);
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers,
        body: { description: 'Reclaimable task' },
      });
      const { task_id } = await createRes.json();

      // Abandon
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers,
        body: { status: 'abandoned', version: 1 },
      });

      // Re-claim
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers,
        body: { status: 'claimed', version: 2 },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('claimed');
    });

    it('should prevent open → completed (skip claimed)', async () => {
      const headers = authHeaders(ctx.apiKey);
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers,
        body: { description: 'Open task', status: 'open' },
      });
      const { task_id } = await createRes.json();

      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers,
        body: { status: 'completed', version: 1 },
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('INVALID_TRANSITION');
    });
  });

  describe('Optimistic locking', () => {
    it('should reject stale version', async () => {
      const headers = authHeaders(ctx.apiKey);
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers,
        body: { description: 'Lock test' },
      });
      const { task_id } = await createRes.json();

      // First update succeeds
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers,
        body: { status: 'abandoned', version: 1 },
      });

      // Second update with stale version (1) should fail
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers,
        body: { status: 'claimed', version: 1 },
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('TASK_CONFLICT');
      expect(data.details.current_version).toBe(2);
      expect(data.details.your_version).toBe(1);
    });
  });

  describe('Authorization', () => {
    it('should prevent non-claiming agent from completing a task', async () => {
      // Agent A creates and claims
      const headersA = authHeaders(ctx.apiKey, 'agent-a');
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: headersA,
        body: { description: 'Agent A task' },
      });
      const { task_id } = await createRes.json();

      // Agent B tries to complete — should be forbidden
      const headersB = authHeaders(ctx.apiKey, 'agent-b');
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: headersB,
        body: { status: 'completed', result: 'Stolen!', version: 1 },
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('FORBIDDEN');
    });

    it('should allow any agent to claim an open task', async () => {
      const headersA = authHeaders(ctx.apiKey, 'agent-a');
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: headersA,
        body: { description: 'Open for anyone', status: 'open' },
      });
      const { task_id } = await createRes.json();

      // Agent B claims the open task
      const headersB = authHeaders(ctx.apiKey, 'agent-b');
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: headersB,
        body: { status: 'claimed', version: 1 },
      });

      expect(res.status).toBe(200);
    });
  });

  describe('priority and assignment', () => {
    it('should default priority to P2', async () => {
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'No priority set' },
      });
      const { task_id } = await createRes.json();

      const getRes = await request(ctx.app, 'GET', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(ctx.apiKey),
      });
      const task = await getRes.json();
      expect(task.priority).toBe('P2');
      expect(task.assignedTo).toBeNull();
    });

    it('should create task with P0 priority and assigned_to', async () => {
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Urgent', priority: 'P0', assigned_to: 'alice' },
      });
      expect(createRes.status).toBe(201);
      const { task_id } = await createRes.json();

      const getRes = await request(ctx.app, 'GET', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(ctx.apiKey),
      });
      const task = await getRes.json();
      expect(task.priority).toBe('P0');
      expect(task.assignedTo).toBe('alice');
      // Auto-claim should go to the assignee, not the creator — otherwise
      // the assignee cannot complete the task they were handed.
      expect(task.claimedBy).toBe('alice');
    });

    it('should order P0 tasks before P2 in list_tasks', async () => {
      // Create P2 first (earlier created_at)
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Low-prio older', priority: 'P2' },
      });
      // Then a P0
      const p0Res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'High-prio newer', priority: 'P0' },
      });
      const { task_id: p0Id } = await p0Res.json();

      const listRes = await request(ctx.app, 'GET', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
      });
      const { tasks } = await listRes.json();

      expect(tasks.length).toBeGreaterThanOrEqual(2);
      expect(tasks[0].id).toBe(p0Id);
      expect(tasks[0].priority).toBe('P0');
    });

    it('should filter by assigned_to', async () => {
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'For alice', assigned_to: 'alice' },
      });
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'For bob', assigned_to: 'bob' },
      });
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Unassigned' },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/tasks?assigned_to=alice', {
        headers: authHeaders(ctx.apiKey),
      });
      const { tasks } = await res.json();
      expect(tasks.length).toBe(1);
      expect(tasks[0].assignedTo).toBe('alice');
    });

    it('should update priority and assigned_to via PATCH', async () => {
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Will be reprioritized', priority: 'P3' },
      });
      const { task_id } = await createRes.json();

      const patchRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'completed', version: 1, priority: 'P0', assigned_to: 'carol' },
      });
      expect(patchRes.status).toBe(200);

      const getRes = await request(ctx.app, 'GET', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(ctx.apiKey),
      });
      const task = await getRes.json();
      expect(task.priority).toBe('P0');
      expect(task.assignedTo).toBe('carol');
    });

    it('should reject invalid priority value', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Bad prio', priority: 'P9' },
      });
      expect(res.status).toBe(400);
    });
  });
});
