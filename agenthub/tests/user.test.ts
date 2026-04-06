import { describe, it, expect, beforeEach } from 'vitest';
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
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates a user and allows login roundtrip', async () => {
    const user = await createUser(db, { email: 'Alice@Example.com', password: 'correct-horse-battery', name: 'Alice' });
    expect(user.id).toMatch(/^u_[a-f0-9]{24}$/);
    expect(user.email).toBe('alice@example.com'); // stored lowercased
    expect(user.name).toBe('Alice');
    expect(user.emailVerifiedAt).toBeNull();

    const auth = await authenticateUser(db, 'alice@example.com', 'correct-horse-battery');
    expect(auth).not.toBeNull();
    expect(auth!.id).toBe(user.id);
  });

  it('rejects duplicate emails case-insensitively', async () => {
    await createUser(db, { email: 'bob@example.com', password: 'passw0rd-ok-long' });
    await expect(
      createUser(db, { email: 'BOB@EXAMPLE.COM', password: 'different-one-x' }),
    ).rejects.toThrow(ValidationError);
  });

  it('looks up users case-insensitively', async () => {
    const created = await createUser(db, { email: 'carol@example.com', password: 'another-pass-x' });
    const found = await getUserByEmail(db, 'CAROL@example.com');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect((await getUserById(db, created.id))!.email).toBe('carol@example.com');
  });

  it('returns null on wrong password', async () => {
    await createUser(db, { email: 'dave@example.com', password: 'rightpassw0rd' });
    expect(await authenticateUser(db, 'dave@example.com', 'wrongpass123')).toBeNull();
    expect(await authenticateUser(db, 'unknown@example.com', 'rightpassw0rd')).toBeNull();
  });

  it('rejects short passwords', async () => {
    await expect(createUser(db, { email: 'e@e.com', password: 'short' })).rejects.toThrow(ValidationError);
  });

  it('sets email_verified_at', async () => {
    const user = await createUser(db, { email: 'f@example.com', password: 'verylongpass' });
    expect(user.emailVerifiedAt).toBeNull();
    await setEmailVerified(db, user.id);
    const fetched = await getUserById(db, user.id);
    expect(fetched!.emailVerifiedAt).not.toBeNull();
  });

  it('verifyPassword tolerates malformed stored hashes', () => {
    expect(verifyPassword('anything', 'garbage')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'aa:bb')).toBe(false);
  });
});
