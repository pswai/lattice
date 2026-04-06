import type { DbAdapter } from '../db/adapter.js';

export interface AuditRow {
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

export interface WriteAuditInput {
  teamId: string;
  actor: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string | null;
}

export interface QueryAuditInput {
  teamId: string;
  actor?: string;
  action?: string;
  resourceType?: string;
  since?: string;
  until?: string;
  limit?: number;
  beforeId?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Append a single audit record. Append-only — there is no update/delete
 * counterpart by design.
 */
export async function writeAudit(db: DbAdapter, input: WriteAuditInput): Promise<void> {
  const metadataJson = JSON.stringify(input.metadata ?? {});
  await db.run(
    `INSERT INTO audit_log
       (team_id, actor, action, resource_type, resource_id, metadata, ip, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.teamId,
    input.actor,
    input.action,
    input.resourceType ?? null,
    input.resourceId ?? null,
    metadataJson,
    input.ip ?? null,
    input.requestId ?? null,
  );
}

/**
 * Read audit records, newest first, with optional filters and cursor.
 */
export async function queryAudit(
  db: DbAdapter,
  input: QueryAuditInput,
): Promise<AuditRow[]> {
  const where: string[] = ['team_id = ?'];
  const params: unknown[] = [input.teamId];

  if (input.actor) {
    where.push('actor = ?');
    params.push(input.actor);
  }
  if (input.action) {
    where.push('action = ?');
    params.push(input.action);
  }
  if (input.resourceType) {
    where.push('resource_type = ?');
    params.push(input.resourceType);
  }
  if (input.since) {
    where.push('created_at >= ?');
    params.push(input.since);
  }
  if (input.until) {
    where.push('created_at < ?');
    params.push(input.until);
  }
  if (typeof input.beforeId === 'number' && Number.isFinite(input.beforeId)) {
    where.push('id < ?');
    params.push(input.beforeId);
  }

  const requested = input.limit ?? DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(requested)), MAX_LIMIT);

  const sql = `SELECT id, team_id, actor, action, resource_type, resource_id,
                      metadata, ip, request_id, created_at
               FROM audit_log
               WHERE ${where.join(' AND ')}
               ORDER BY id DESC
               LIMIT ?`;
  params.push(limit);

  return await db.all<AuditRow>(sql, ...params);
}

/**
 * Retention cleanup — delete audit rows older than the supplied ISO cutoff.
 * Returns number of rows deleted.
 */
export async function pruneAuditOlderThan(db: DbAdapter, cutoffIso: string): Promise<number> {
  const result = await db.run('DELETE FROM audit_log WHERE created_at < ?', cutoffIso);
  return result.changes;
}
