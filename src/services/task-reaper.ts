import type { DbAdapter } from '../db/adapter.js';
import type { AppConfig } from '../config.js';
import { markStaleAgents } from '../models/agent.js';
import { getLogger } from '../logger.js';

interface StaleTaskRow {
  id: number;
  workspace_id: string;
  description: string;
  claimed_by: string;
  version: number;
}

export function startTaskReaper(db: DbAdapter, config: AppConfig): NodeJS.Timeout {
  return setInterval(() => {
    reapAbandonedTasks(db, config).catch((err) =>
      getLogger().error('task_reaper_failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, config.taskReapIntervalMs);
}

async function reapAbandonedTasks(db: DbAdapter, config: AppConfig): Promise<void> {
  // Mark stale agents as offline before checking for orphaned tasks,
  // so the offline-agent reap below has fresh agent statuses.
  await markStaleAgents(db, config.agentHeartbeatTimeoutMinutes);

  // 1. Time-based reap: tasks claimed longer than the timeout
  const cutoff = new Date(Date.now() - config.taskReapTimeoutMinutes * 60 * 1000).toISOString();

  const staleTasks = await db.all<StaleTaskRow>(`
    SELECT id, workspace_id, description, claimed_by, version
    FROM tasks
    WHERE status = 'claimed'
      AND claimed_at < ?
  `, cutoff);

  for (const task of staleTasks) {
    await reapTask(db, task, 'Auto-released: agent did not complete within timeout');
  }

  // 2. Heartbeat-based reap: tasks claimed by agents that are now offline
  const offlineAgentTasks = await db.all<StaleTaskRow>(`
    SELECT t.id, t.workspace_id, t.description, t.claimed_by, t.version
    FROM tasks t
    JOIN agents a ON a.id = t.claimed_by AND a.workspace_id = t.workspace_id
    WHERE t.status = 'claimed'
      AND a.status = 'offline'
  `);

  for (const task of offlineAgentTasks) {
    await reapTask(db, task, 'Auto-released: claiming agent went offline');
  }
}

async function reapTask(db: DbAdapter, task: StaleTaskRow, reason: string): Promise<void> {
  const result = await db.run(`
    UPDATE tasks
    SET status = 'abandoned',
        claimed_by = NULL,
        claimed_at = NULL,
        result = ?,
        version = version + 1,
        updated_at = ?
    WHERE id = ? AND version = ?
  `, reason, new Date().toISOString(), task.id, task.version);

  if (result.changes > 0) {
    await db.run(`
      INSERT INTO events (workspace_id, event_type, message, tags, created_by)
      VALUES (?, 'TASK_UPDATE', ?, '["task-reaper"]', 'system:reaper')
    `, task.workspace_id, `Task "${task.description}" auto-released (claimed by ${task.claimed_by}, ${reason.toLowerCase()})`);
  }
}
