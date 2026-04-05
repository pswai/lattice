import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
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

export function createAdminKeyRoutes(db: Database.Database, config: AppConfig): Hono {
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
  router.get('/teams/:id/keys', (c) => {
    const teamId = c.req.param('id');
    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
    if (!team) {
      return c.json({ error: 'NOT_FOUND', message: `Team "${teamId}" not found` }, 404);
    }
    const keys = db
      .prepare(
        `SELECT id, label, scope, created_at, last_used_at, expires_at, revoked_at
         FROM api_keys WHERE team_id = ? ORDER BY id`,
      )
      .all(teamId) as ApiKeyRow[];
    return c.json({ keys });
  });

  // POST /teams/:id/keys — create a new key (with optional expiry).
  router.post('/teams/:id/keys', async (c) => {
    const teamId = c.req.param('id');
    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
    if (!team) {
      return c.json({ error: 'NOT_FOUND', message: `Team "${teamId}" not found` }, 404);
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

    const rawKey = `ah_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const info = db
      .prepare(
        'INSERT INTO api_keys (team_id, key_hash, label, scope, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(teamId, keyHash, label, scope, expiresAt);

    return c.json(
      {
        id: info.lastInsertRowid,
        team_id: teamId,
        api_key: rawKey,
        label,
        scope,
        expires_at: expiresAt,
      },
      201,
    );
  });

  // POST /teams/:id/keys/:keyId/rotate — issue new key, revoke old.
  router.post('/teams/:id/keys/:keyId/rotate', (c) => {
    const teamId = c.req.param('id');
    const keyId = Number(c.req.param('keyId'));
    if (!Number.isFinite(keyId)) {
      return c.json({ error: 'NOT_FOUND', message: 'Key not found' }, 404);
    }
    const existing = db
      .prepare(
        'SELECT id, label, scope, expires_at, revoked_at FROM api_keys WHERE id = ? AND team_id = ?',
      )
      .get(keyId, teamId) as
      | {
          id: number;
          label: string;
          scope: string;
          expires_at: string | null;
          revoked_at: string | null;
        }
      | undefined;
    if (!existing) {
      return c.json({ error: 'NOT_FOUND', message: 'Key not found' }, 404);
    }
    if (existing.revoked_at) {
      return c.json({ error: 'ALREADY_REVOKED', message: 'Key already revoked' }, 400);
    }

    const rawKey = `ah_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const revokedAt = nowIso();

    const tx = db.transaction(() => {
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(revokedAt, keyId);
      const info = db
        .prepare(
          'INSERT INTO api_keys (team_id, key_hash, label, scope, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(teamId, keyHash, existing.label, existing.scope, existing.expires_at);
      return info.lastInsertRowid;
    });
    const newId = tx();

    return c.json(
      {
        id: newId,
        team_id: teamId,
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
  router.post('/keys/:keyId/revoke', (c) => {
    const keyId = Number(c.req.param('keyId'));
    if (!Number.isFinite(keyId)) {
      return c.json({ error: 'NOT_FOUND', message: 'Key not found' }, 404);
    }
    const row = db
      .prepare('SELECT id, revoked_at FROM api_keys WHERE id = ?')
      .get(keyId) as { id: number; revoked_at: string | null } | undefined;
    if (!row) {
      return c.json({ error: 'NOT_FOUND', message: 'Key not found' }, 404);
    }
    if (row.revoked_at) {
      return c.json({ revoked: true, already: true });
    }
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(), keyId);
    return c.json({ revoked: true });
  });

  return router;
}
