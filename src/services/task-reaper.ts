import type { DbAdapter } from '../db/adapter.js';
import type { AppConfig } from '../config.js';
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
  const cutoff = new Date(Date.now() - config.taskReapTimeoutMinutes * 60 * 1000).toISOString();

  const staleTasks = await db.all<StaleTaskRow>(`
    SELECT id, workspace_id, description, claimed_by, version
    FROM tasks
    WHERE status = 'claimed'
      AND claimed_at < ?
  `, cutoff);

  for (const task of staleTasks) {
    const result = await db.run(`
      UPDATE tasks
      SET status = 'abandoned',
          claimed_by = NULL,
          claimed_at = NULL,
          result = 'Auto-released: agent did not complete within timeout',
          version = version + 1,
          updated_at = ?
      WHERE id = ? AND version = ?
    `, new Date().toISOString(), task.id, task.version);

    if (result.changes > 0) {
      await db.run(`
        INSERT INTO events (workspace_id, event_type, message, tags, created_by)
        VALUES (?, 'TASK_UPDATE', ?, '["task-reaper"]', 'system:reaper')
      `, task.workspace_id, `Task "${task.description}" auto-released (claimed by ${task.claimed_by}, timed out)`);
    }
  }
}
