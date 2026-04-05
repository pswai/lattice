import { createMiddleware } from 'hono/factory';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import type { AuthContext, ApiKeyScope } from '../../models/types.js';

// Extend Hono's context variables to include auth
declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * Result of resolving the team from an incoming request.
 * `baseTeamId` is the team bound to the Authorization API key.
 * `teamId` is the effective team the request operates on
 * (equal to baseTeamId unless X-Team-Override was applied).
 */
export interface ResolvedTeam {
  teamId: string;
  baseTeamId: string;
  overrideApplied: boolean;
  scope: ApiKeyScope;
}

export type AuthResolution =
  | { ok: true; resolved: ResolvedTeam }
  | { ok: false; status: 401; error: string; message: string };

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function lookupTeamId(db: Database.Database, apiKey: string): string | null {
  const keyHash = hashKey(apiKey);
  const row = db
    .prepare('SELECT team_id FROM api_keys WHERE key_hash = ?')
    .get(keyHash) as { team_id: string } | undefined;
  return row?.team_id ?? null;
}

function lookupKey(
  db: Database.Database,
  apiKey: string,
): { teamId: string; scope: ApiKeyScope } | null {
  const keyHash = hashKey(apiKey);
  const row = db
    .prepare('SELECT team_id, scope FROM api_keys WHERE key_hash = ?')
    .get(keyHash) as { team_id: string; scope: ApiKeyScope } | undefined;
  if (!row) return null;
  return { teamId: row.team_id, scope: row.scope };
}

/**
 * Resolve the effective team for a request.
 *
 * - Requires a Bearer Authorization header (or ?token= for EventSource).
 * - If X-Team-Override is present, it must be a valid API key for the
 *   target team; the request then operates on that team.
 */
export function resolveTeamFromRequest(
  db: Database.Database,
  c: Context,
  { allowQueryToken = false }: { allowQueryToken?: boolean } = {},
): AuthResolution {
  const authHeader = c.req.header('Authorization');
  let apiKey: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7);
  } else if (allowQueryToken) {
    apiKey = c.req.query('token');
  }
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid Authorization header',
    };
  }

  const base = lookupKey(db, apiKey);
  if (!base) {
    return { ok: false, status: 401, error: 'UNAUTHORIZED', message: 'Invalid API key' };
  }

  const overrideKey = c.req.header('X-Team-Override');
  if (overrideKey && overrideKey.length > 0) {
    const override = lookupKey(db, overrideKey);
    if (!override) {
      return {
        ok: false,
        status: 401,
        error: 'UNAUTHORIZED',
        message: 'Invalid X-Team-Override key',
      };
    }
    return {
      ok: true,
      resolved: {
        teamId: override.teamId,
        baseTeamId: base.teamId,
        overrideApplied: true,
        scope: override.scope,
      },
    };
  }

  return {
    ok: true,
    resolved: {
      teamId: base.teamId,
      baseTeamId: base.teamId,
      overrideApplied: false,
      scope: base.scope,
    },
  };
}

/**
 * Check whether the key scope permits a given HTTP method.
 * - read: GET only
 * - write: any method
 * - admin: any method
 */
export function scopePermitsMethod(scope: ApiKeyScope, method: string): boolean {
  if (scope === 'read') return method === 'GET' || method === 'HEAD';
  return true;
}

export function requiredScopeForMethod(method: string): ApiKeyScope {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

export function createAuthMiddleware(db: Database.Database) {
  return createMiddleware(async (c, next) => {
    const result = resolveTeamFromRequest(db, c, { allowQueryToken: true });
    if (!result.ok) {
      return c.json({ error: result.error, message: result.message }, result.status);
    }

    const { scope } = result.resolved;
    const method = c.req.method.toUpperCase();
    if (!scopePermitsMethod(scope, method)) {
      const required = requiredScopeForMethod(method);
      return c.json(
        {
          error: 'INSUFFICIENT_SCOPE',
          message: `This key has scope '${scope}' but this endpoint requires '${required}'.`,
        },
        403,
      );
    }

    const agentId = c.req.header('X-Agent-ID') || 'anonymous';
    c.set('auth', { teamId: result.resolved.teamId, agentId, scope });

    await next();
  });
}
