import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { exportTeamData } from '../../models/export.js';

export function createExportRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // GET /export — team-scoped snapshot
  router.get('/', (c) => {
    const { teamId } = c.get('auth');
    const snapshot = exportTeamData(db, teamId);
    return c.json(snapshot);
  });

  return router;
}
