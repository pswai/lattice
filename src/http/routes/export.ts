import { Hono } from 'hono';
import type { DbAdapter } from '../../db/adapter.js';
import { exportWorkspaceData } from '../../models/export.js';

export function createExportRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // GET /export — team-scoped snapshot
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');
    const snapshot = await exportWorkspaceData(db, workspaceId);
    return c.json(snapshot);
  });

  return router;
}
