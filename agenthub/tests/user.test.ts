import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import {
  createUser,
  getUserByEmail,
  getUserById,
  authenticateUser,
  setEmailVerified,
  verifyPassword,
} from '../src/models/user.js';
import { ValidationError } from '../src/errors.js';

describe('User model', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates a user and allows login roundtrip', () => {
    const user = createUser(db, { email: 'Alice@Example.com', password: 'correct-horse-battery', name: 'Alice' });
    expect(user.id).toMatch(/^u_[a-f0-9]{24}$/);
    expect(user.email).toBe('alice@example.com'); // stored lowercased
    expect(user.name).toBe('Alice');
    expect(user.emailVerifiedAt).toBeNull();

    const auth = authenticateUser(db, 'alice@example.com', 'correct-horse-battery');
    expect(auth).not.toBeNull();
    expect(auth!.id).toBe(user.id);
  });

  it('rejects duplicate emails case-insensitively', () => {
    createUser(db, { email: 'bob@example.com', password: 'passw0rd-ok-long' });
    expect(() =>
      createUser(db, { email: 'BOB@EXAMPLE.COM', password: 'different-one-x' }),
    ).toThrow(ValidationError);
  });

  it('looks up users case-insensitively', () => {
    const created = createUser(db, { email: 'carol@example.com', password: 'another-pass-x' });
    const found = getUserByEmail(db, 'CAROL@example.com');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(getUserById(db, created.id)!.email).toBe('carol@example.com');
  });

  it('returns null on wrong password', () => {
    createUser(db, { email: 'dave@example.com', password: 'rightpassw0rd' });
    expect(authenticateUser(db, 'dave@example.com', 'wrongpass123')).toBeNull();
    expect(authenticateUser(db, 'unknown@example.com', 'rightpassw0rd')).toBeNull();
  });

  it('rejects short passwords', () => {
    expect(() => createUser(db, { email: 'e@e.com', password: 'short' })).toThrow(ValidationError);
  });

  it('sets email_verified_at', () => {
    const user = createUser(db, { email: 'f@example.com', password: 'verylongpass' });
    expect(user.emailVerifiedAt).toBeNull();
    setEmailVerified(db, user.id);
    const fetched = getUserById(db, user.id);
    expect(fetched!.emailVerifiedAt).not.toBeNull();
  });

  it('verifyPassword tolerates malformed stored hashes', () => {
    expect(verifyPassword('anything', 'garbage')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'aa:bb')).toBe(false);
  });
});
