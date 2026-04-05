import { Hono } from 'hono';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

/**
 * Teams meta routes.
 *
 * GET /teams/mine — returns the caller's effective team (after
 * X-Team-Override is applied) plus the list of teams their raw
 * credentials can reach. Used by agents to discover which team
 * they are currently operating on and verify team switches.
 */
export function createTeamRoutes(db: Database.Database): Hono {
  const router = new Hono();

  router.get('/mine', (c) => {
    const { teamId: effectiveTeamId, scope } = c.get('auth');

    // Reconstruct base/override by re-hashing the headers that were used.
    const authHeader = c.req.header('Authorization');
    const baseKey = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : c.req.query('token');
    const overrideKey = c.req.header('X-Team-Override');

    const accessibleTeams: { teamId: string; via: 'authorization' | 'x-team-override' }[] = [];

    if (baseKey) {
      const row = db
        .prepare('SELECT team_id FROM api_keys WHERE key_hash = ?')
        .get(createHash('sha256').update(baseKey).digest('hex')) as
        | { team_id: string }
        | undefined;
      if (row) accessibleTeams.push({ teamId: row.team_id, via: 'authorization' });
    }

    if (overrideKey) {
      const row = db
        .prepare('SELECT team_id FROM api_keys WHERE key_hash = ?')
        .get(createHash('sha256').update(overrideKey).digest('hex')) as
        | { team_id: string }
        | undefined;
      if (row) accessibleTeams.push({ teamId: row.team_id, via: 'x-team-override' });
    }

    const baseTeamId =
      accessibleTeams.find((t) => t.via === 'authorization')?.teamId ?? effectiveTeamId;

    return c.json({
      teamId: effectiveTeamId,
      baseTeamId,
      overrideApplied: overrideKey !== undefined && overrideKey.length > 0,
      accessibleTeams,
      scope,
    });
  });

  return router;
}
