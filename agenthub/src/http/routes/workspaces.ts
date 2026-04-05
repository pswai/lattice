import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { ValidationError } from '../../errors.js';
import { addMembership, listUserMemberships, getMembership } from '../../models/membership.js';
import { requireSession } from '../middleware/require-session.js';

const CreateWorkspaceSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/, 'id must be lowercase alphanumeric, hyphens, or underscores'),
  name: z.string().min(1).max(255),
});

export function createWorkspaceRoutes(db: Database.Database): Hono {
  const router = new Hono();

  router.post('/', requireSession, async (c) => {
    const session = c.get('session')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { id, name } = parsed.data;
    const rawKey = `ah_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const tx = db.transaction(() => {
      try {
        db.prepare(
          'INSERT INTO teams (id, name, owner_user_id, slug) VALUES (?, ?, ?, ?)',
        ).run(id, name, session.userId, id);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          throw new ValidationError(`Workspace "${id}" already exists`);
        }
        throw err;
      }
      addMembership(db, { userId: session.userId, teamId: id, role: 'owner' });
      db.prepare(
        'INSERT INTO api_keys (team_id, key_hash, label, scope) VALUES (?, ?, ?, ?)',
      ).run(id, keyHash, 'default', 'write');
    });
    tx();

    return c.json(
      { team_id: id, name, api_key: rawKey, scope: 'write' as const, role: 'owner' as const },
      201,
    );
  });

  router.get('/', requireSession, (c) => {
    const session = c.get('session')!;
    const memberships = listUserMemberships(db, session.userId);
    return c.json({
      workspaces: memberships.map((m) => ({
        team_id: m.teamId,
        name: m.teamName,
        role: m.role,
        joined_at: m.joinedAt,
      })),
    });
  });

  router.delete('/:id', requireSession, (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    const membership = getMembership(db, session.userId, teamId);
    if (!membership) {
      return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404);
    }
    if (membership.role !== 'owner') {
      return c.json({ error: 'FORBIDDEN', message: 'Only the workspace owner can delete it' }, 403);
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM api_keys WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM team_memberships WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
    });
    tx();

    return c.body(null, 204);
  });

  return router;
}
