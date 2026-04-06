import { Hono } from 'hono';
import { createHash } from 'crypto';
import type { DbAdapter } from '../../db/adapter.js';

/**
 * Teams meta routes.
 *
 * GET /teams/mine — returns the caller's effective team (after
 * X-Team-Override is applied) plus the list of teams their raw
 * credentials can reach. Used by agents to discover which team
 * they are currently operating on and verify team switches.
 */
export function createWorkspaceTeamRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  router.get('/mine', async (c) => {
    const { workspaceId: effectiveWorkspaceId, scope } = c.get('auth');

    // Reconstruct base/override by re-hashing the headers that were used.
    const authHeader = c.req.header('Authorization');
    const baseKey = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : c.req.query('token');
    const overrideKey = c.req.header('X-Team-Override');

    const accessibleWorkspaces: { workspaceId: string; via: 'authorization' | 'x-team-override' }[] = [];

    if (baseKey) {
      const row = await db.get<{ workspace_id: string }>(
        'SELECT workspace_id FROM api_keys WHERE key_hash = ?',
        createHash('sha256').update(baseKey).digest('hex'),
      );
      if (row) accessibleWorkspaces.push({ workspaceId: row.workspace_id, via: 'authorization' });
    }

    if (overrideKey) {
      const row = await db.get<{ workspace_id: string }>(
        'SELECT workspace_id FROM api_keys WHERE key_hash = ?',
        createHash('sha256').update(overrideKey).digest('hex'),
      );
      if (row) accessibleWorkspaces.push({ workspaceId: row.workspace_id, via: 'x-team-override' });
    }

    const baseWorkspaceId =
      accessibleWorkspaces.find((t) => t.via === 'authorization')?.workspaceId ?? effectiveWorkspaceId;

    return c.json({
      workspaceId: effectiveWorkspaceId,
      baseWorkspaceId,
      overrideApplied: overrideKey !== undefined && overrideKey.length > 0,
      accessibleWorkspaces,
      scope,
    });
  });

  return router;
}
