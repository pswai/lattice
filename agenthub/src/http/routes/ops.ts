import { Hono } from 'hono';
import type Database from 'better-sqlite3';
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
export function refreshGaugesFromDb(db: Database.Database, opts: { force?: boolean } = {}): void {
  const now = Date.now();
  if (!opts.force && now - lastGaugeRefresh < REFRESH_INTERVAL_MS) return;
  lastGaugeRefresh = now;

  try {
    activeAgentsGauge.reset();
    const agentRows = db
      .prepare(
        "SELECT team_id, COUNT(*) as n FROM agents WHERE status = 'online' GROUP BY team_id",
      )
      .all() as Array<{ team_id: string; n: number }>;
    for (const row of agentRows) {
      activeAgentsGauge.set({ team: row.team_id }, row.n);
    }

    tasksGauge.reset();
    const taskRows = db
      .prepare('SELECT team_id, status, COUNT(*) as n FROM tasks GROUP BY team_id, status')
      .all() as Array<{ team_id: string; status: string; n: number }>;
    for (const row of taskRows) {
      tasksGauge.set({ team: row.team_id, status: row.status }, row.n);
    }
  } catch {
    // If DB is unavailable, leave previous gauge values intact. /readyz
    // will surface the real error.
  }
}

export function createOpsRoutes(
  db: Database.Database,
  opts: { metricsEnabled?: boolean } = {},
): Hono {
  const router = new Hono();
  const metricsEnabled = opts.metricsEnabled ?? true;

  router.get('/healthz', (c) => c.json({ status: 'ok' }, 200));

  router.get('/readyz', (c) => {
    try {
      db.prepare('SELECT 1').get();
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

  router.get('/metrics', (c) => {
    if (!metricsEnabled) {
      return new Response('# metrics disabled\n', {
        status: 200,
        headers: { 'content-type': PROMETHEUS_CONTENT_TYPE },
      });
    }
    refreshGaugesFromDb(db);
    const body = metricsRegistry.render();
    return new Response(body, {
      status: 200,
      headers: { 'content-type': PROMETHEUS_CONTENT_TYPE },
    });
  });

  return router;
}
