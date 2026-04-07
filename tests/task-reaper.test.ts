import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, setupWorkspace } from './helpers.js';
import { createTask, updateTask } from '../src/models/task.js';
import { getUpdates } from '../src/models/event.js';

/**
 * Simulate the reaper logic directly (since it's private and runs on interval).
 * We reproduce the reaper's SQL queries to test the behavior.
 */
function reapAbandonedTasks(db: ReturnType<typeof createTestDb>, timeoutMinutes: number): number {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  const staleTasks = db.rawDb.prepare(`
    SELECT id, workspace_id, description, claimed_by, version
    FROM tasks
    WHERE status = 'claimed'
      AND claimed_at < ?
  `).all(cutoff) as Array<{
    id: number;
    workspace_id: string;
    description: string;
    claimed_by: string;
    version: number;
  }>;

  let reaped = 0;
  for (const task of staleTasks) {
    const result = db.rawDb.prepare(`
      UPDATE tasks
      SET status = 'abandoned',
          claimed_by = NULL,
          claimed_at = NULL,
          result = 'Auto-released: agent did not complete within timeout',
          version = version + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND version = ?
    `).run(task.id, task.version);

    if (result.changes > 0) {
      db.rawDb.prepare(`
        INSERT INTO events (workspace_id, event_type, message, tags, created_by)
        VALUES (?, 'TASK_UPDATE', ?, '["task-reaper"]', 'system:reaper')
      `).run(task.workspace_id, `Task "${task.description}" auto-released (claimed by ${task.claimed_by}, timed out)`);
      reaped++;
    }
  }
  return reaped;
}

describe('Task Reaper', () => {
  let db: ReturnType<typeof createTestDb>;
  const workspaceId = 'test-team';
  const agentId = 'test-agent';

  beforeEach(() => {
    db = createTestDb();
    setupWorkspace(db, workspaceId);
  });

  it('should reap tasks claimed longer than timeout', async () => {
    // Create and claim a task
    const task = await createTask(db, workspaceId, agentId, { description: 'Stale task' });

    // Manually backdate the claimed_at to 60 minutes ago
    const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.rawDb.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, task.task_id);

    // Run reaper with 30 minute timeout
    const reaped = reapAbandonedTasks(db, 30);
    expect(reaped).toBe(1);

    // Verify the task was abandoned
    const row = db.rawDb.prepare('SELECT status, claimed_by, result FROM tasks WHERE id = ?').get(task.task_id) as any;
    expect(row.status).toBe('abandoned');
    expect(row.claimed_by).toBeNull();
    expect(row.result).toContain('Auto-released');
  });

  it('should not reap recently claimed tasks', async () => {
    // Create and claim a task (just now)
    await createTask(db, workspaceId, agentId, { description: 'Fresh task' });

    // Run reaper with 30 minute timeout
    const reaped = reapAbandonedTasks(db, 30);
    expect(reaped).toBe(0);
  });

  it('should not reap open tasks', async () => {
    // Create open task
    await createTask(db, workspaceId, agentId, { description: 'Open task', status: 'open' });

    // Run reaper
    const reaped = reapAbandonedTasks(db, 0); // 0 minute timeout = reap everything claimed
    expect(reaped).toBe(0);
  });

  it('should not reap completed tasks', async () => {
    const task = await createTask(db, workspaceId, agentId, { description: 'Completed task' });
    await updateTask(db, workspaceId, agentId, {
      task_id: task.task_id,
      status: 'completed',
      result: 'Done',
      version: 1,
    });

    const reaped = reapAbandonedTasks(db, 0);
    expect(reaped).toBe(0);
  });

  it('should broadcast TASK_UPDATE event on reap', async () => {
    const task = await createTask(db, workspaceId, agentId, { description: 'Reapable task' });

    // Backdate
    const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.rawDb.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, task.task_id);

    reapAbandonedTasks(db, 30);

    // Check for reaper event
    const updates = await getUpdates(db, workspaceId, {});
    const reaperEvents = updates.events.filter(
      (e) => e.createdBy === 'system:reaper' && e.tags.includes('task-reaper'),
    );
    expect(reaperEvents.length).toBeGreaterThan(0);
    expect(reaperEvents[0].message).toContain('auto-released');
  });

  it('should use optimistic locking during reap', async () => {
    const task = await createTask(db, workspaceId, agentId, { description: 'Race condition task' });

    // Backdate
    const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.rawDb.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, task.task_id);

    // Read the stale task version (simulating the reaper's SELECT)
    const staleRow = db.rawDb.prepare('SELECT version FROM tasks WHERE id = ?').get(task.task_id) as any;
    const staleVersion = staleRow.version;

    // Simulate concurrent update by bumping version (another agent completed the task)
    db.rawDb.prepare('UPDATE tasks SET version = version + 1, status = \'completed\' WHERE id = ?').run(task.task_id);

    // Now try to reap with the stale version — should fail
    const result = db.rawDb.prepare(`
      UPDATE tasks
      SET status = 'abandoned',
          claimed_by = NULL,
          claimed_at = NULL,
          result = 'Auto-released: agent did not complete within timeout',
          version = version + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND version = ?
    `).run(task.task_id, staleVersion);

    expect(result.changes).toBe(0);

    // Task should still be completed (not abandoned)
    const row = db.rawDb.prepare('SELECT status FROM tasks WHERE id = ?').get(task.task_id) as any;
    expect(row.status).toBe('completed');
  });

  it('should handle multiple stale tasks', async () => {
    const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    for (let i = 0; i < 3; i++) {
      const task = await createTask(db, workspaceId, agentId, { description: `Stale task ${i}` });
      db.rawDb.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, task.task_id);
    }

    const reaped = reapAbandonedTasks(db, 30);
    expect(reaped).toBe(3);
  });
});
