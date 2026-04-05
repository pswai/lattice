import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupTeam, authHeaders, request, type TestContext } from './helpers.js';
import { createTask, updateTask, getTask } from '../src/models/task.js';
import { getUpdates } from '../src/models/event.js';
import type Database from 'better-sqlite3';

describe('Task Workflow — Full Lifecycle', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should complete full lifecycle: create(open) → claim → complete with result', async () => {
    const headers = authHeaders(ctx.apiKey, 'worker');

    // 1. Create open task
    const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Implement feature X', status: 'open' },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.status).toBe('open');
    expect(created.claimed_by).toBeNull();

    // 2. Claim the task
    const claimRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${created.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    expect(claimRes.status).toBe(200);
    const claimed = await claimRes.json();
    expect(claimed.status).toBe('claimed');
    expect(claimed.version).toBe(2);

    // 3. Complete with result
    const completeRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${created.task_id}`, {
      headers,
      body: { status: 'completed', result: 'Feature X implemented with tests', version: 2 },
    });
    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json();
    expect(completed.status).toBe('completed');
    expect(completed.version).toBe(3);

    // 4. Verify final state
    const getRes = await request(ctx.app, 'GET', `/api/v1/tasks/${created.task_id}`, { headers });
    const task = await getRes.json();
    expect(task.status).toBe('completed');
    expect(task.result).toBe('Feature X implemented with tests');
    expect(task.claimedBy).toBe('worker');
  });

  it('should handle abandon-and-reclaim cycle', async () => {
    const headersA = authHeaders(ctx.apiKey, 'agent-a');
    const headersB = authHeaders(ctx.apiKey, 'agent-b');

    // Agent A creates and claims
    const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers: headersA,
      body: { description: 'Difficult task' },
    });
    const { task_id } = await createRes.json();

    // Agent A abandons
    const abandonRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers: headersA,
      body: { status: 'abandoned', version: 1 },
    });
    expect(abandonRes.status).toBe(200);

    // Agent B picks it up
    const claimRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers: headersB,
      body: { status: 'claimed', version: 2 },
    });
    expect(claimRes.status).toBe(200);

    // Agent B completes it
    const completeRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers: headersB,
      body: { status: 'completed', result: 'Done by agent-b', version: 3 },
    });
    expect(completeRes.status).toBe(200);

    // Verify final state
    const getRes = await request(ctx.app, 'GET', `/api/v1/tasks/${task_id}`, { headers: headersB });
    const task = await getRes.json();
    expect(task.claimedBy).toBe('agent-b');
    expect(task.result).toBe('Done by agent-b');
  });
});

describe('Task Workflow — Dependencies', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should enforce dependency chain: parent must complete before child can be claimed', async () => {
    const headers = authHeaders(ctx.apiKey, 'worker');

    // Create parent task (open)
    const parentRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Build step', status: 'open' },
    });
    const parent = await parentRes.json();

    // Create child task with depends_on (open)
    const childRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: {
        description: 'Deploy step',
        status: 'open',
        depends_on: [parent.task_id],
      },
    });
    const child = await childRes.json();

    // Try to claim child — should fail because parent is open
    const claimFailRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${child.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    expect(claimFailRes.status).toBe(400);
    const error = await claimFailRes.json();
    expect(error.message).toContain('blocked by');

    // Claim and complete parent
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${parent.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${parent.task_id}`, {
      headers,
      body: { status: 'completed', result: 'Build passed', version: 2 },
    });

    // Now claim child — should succeed
    const claimOkRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${child.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    expect(claimOkRes.status).toBe(200);
    const claimed = await claimOkRes.json();
    expect(claimed.status).toBe('claimed');
  });

  it('should block child when parent is claimed but not completed', async () => {
    const headers = authHeaders(ctx.apiKey, 'worker');

    // Create and claim parent (status = claimed, not completed)
    const parentRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Parent task' },
    });
    const parent = await parentRes.json();
    expect(parent.status).toBe('claimed');

    // Create child with dependency
    const childRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: {
        description: 'Child task',
        status: 'open',
        depends_on: [parent.task_id],
      },
    });
    const child = await childRes.json();

    // Try to claim child — should fail, parent only claimed not completed
    const claimRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${child.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    expect(claimRes.status).toBe(400);
  });

  it('should allow multiple dependencies — all must complete', async () => {
    const headers = authHeaders(ctx.apiKey, 'worker');

    // Create two parent tasks
    const p1Res = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Test suite A', status: 'open' },
    });
    const p1 = await p1Res.json();

    const p2Res = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Test suite B', status: 'open' },
    });
    const p2 = await p2Res.json();

    // Create child depending on both
    const childRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: {
        description: 'Merge PR',
        status: 'open',
        depends_on: [p1.task_id, p2.task_id],
      },
    });
    const child = await childRes.json();

    // Complete only p1
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${p1.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${p1.task_id}`, {
      headers,
      body: { status: 'completed', result: 'Pass', version: 2 },
    });

    // Try to claim child — should still fail (p2 not completed)
    const claimFail = await request(ctx.app, 'PATCH', `/api/v1/tasks/${child.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    expect(claimFail.status).toBe(400);

    // Complete p2
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${p2.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${p2.task_id}`, {
      headers,
      body: { status: 'completed', result: 'Pass', version: 2 },
    });

    // Now claim child — should succeed
    const claimOk = await request(ctx.app, 'PATCH', `/api/v1/tasks/${child.task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });
    expect(claimOk.status).toBe(200);
  });
});

