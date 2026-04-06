import { Hono } from 'hono';
import type { DbAdapter } from '../../db/adapter.js';
import { exportTeamData } from '../../models/export.js';

export function createExportRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // GET /export — team-scoped snapshot
  router.get('/', async (c) => {
    const { teamId } = c.get('auth');
    const snapshot = await exportTeamData(db, teamId);
    return c.json(snapshot);
  });

  return router;
}
