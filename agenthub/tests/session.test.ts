import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import { createUser } from '../src/models/user.js';
import {
  createSession,
  getSession,
  revokeSession,
  pruneExpiredSessions,
  hashSessionToken,
} from '../src/models/session.js';

describe('Session model', () => {
  let db: Database.Database;
  let userId: string;

  beforeEach(() => {
    db = createTestDb();
    userId = createUser(db, { email: 'u@example.com', password: 'longenough-pass' }).id;
  });

  it('creates, resolves, and returns opaque token', () => {
    const s = createSession(db, userId, { ip: '1.2.3.4', userAgent: 'ua', ttlDays: 7 });
    expect(s.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.sessionId).toBe(hashSessionToken(s.raw));

    const resolved = getSession(db, s.raw);
    expect(resolved).not.toBeNull();
    expect(resolved!.userId).toBe(userId);
    expect(resolved!.ip).toBe('1.2.3.4');
  });

  it('resolves by hash too', () => {
    const s = createSession(db, userId);
    const r = getSession(db, s.sessionId);
    expect(r).not.toBeNull();
    expect(r!.userId).toBe(userId);
  });

  it('returns null after revoke', () => {
    const s = createSession(db, userId);
    revokeSession(db, s.sessionId);
    expect(getSession(db, s.raw)).toBeNull();
  });

  it('returns null on unknown token', () => {
    expect(getSession(db, 'never-issued-token')).toBeNull();
    expect(getSession(db, '')).toBeNull();
  });

  it('returns null on expired session', () => {
    const s = createSession(db, userId, { ttlDays: 1 });
    // Force expiry by updating expires_at to the past.
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      s.sessionId,
    );
    expect(getSession(db, s.raw)).toBeNull();
  });

  it('prune removes expired and revoked sessions', () => {
    const s1 = createSession(db, userId);
    const s2 = createSession(db, userId);
    const s3 = createSession(db, userId);
    revokeSession(db, s1.sessionId);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      s2.sessionId,
    );

    const removed = pruneExpiredSessions(db);
    expect(removed).toBe(2);
    expect(getSession(db, s3.raw)).not.toBeNull();
  });
});