describe('Task Workflow — Escalation Flow', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should escalate a claimed task with a reason', async () => {
    const headers = authHeaders(ctx.apiKey, 'worker');

    // Create and claim
    const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Complex refactor' },
    });
    const { task_id } = await createRes.json();

    // Escalate
    const escalateRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers,
      body: {
        status: 'escalated',
        result: 'Need architect review for database schema change',
        version: 1,
      },
    });
    expect(escalateRes.status).toBe(200);

    // Verify task state
    const getRes = await request(ctx.app, 'GET', `/api/v1/tasks/${task_id}`, { headers });
    const task = await getRes.json();
    expect(task.status).toBe('escalated');
    expect(task.result).toContain('architect review');

    // Verify ESCALATION event was broadcast
    const eventsRes = await request(ctx.app, 'GET', '/api/v1/events', { headers });
    const events = await eventsRes.json();
    const escalationEvents = events.events.filter(
      (e: any) => e.eventType === 'ESCALATION',
    );
    expect(escalationEvents.length).toBeGreaterThan(0);
    expect(escalationEvents[0].message).toContain('escalated');
  });

  it('should not allow escalating an open task', async () => {
    const headers = authHeaders(ctx.apiKey, 'worker');

    const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Open task', status: 'open' },
    });
    const { task_id } = await createRes.json();

    // Try to escalate open task — invalid transition
    const escalateRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers,
      body: { status: 'escalated', result: 'Help needed', version: 1 },
    });
    expect(escalateRes.status).toBe(400);
    const err = await escalateRes.json();
    expect(err.error).toBe('INVALID_TRANSITION');
  });
});

describe('Task Workflow — Reaping (model-level)', () => {
  let db: Database.Database;
  const teamId = 'test-team';

  beforeEach(() => {
    db = createTestDb();
    setupTeam(db, teamId);
  });

  /**
   * Simulate the reaper logic directly (matching task-reaper.ts).
   */
  function reapTasks(timeoutMinutes: number): number {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
    const staleTasks = db.prepare(`
      SELECT id, team_id, description, claimed_by, version
      FROM tasks WHERE status = 'claimed' AND claimed_at < ?
    `).all(cutoff) as Array<{ id: number; team_id: string; description: string; claimed_by: string; version: number }>;

    let reaped = 0;
    for (const task of staleTasks) {
      const result = db.prepare(`
        UPDATE tasks
        SET status = 'abandoned', claimed_by = NULL, claimed_at = NULL,
            result = 'Auto-released: agent did not complete within timeout',
            version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND version = ?
      `).run(task.id, task.version);
      if (result.changes > 0) reaped++;
    }
    return reaped;
  }

  it('should reap stale task and leave it reclaimable', () => {
    // Create a claimed task and backdate it
    const task = createTask(db, teamId, 'agent-slow', { description: 'Slow task' });
    const pastTime = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, task.task_id);

    // Reap with 30-minute timeout
    const reaped = reapTasks(30);
    expect(reaped).toBe(1);

    // Verify task is abandoned
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.task_id) as any;
    expect(row.status).toBe('abandoned');
    expect(row.claimed_by).toBeNull();
    expect(row.result).toContain('Auto-released');

    // Another agent can now reclaim it
    const reclaim = updateTask(db, teamId, 'agent-fast', {
      task_id: task.task_id,
      status: 'claimed',
      version: row.version,
    });
    expect(reclaim.status).toBe('claimed');
  });

  it('should only reap tasks older than the timeout', () => {
    // Create two tasks: one stale, one fresh
    const stale = createTask(db, teamId, 'agent-1', { description: 'Stale' });
    const fresh = createTask(db, teamId, 'agent-2', { description: 'Fresh' });

    // Backdate only the stale one
    const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, stale.task_id);

    const reaped = reapTasks(30);
    expect(reaped).toBe(1);

    // Verify correct task was reaped
    const staleRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(stale.task_id) as any;
    const freshRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(fresh.task_id) as any;
    expect(staleRow.status).toBe('abandoned');
    expect(freshRow.status).toBe('claimed');
  });
});

describe('Task Workflow — Side Effects', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should save completion result as context entry', async () => {
    const headers = authHeaders(ctx.apiKey, 'worker');

    const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Research task' },
    });
    const { task_id } = await createRes.json();

    await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers,
      body: {
        status: 'completed',
        result: 'Found 3 critical bugs in the auth module',
        version: 1,
      },
    });

    // Verify context entry was saved
    const ctxRes = await request(ctx.app, 'GET', `/api/v1/context?query=critical+bugs`, {
      headers,
    });
    const data = await ctxRes.json();
    const entry = data.entries.find((e: any) => e.key === `task-result-${task_id}`);
    expect(entry).toBeDefined();
    expect(entry.value).toContain('critical bugs');
  });

  it('should broadcast events for each status transition', async () => {
    const headers = authHeaders(ctx.apiKey, 'worker');

    // Create open task
    const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
      headers,
      body: { description: 'Tracked task', status: 'open' },
    });
    const { task_id } = await createRes.json();

    // Claim
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers,
      body: { status: 'claimed', version: 1 },
    });

    // Complete
    await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
      headers,
      body: { status: 'completed', result: 'Done', version: 2 },
    });

    // Verify we got events for create, claim, and complete
    const eventsRes = await request(ctx.app, 'GET', '/api/v1/events', { headers });
    const events = await eventsRes.json();
    const taskEvents = events.events.filter(
      (e: any) => e.eventType === 'TASK_UPDATE' && e.message.includes(`#${task_id}`),
    );
    // Should have: created, claimed, completed = 3 events
    expect(taskEvents.length).toBe(3);
  });
});
