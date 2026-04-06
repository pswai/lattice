import type { DbAdapter } from '../db/adapter.js';
import { pruneExpiredSessions } from '../models/session.js';
import { getLogger } from '../logger.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Prune expired/revoked sessions immediately, then hourly.
 * Returns the timer handle so callers can clearInterval on shutdown.
 */
export function startSessionCleanup(db: DbAdapter): NodeJS.Timeout {
  runOnce(db).catch((err) =>
    getLogger().error('session_cleanup_failed', {
      component: 'session-cleanup',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  return setInterval(() => {
    runOnce(db).catch((err) =>
      getLogger().error('session_cleanup_failed', {
        component: 'session-cleanup',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, HOUR_MS);
}

async function runOnce(db: DbAdapter): Promise<void> {
  const removed = await pruneExpiredSessions(db);
  if (removed > 0) {
    getLogger().info('session_cleanup', {
      component: 'session-cleanup',
      removed,
    });
  }
}
