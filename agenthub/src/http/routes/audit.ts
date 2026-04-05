import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../../config.js';
import { queryAudit } from '../../models/audit.js';

export function createAuditRoutes(db: Database.Database, config: AppConfig): Hono {
  const router = new Hono();

  // Admin auth (same scheme as admin.ts). Mounted under /admin by app.ts.
  router.use('*', async (c, next) => {
    if (!config.adminKey) {
      return c.json(
        {
          error: 'ADMIN_NOT_CONFIGURED',
          message: 'Set ADMIN_KEY env var to enable admin routes',
        },
        503,
      );
    }
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== config.adminKey) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Invalid admin key' }, 401);
    }
    await next();
  });

  // GET /audit-log?team_id=...&actor=...&action=...&resource_type=...
  //              &since=...&until=...&limit=...&before_id=...
  router.get('/audit-log', (c) => {
    const teamId = c.req.query('team_id');
    if (!teamId) {
      return c.json(
        { error: 'VALIDATION_ERROR', message: 'team_id query param is required' },
        400,
      );
    }

    const limitRaw = c.req.query('limit');
    const beforeIdRaw = c.req.query('before_id');

    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const n = parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n < 1) {
        return c.json(
          { error: 'VALIDATION_ERROR', message: 'limit must be a positive integer' },
          400,
        );
      }
      limit = n;
    }

    let beforeId: number | undefined;
    if (beforeIdRaw !== undefined) {
      const n = parseInt(beforeIdRaw, 10);
      if (!Number.isFinite(n) || n < 1) {
        return c.json(
          { error: 'VALIDATION_ERROR', message: 'before_id must be a positive integer' },
          400,
        );
      }
      beforeId = n;
    }

    const items = queryAudit(db, {
      teamId,
      actor: c.req.query('actor'),
      action: c.req.query('action'),
      resourceType: c.req.query('resource_type'),
      since: c.req.query('since'),
      until: c.req.query('until'),
      limit,
      beforeId,
    });

    const nextBeforeId =
      items.length > 0 && (limit === undefined || items.length === Math.min(limit, 1000))
        ? items[items.length - 1].id
        : null;

    return c.json({ items, next_before_id: nextBeforeId });
  });

  return router;
}
