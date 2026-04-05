import type Database from 'better-sqlite3';
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

export function createSession(
  db: Database.Database,
  userId: string,
  opts: CreateSessionOptions = {},
): CreateSessionResult {
  const ttlDays = opts.ttlDays ?? 30;
  const raw = randomBytes(32).toString('base64url');
  const sessionId = hashSessionToken(raw);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, userId, expiresAt, opts.ip ?? null, opts.userAgent ?? null);

  return { raw, sessionId, expiresAt };
}

/**
 * Resolve a session from either the raw token or its hash.
 * Returns null if missing, revoked, or expired.
 */
export function getSession(db: Database.Database, rawOrHash: string): Session | null {
  if (!rawOrHash) return null;
  // Heuristic: stored sessionId is 64 hex chars. If input matches that shape,
  // treat it as the hash; otherwise hash it as a raw token.
  const looksHashed = /^[a-f0-9]{64}$/i.test(rawOrHash);
  const sessionId = looksHashed ? rawOrHash.toLowerCase() : hashSessionToken(rawOrHash);

  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | SessionRow
    | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return rowToSession(row);
}

export function revokeSession(db: Database.Database, sessionId: string): void {
  db.prepare(
    "UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL",
  ).run(sessionId);
}

/** Delete expired and revoked sessions. Returns rows removed. */
export function pruneExpiredSessions(db: Database.Database): number {
  const result = db
    .prepare(
      "DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') OR revoked_at IS NOT NULL",
    )
    .run();
  return result.changes;
}
