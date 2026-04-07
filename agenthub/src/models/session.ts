import type { DbAdapter } from '../db/adapter.js';
import { createHash, randomBytes } from 'crypto';

export interface Session {
  sessionId: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
  revokedAt: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  revoked_at: string | null;
  created_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    sessionId: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ip: row.ip,
    userAgent: row.user_agent,
    revokedAt: row.revoked_at,
  };
}

/** sha256(raw) as hex — used as PK so raw token is never stored at rest. */
export function hashSessionToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface CreateSessionOptions {
  ip?: string;
  userAgent?: string;
  ttlDays?: number;
}

export interface CreateSessionResult {
  raw: string;
  sessionId: string;
  expiresAt: string;
}

const MAX_SESSIONS_PER_USER = 10;

export async function createSession(
  db: DbAdapter,
  userId: string,
  opts: CreateSessionOptions = {},
): Promise<CreateSessionResult> {
  const ttlDays = opts.ttlDays ?? 30;
  const raw = randomBytes(32).toString('base64url');
  const sessionId = hashSessionToken(raw);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  await db.run(
    'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
    sessionId, userId, expiresAt, opts.ip ?? null, opts.userAgent ?? null,
  );

  // Trim oldest sessions beyond the per-user limit
  await db.run(
    `DELETE FROM sessions WHERE id IN (
       SELECT id FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY rowid DESC
       LIMIT -1 OFFSET ?
     )`,
    userId, MAX_SESSIONS_PER_USER,
  );

  return { raw, sessionId, expiresAt };
}

/**
 * Resolve a session from a raw token.
 * Always hashes the input before lookup so leaked DB hashes cannot authenticate.
 * Returns null if missing, revoked, or expired.
 */
export async function getSession(db: DbAdapter, rawToken: string): Promise<Session | null> {
  if (!rawToken) return null;
  const sessionId = hashSessionToken(rawToken);

  const row = await db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return rowToSession(row);
}

export async function revokeSession(db: DbAdapter, sessionId: string): Promise<void> {
  await db.run(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    new Date().toISOString(), sessionId,
  );
}

export interface UserSessionView {
  id: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  revokedAt: string | null;
}

/** List a user's active sessions (excluding revoked and expired), newest first. */
export async function listUserSessions(db: DbAdapter, userId: string): Promise<UserSessionView[]> {
  const rows = await db.all<{
    id: string;
    created_at: string;
    expires_at: string;
    ip: string | null;
    user_agent: string | null;
    revoked_at: string | null;
  }>(
    `SELECT id, created_at, expires_at, ip, user_agent, revoked_at
     FROM sessions
     WHERE user_id = ?
       AND revoked_at IS NULL
       AND expires_at > ?
     ORDER BY created_at DESC`,
    userId, new Date().toISOString(),
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    ip: r.ip,
    userAgent: r.user_agent,
    revokedAt: r.revoked_at,
  }));
}

/** Revoke all active sessions for a user EXCEPT the one with keepSessionId. */
export async function revokeUserSessionsExcept(
  db: DbAdapter,
  userId: string,
  keepSessionId: string,
): Promise<{ revoked: number }> {
  const result = await db.run(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL",
    new Date().toISOString(), userId, keepSessionId,
  );
  return { revoked: result.changes };
}

/** Revoke ALL active sessions for a user (e.g. after password reset). */
export async function revokeAllUserSessions(
  db: DbAdapter,
  userId: string,
): Promise<{ revoked: number }> {
  const result = await db.run(
    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    new Date().toISOString(), userId,
  );
  return { revoked: result.changes };
}

/** Delete expired and revoked sessions. Returns rows removed. */
export async function pruneExpiredSessions(db: DbAdapter): Promise<number> {
  const result = await db.run(
    "DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL",
    new Date().toISOString(),
  );
  return result.changes;
}
