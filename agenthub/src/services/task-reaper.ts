import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';

interface StaleTaskRow {
  id: number;
  team_id: string;
  description: string;
  claimed_by: string;
  version: number;
}

export function startTaskReaper(db: Database.Database, config: AppConfig): NodeJS.Timeout {
  return setInterval(() => {
    reapAbandonedTasks(db, config);
  }, config.taskReapIntervalMs);
}

function reapAbandonedTasks(db: Database.Database, config: AppConfig): void {
  const cutoff = new Date(Date.now() - config.taskReapTimeoutMinutes * 60 * 1000).toISOString();

  const staleTasks = db.prepare(`
    SELECT id, team_id, description, claimed_by, version
    FROM tasks
    WHERE status = 'claimed'
      AND claimed_at < ?
  `).all(cutoff) as StaleTaskRow[];

  for (const task of staleTasks) {
    const result = db.prepare(`
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
      db.prepare(`
        INSERT INTO events (team_id, event_type, message, tags, created_by)
        VALUES (?, 'TASK_UPDATE', ?, '["task-reaper"]', 'system:reaper')
      `).run(task.team_id, `Task "${task.description}" auto-released (claimed by ${task.claimed_by}, timed out)`);
    }
  }
}
