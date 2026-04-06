import type { DbAdapter } from '../db/adapter.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { ValidationError } from '../errors.js';

export interface User {
  id: string;
  email: string;
  name: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SCRYPT_KEYLEN = 64;

/** Hash a password with a fresh salt. Returns `${salt_hex}:${hash_hex}`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Constant-time verify a password against a stored `salt:hash` string. */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let saltBuf: Buffer;
  let hashBuf: Buffer;
  try {
    saltBuf = Buffer.from(saltHex, 'hex');
    hashBuf = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (hashBuf.length !== SCRYPT_KEYLEN) return false;
  const derived = scryptSync(password, saltBuf, SCRYPT_KEYLEN);
  return timingSafeEqual(derived, hashBuf);
}

export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
}

export async function createUser(db: DbAdapter, input: CreateUserInput): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new ValidationError('Email is required');
  if (!input.password || input.password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  const id = `u_${randomBytes(12).toString('hex')}`;
  const passwordHash = hashPassword(input.password);
  const name = input.name ?? null;

  try {
    await db.run(
      'INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)',
      id, email, passwordHash, name,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new ValidationError('Email already registered');
    }
    throw err;
  }

  const row = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  return rowToUser(row!);
}

export async function getUserByEmail(db: DbAdapter, email: string): Promise<User | null> {
  const row = await db.get<UserRow>(
    'SELECT * FROM users WHERE LOWER(email) = LOWER(?)',
    email.trim(),
  );
  return row ? rowToUser(row) : null;
}

export async function getUserById(db: DbAdapter, id: string): Promise<User | null> {
  const row = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  return row ? rowToUser(row) : null;
}

/** Verify user credentials. Returns the user on success, null on mismatch. */
export async function authenticateUser(
  db: DbAdapter,
  email: string,
  password: string,
): Promise<User | null> {
  const row = await db.get<UserRow>(
    'SELECT * FROM users WHERE LOWER(email) = LOWER(?)',
    email.trim(),
  );
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return rowToUser(row);
}

export async function setEmailVerified(db: DbAdapter, userId: string): Promise<void> {
  await db.run(
    "UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?",
    new Date().toISOString(), new Date().toISOString(), userId,
  );
}
