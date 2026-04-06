import type { DbAdapter } from '../db/adapter.js';
import type { AppConfig } from '../config.js';
import { pruneAuditOlderThan } from '../models/audit.js';
import { getLogger } from '../logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Run audit retention cleanup immediately, then daily. Returns the timer
 * handle so callers can clearInterval on shutdown.
 *
 * auditRetentionDays <= 0 means "keep forever" — the timer is still scheduled
 * but each tick is a no-op. Matches the pattern used by event-cleanup.
 */
export function startAuditCleanup(
  db: DbAdapter,
  config: AppConfig,
): NodeJS.Timeout {
  runOnce(db, config.auditRetentionDays).catch((err) =>
    getLogger().error('audit_cleanup_failed', {
      component: 'audit-cleanup',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return setInterval(() => {
    runOnce(db, config.auditRetentionDays).catch((err) =>
      getLogger().error('audit_cleanup_failed', {
        component: 'audit-cleanup',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, DAY_MS);
}

async function runOnce(db: DbAdapter, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
  const removed = await pruneAuditOlderThan(db, cutoff);
  if (removed > 0) {
    getLogger().info('audit_cleanup', {
      component: 'audit-cleanup',
      removed,
      retention_days: retentionDays,
    });
  }
}
