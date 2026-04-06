import { Hono } from 'hono';
import type { DbAdapter } from '../../db/adapter.js';
import {
  metricsRegistry,
  activeAgentsGauge,
  tasksGauge,
  PROMETHEUS_CONTENT_TYPE,
} from '../../metrics.js';

/**
 * Operations endpoints: /metrics, /healthz, /readyz.
 *
 * All PUBLIC (no auth) — these are container / scraper facing. `/healthz`
 * is cheap liveness, `/readyz` pings the DB, `/metrics` renders the
 * Prometheus registry (guarded by METRICS_ENABLED).
 */

const REFRESH_INTERVAL_MS = 5_000;
let lastGaugeRefresh = 0;

/**
 * Refresh DB-sourced gauges (agents online, tasks by status) — rate-limited
 * so heavy scrapers don't hammer SQLite.
 */
export async function refreshGaugesFromDb(db: DbAdapter, opts: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (!opts.force && now - lastGaugeRefresh < REFRESH_INTERVAL_MS) return;
  lastGaugeRefresh = now;

  try {
    activeAgentsGauge.reset();
    const agentRows = await db.all<{ team_id: string; n: number }>(
      "SELECT team_id, COUNT(*) as n FROM agents WHERE status = 'online' GROUP BY team_id",
    );
    for (const row of agentRows) {
      activeAgentsGauge.set({ team: row.team_id }, row.n);
    }

    tasksGauge.reset();
    const taskRows = await db.all<{ team_id: string; status: string; n: number }>(
      'SELECT team_id, status, COUNT(*) as n FROM tasks GROUP BY team_id, status',
    );
    for (const row of taskRows) {
      tasksGauge.set({ team: row.team_id, status: row.status }, row.n);
    }
  } catch {
    // If DB is unavailable, leave previous gauge values intact. /readyz
    // will surface the real error.
  }
}

export function createOpsRoutes(
  db: DbAdapter,
  opts: { metricsEnabled?: boolean } = {},
): Hono {
  const router = new Hono();
  const metricsEnabled = opts.metricsEnabled ?? true;

  router.get('/healthz', (c) => c.json({ status: 'ok' }, 200));

  router.get('/readyz', async (c) => {
    try {
      await db.get('SELECT 1');
      return c.json({ status: 'ready' }, 200);
    } catch (err) {
      return c.json(
        {
          status: 'unready',
          error: err instanceof Error ? err.message : String(err),
        },
        503,
      );
    }
  });

  router.get('/metrics', async (c) => {
    if (!metricsEnabled) {
      return new Response('# metrics disabled\n', {
        status: 200,
        headers: { 'content-type': PROMETHEUS_CONTENT_TYPE },
      });
    }
    await refreshGaugesFromDb(db);
    const body = metricsRegistry.render();
    return new Response(body, {
      status: 200,
      headers: { 'content-type': PROMETHEUS_CONTENT_TYPE },
    });
  });

  return router;
}
