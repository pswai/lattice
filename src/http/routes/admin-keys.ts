import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import type { AppConfig } from '../../config.js';
import { ValidationError } from '../../errors.js';

/**
 * Admin key-management endpoints. Mounted at `/admin` (same base as
 * createAdminRoutes). NEVER returns key_hash or an existing raw key — new
 * raw keys are only returned at creation/rotation time, once.
 */

const CreateKeySchema = z.object({
  label: z.string().max(255).optional(),
  scope: z.enum(['read', 'write', 'admin']).optional(),
  expires_in_days: z.number().int().positive().max(3650).optional(),
});

interface ApiKeyRow {
  id: number;
  label: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createAdminKeyRoutes(db: DbAdapter, config: AppConfig): Hono {
  const router = new Hono();

  // Admin auth — mirrors src/http/routes/admin.ts.
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

  // GET /teams/:id/keys — list keys for a team (never returns hash/raw key).
  router.get('/teams/:id/keys', async (c) => {
    const workspaceId = c.req.param('id');
    const team = await db.get('SELECT id FROM workspaces WHERE id = ?', workspaceId);
    if (!team) {
      return c.json({ error: 'NOT_FOUND', message: `Team "${workspaceId}" not found` }, 404);
    }
    const keys = await db.all<ApiKeyRow>(
      `SELECT id, label, scope, created_at, last_used_at, expires_at, revoked_at
       FROM api_keys WHERE workspace_id = ? ORDER BY id`,
      workspaceId,
    );
    return c.json({ keys });
  });

  // POST /teams/:id/keys — create a new key (with optional expiry).
  router.post('/teams/:id/keys', async (c) => {
    const workspaceId = c.req.param('id');
    const team = await db.get('SELECT id FROM workspaces WHERE id = ?', workspaceId);
    if (!team) {
      return c.json({ error: 'NOT_FOUND', message: `Team "${workspaceId}" not found` }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateKeySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const label = parsed.data.label || '';
    const scope = parsed.data.scope || 'write';
    let expiresAt: string | null = null;
    if (parsed.data.expires_in_days) {
      expiresAt = new Date(
        Date.now() + parsed.data.expires_in_days * 86_400_000,
      ).toISOString();
    }

    const rawKey = `lt_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const info = await db.run(
      'INSERT INTO api_keys (workspace_id, key_hash, label, scope, expires_at) VALUES (?, ?, ?, ?, ?)',
      workspaceId, keyHash, label, scope, expiresAt,
    );

    return c.json(
      {
        id: info.lastInsertRowid,
        workspace_id: workspaceId,
        api_key: rawKey,
        label,
        scope,
        expires_at: expiresAt,
      },
      201,
    );
  });

  // POST /teams/:id/keys/:keyId/rotate — issue new key, revoke old.
  router.post('/teams/:id/keys/:keyId/rotate', async (c) => {
    const workspaceId = c.req.param('id');
    const keyId = Number(c.req.param('keyId'));
    if (!Number.isFinite(keyId)) {
      return c.json({ error: 'NOT_FOUND', message: 'Key not found' }, 404);
    }
    const existing = await db.get<{
      id: number;
      label: string;
      scope: string;
      expires_at: string | null;
      revoked_at: string | null;
    }>(
      'SELECT id, label, scope, expires_at, revoked_at FROM api_keys WHERE id = ? AND workspace_id = ?',
      keyId, workspaceId,
    );
    if (!existing) {
      return c.json({ error: 'NOT_FOUND', message: 'Key not found' }, 404);
    }
    if (existing.revoked_at) {
      return c.json({ error: 'ALREADY_REVOKED', message: 'Key already revoked' }, 400);
    }

    const rawKey = `lt_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const revokedAt = nowIso();

    const newId = await db.transaction(async (tx) => {
      await tx.run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', revokedAt, keyId);
      const info = await tx.run(
        'INSERT INTO api_keys (workspace_id, key_hash, label, scope, expires_at) VALUES (?, ?, ?, ?, ?)',
        workspaceId, keyHash, existing.label, existing.scope, existing.expires_at,
      );
      return info.lastInsertRowid;
    });

    return c.json(
      {
        id: newId,
        workspace_id: workspaceId,
        api_key: rawKey,
        label: existing.label,
        scope: existing.scope,
        expires_at: existing.expires_at,
        rotated_from: keyId,
      },
      201,
    );
  });

  // POST /keys/:keyId/revoke — mark a key revoked.
  router.post('/keys/:keyId/revoke', async (c) => {
    const keyId = Number(c.req.param('keyId'));
    if (!Number.isFinite(keyId)) {
      return c.json({ error: 'NOT_FOUND', message: 'Key not found' }, 404);
    }
    const row = await db.get<{ id: number; revoked_at: string | null }>(
      'SELECT id, revoked_at FROM api_keys WHERE id = ?',
      keyId,
    );
    if (!row) {
      return c.json({ error: 'NOT_FOUND', message: 'Key not found' }, 404);
    }
    if (row.revoked_at) {
      return c.json({ revoked: true, already: true });
    }
    await db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', nowIso(), keyId);
    return c.json({ revoked: true });
  });

  return router;
}
