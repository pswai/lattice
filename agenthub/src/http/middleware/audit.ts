import { createMiddleware } from 'hono/factory';
import type Database from 'better-sqlite3';
import { writeAudit } from '../../models/audit.js';
import { getLogger } from '../../logger.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Resource IDs look like either a decimal integer or a UUID-ish / hex / slug
// token. We keep this pragmatic — false positives are fine, they just populate
// resource_id with something readable.
const ID_RE = /^(?:\d+|[A-Za-z0-9][A-Za-z0-9_\-]{3,})$/;

function methodToVerb(method: string): string {
  switch (method) {
    case 'POST':
      return 'create';
    case 'PUT':
      return 'update';
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return method.toLowerCase();
  }
}

function singularize(s: string): string {
  // Pragmatic singularization for path segments like "tasks" -> "task",
  // "webhooks" -> "webhook". Leave non-plural as-is.
  if (s.endsWith('ies') && s.length > 3) return `${s.slice(0, -3)}y`;
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

interface PathParts {
  resourceType: string | null;
  resourceId: string | null;
}

function parsePath(path: string): PathParts {
  // Strip /api/v1 prefix
  let p = path;
  if (p.startsWith('/api/v1/')) p = p.slice('/api/v1/'.length);
  else if (p.startsWith('/api/v1')) p = p.slice('/api/v1'.length);
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (!p) return { resourceType: null, resourceId: null };

  const segments = p.split('/');
  const resourceType = segments[0] ?? null;
  const last = segments[segments.length - 1];
  const resourceId =
    segments.length > 1 && last && ID_RE.test(last) ? last : null;
  return { resourceType, resourceId };
}

function extractIp(headerGet: (name: string) => string | undefined): string {
  const xff = headerGet('X-Forwarded-For');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = headerGet('X-Real-IP');
  if (realIp) return realIp.trim();
  return '';
}

/**
 * Audit middleware — writes one row per successful mutating API request.
 *
 * Runs AFTER auth middleware, so c.get('auth') is populated. Only records
 * POST/PUT/PATCH/DELETE with response status < 400. Body is NEVER captured
 * (may contain secrets); only the query string is recorded in metadata.
 */
export function createAuditMiddleware(db: Database.Database) {
  return createMiddleware(async (c, next) => {
    try {
      await next();
    } finally {
      try {
        const method = c.req.method.toUpperCase();
        if (!MUTATING_METHODS.has(method)) return;

        // Defensive: skip if auth context is missing (shouldn't happen on /api/v1).
        const auth = c.get('auth' as never) as
          | { teamId?: string; agentId?: string }
          | undefined;
        if (!auth?.teamId) return;

        const status = c.res.status;
        if (status >= 400) return;

        const { resourceType, resourceId } = parsePath(c.req.path);
        const resource = resourceType ? singularize(resourceType) : 'request';
        const action = `${resource}.${methodToVerb(method)}`;

        const ip = extractIp((name) => c.req.header(name));
        const requestId = c.get('requestId') ?? null;

        let queries: Record<string, string[]> = {};
        try {
          queries = c.req.queries();
        } catch {
          queries = {};
        }

        writeAudit(db, {
          teamId: auth.teamId,
          actor: auth.agentId || 'anonymous',
          action,
          resourceType: resourceType ?? null,
          resourceId: resourceId,
          metadata: { query: queries },
          ip: ip || null,
          requestId,
        });
      } catch (err) {
        // Writes must never take down the request.
        try {
          getLogger().error('audit_write_failed', {
            component: 'audit',
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // swallow logger failures
        }
      }
    }
  });
}
