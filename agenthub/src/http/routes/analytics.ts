import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { getTeamAnalytics, parseSinceDuration } from '../../models/analytics.js';
import { ValidationError } from '../../errors.js';

export function createAnalyticsRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // GET /analytics?since=24h — aggregated team metrics
  router.get('/', (c) => {
    const { teamId } = c.get('auth');
    const since = c.req.query('since');

    let sinceIso: string;
    try {
      sinceIso = parseSinceDuration(since);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : 'Invalid since parameter');
    }

    const result = getTeamAnalytics(db, teamId, sinceIso);
    return c.json(result);
  });

  return router;
}
