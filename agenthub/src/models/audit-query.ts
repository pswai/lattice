import type Database from 'better-sqlite3';

export interface AuditQueryFilters {
  actor?: string;
  action?: string;
  resource?: string;
  since?: string;
  until?: string;
  limit?: number;
  beforeId?: number;
}

export interface AuditEntryRow {
  id: number;
  team_id: string;
  actor: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: string;
  ip: string | null;
  request_id: string | null;
  created_at: string;
}

export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LIMIT = 500;

/**
 * Query audit_log for a workspace with optional filters. Returns newest-first,
 * using id as a stable cursor. Uses existing indexes:
 *   idx_audit_team_time, idx_audit_team_actor, idx_audit_team_action.
 */
export function queryAuditLog(
  db: Database.Database,
  teamId: string,
  filters: AuditQueryFilters,
): AuditEntryRow[] {
  const where: string[] = ['team_id = ?'];
  const params: unknown[] = [teamId];

  if (filters.actor) {
    where.push('actor = ?');
    params.push(filters.actor);
  }
  if (filters.action) {
    where.push('action = ?');
    params.push(filters.action);
  }
  if (filters.resource) {
    where.push('resource_type = ?');
    params.push(filters.resource);
  }
  if (filters.since) {
    where.push('created_at >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    where.push('created_at < ?');
    params.push(filters.until);
  }
  if (typeof filters.beforeId === 'number' && Number.isFinite(filters.beforeId)) {
    where.push('id < ?');
    params.push(filters.beforeId);
  }

  const requested = filters.limit ?? DEFAULT_AUDIT_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(requested)), MAX_AUDIT_LIMIT);
  params.push(limit);

  const sql = `SELECT id, team_id, actor, action, resource_type, resource_id,
                      metadata, ip, request_id, created_at
               FROM audit_log
               WHERE ${where.join(' AND ')}
               ORDER BY id DESC
               LIMIT ?`;
  return db.prepare(sql).all(...params) as AuditEntryRow[];
}

export function encodeAuditCursor(id: number): string {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

export function decodeAuditCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const n = parseInt(decoded, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}
