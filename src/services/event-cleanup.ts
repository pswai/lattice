import type { DbAdapter } from '../db/adapter.js';
import type { AppConfig } from '../config.js';
import { markStaleAgents } from '../models/agent.js';
import { getLogger } from '../logger.js';

export function startEventCleanup(db: DbAdapter, config: AppConfig): NodeJS.Timeout {
  // Run cleanup every hour
  return setInterval(() => {
    runCleanup(db, config).catch((err) =>
      getLogger().error('event_cleanup_failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, 60 * 60 * 1000);
}

async function runCleanup(db: DbAdapter, config: AppConfig): Promise<void> {
  await cleanupOldEvents(db, config.eventRetentionDays);
  await markStaleAgents(db, config.agentHeartbeatTimeoutMinutes);
  await cleanupExpiredContext(db);
  await cleanupOldDeliveries(db, config.eventRetentionDays);
}

async function cleanupExpiredContext(db: DbAdapter): Promise<void> {
  const result = await db.run(`
    DELETE FROM context_entries WHERE expires_at IS NOT NULL AND expires_at < ?
  `, new Date().toISOString());

  if (result.changes > 0) {
    getLogger().info('context_ttl_cleanup', {
      component: 'event-cleanup',
      removed: result.changes,
    });
  }
}

async function cleanupOldDeliveries(db: DbAdapter, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await db.run(`
    DELETE FROM webhook_deliveries
    WHERE status IN ('success', 'failed', 'dead')
      AND updated_at < ?
  `, cutoff);

  if (result.changes > 0) {
    getLogger().info('delivery_cleanup', {
      component: 'event-cleanup',
      removed: result.changes,
      retention_days: retentionDays,
    });
  }
}

async function cleanupOldEvents(db: DbAdapter, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return; // 0 = keep forever

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await db.run(`
    DELETE FROM events WHERE created_at < ?
  `, cutoff);

  if (result.changes > 0) {
    getLogger().info('event_cleanup', {
      component: 'event-cleanup',
      removed: result.changes,
      retention_days: retentionDays,
    });
  }
}
