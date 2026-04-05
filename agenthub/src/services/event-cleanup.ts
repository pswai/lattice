import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { markStaleAgents } from '../models/agent.js';
import { getLogger } from '../logger.js';

export function startEventCleanup(db: Database.Database, config: AppConfig): NodeJS.Timeout {
  // Run cleanup every hour
  return setInterval(() => {
    cleanupOldEvents(db, config.eventRetentionDays);
    markStaleAgents(db, config.agentHeartbeatTimeoutMinutes);
  }, 60 * 60 * 1000);
}

function cleanupOldEvents(db: Database.Database, retentionDays: number): void {
  if (retentionDays <= 0) return; // 0 = keep forever

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    DELETE FROM events WHERE created_at < ?
  `).run(cutoff);

  if (result.changes > 0) {
    getLogger().info('event_cleanup', {
      component: 'event-cleanup',
      removed: result.changes,
      retention_days: retentionDays,
    });
  }
}
