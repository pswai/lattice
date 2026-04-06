import { describe, it, expect, beforeEach } from 'vitest';
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
  let db: ReturnType<typeof createTestDb>;
  let userId: string;

  beforeEach(async () => {
    db = createTestDb();
    userId = (await createUser(db, { email: 'u@example.com', password: 'longenough-pass' })).id;
  });

  it('creates, resolves, and returns opaque token', async () => {
    const s = await createSession(db, userId, { ip: '1.2.3.4', userAgent: 'ua', ttlDays: 7 });
    expect(s.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.sessionId).toBe(hashSessionToken(s.raw));

    const resolved = await getSession(db, s.raw);
    expect(resolved).not.toBeNull();
    expect(resolved!.userId).toBe(userId);
    expect(resolved!.ip).toBe('1.2.3.4');
  });

  it('resolves by hash too', async () => {
    const s = await createSession(db, userId);
    const r = await getSession(db, s.sessionId);
    expect(r).not.toBeNull();
    expect(r!.userId).toBe(userId);
  });

  it('returns null after revoke', async () => {
    const s = await createSession(db, userId);
    await revokeSession(db, s.sessionId);
    expect(await getSession(db, s.raw)).toBeNull();
  });

  it('returns null on unknown token', async () => {
    expect(await getSession(db, 'never-issued-token')).toBeNull();
    expect(await getSession(db, '')).toBeNull();
  });

  it('returns null on expired session', async () => {
    const s = await createSession(db, userId, { ttlDays: 1 });
    // Force expiry by updating expires_at to the past.
    db.rawDb.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      s.sessionId,
    );
    expect(await getSession(db, s.raw)).toBeNull();
  });

  it('prune removes expired and revoked sessions', async () => {
    const s1 = await createSession(db, userId);
    const s2 = await createSession(db, userId);
    const s3 = await createSession(db, userId);
    await revokeSession(db, s1.sessionId);
    db.rawDb.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      s2.sessionId,
    );

    const removed = await pruneExpiredSessions(db);
    expect(removed).toBe(2);
    expect(await getSession(db, s3.raw)).not.toBeNull();
  });
});
