import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import type { AppConfig } from '../../config.js';
import { ValidationError } from '../../errors.js';

const CreateWorkspaceSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(255),
});

const CreateKeySchema = z.object({
  label: z.string().max(255).optional(),
  scope: z.enum(['read', 'write', 'admin']).optional(),
});

export function createAdminRoutes(db: DbAdapter, config: AppConfig): Hono {
  const router = new Hono();

  // Admin auth middleware — requires ADMIN_KEY env var
  router.use('*', async (c, next) => {
    if (!config.adminKey) {
      return c.json({ error: 'ADMIN_NOT_CONFIGURED', message: 'Set ADMIN_KEY env var to enable admin routes' }, 503);
    }
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== config.adminKey) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Invalid admin key' }, 401);
    }
    await next();
  });

  // POST /admin/teams — create a new team
  router.post('/teams', async (c) => {
    const body = await c.req.json();
    const parsed = CreateWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    try {
      await db.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', parsed.data.id, parsed.data.name);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
        throw new ValidationError(`Team "${parsed.data.id}" already exists`);
      }
      throw err;
    }

    // Auto-generate an API key for the new team (default scope: write)
    const rawKey = `lt_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    await db.run(
      'INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)',
      parsed.data.id, keyHash, 'default', 'write',
    );

    return c.json({ workspace_id: parsed.data.id, api_key: rawKey, scope: 'write' }, 201);
  });

  // GET /admin/teams — list all teams
  router.get('/teams', async (c) => {
    const teams = await db.all('SELECT id, name, created_at FROM workspaces ORDER BY created_at DESC');
    return c.json({ teams });
  });

  // POST /admin/teams/:id/keys — create a new API key for a team
  router.post('/teams/:id/keys', async (c) => {
    const workspaceId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateKeySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    // Verify team exists
    const team = await db.get('SELECT id FROM workspaces WHERE id = ?', workspaceId);
    if (!team) {
      return c.json({ error: 'NOT_FOUND', message: `Team "${workspaceId}" not found` }, 404);
    }

    const rawKey = `lt_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const label = parsed.data?.label || '';
    const scope = parsed.data?.scope || 'write';

    await db.run(
      'INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)',
      workspaceId, keyHash, label, scope,
    );

    return c.json({ workspace_id: workspaceId, api_key: rawKey, label, scope }, 201);
  });

  // DELETE /admin/teams/:id/keys — revoke all keys for a team (nuclear option)
  router.delete('/teams/:id/keys', async (c) => {
    const workspaceId = c.req.param('id');
    const result = await db.run('DELETE FROM api_keys WHERE workspace_id = ?', workspaceId);
    return c.json({ revoked: result.changes });
  });

  // GET /admin/stats — basic observability
  router.get('/stats', async (c) => {
    const contextCount = (await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM context_entries'))!.cnt;
    const eventCount = (await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM events'))!.cnt;
    const taskStats = await db.all<{ status: string; cnt: number }>(`
      SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status
    `);
    const workspaceCount = (await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM workspaces'))!.cnt;
    const agentCount = (await db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM agents WHERE status != 'offline'"))!.cnt;

    return c.json({
      teams: workspaceCount,
      active_agents: agentCount,
      context_entries: contextCount,
      events: eventCount,
      tasks: Object.fromEntries(taskStats.map(r => [r.status, r.cnt])),
    });
  });

  return router;
}
