import type { DbAdapter } from '../db/adapter.js';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
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

export async function updateUserPassword(db: DbAdapter, userId: string, newPasswordHash: string): Promise<void> {
  await db.run(
    "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
    newPasswordHash, new Date().toISOString(), userId,
  );
}

/** Create a password reset token. Returns the raw token (to be emailed). */
export async function createPasswordReset(db: DbAdapter, userId: string): Promise<string> {
  const raw = randomBytes(24).toString('base64url');
  const tokenHash = createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(); // 1 hour

  await db.run(
    'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    tokenHash, userId, expiresAt,
  );

  return raw;
}

/**
 * Validate a password reset token and update the user's password.
 * Marks the token as used. Returns true on success, false if token invalid/expired/used.
 */
export async function consumePasswordReset(
  db: DbAdapter,
  rawToken: string,
  newPasswordHash: string,
): Promise<string | false> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const row = await db.get<{ user_id: string; expires_at: string; used_at: string | null }>(
    'SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?',
    tokenHash,
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
    return false;
  }

  await db.run(
    "UPDATE password_resets SET used_at = ? WHERE token_hash = ?",
    new Date().toISOString(), tokenHash,
  );
  await updateUserPassword(db, row.user_id, newPasswordHash);
  return row.user_id;
}

/** Delete a user account and return the number of rows removed. */
export async function deleteUser(db: DbAdapter, userId: string): Promise<void> {
  // Delete user-scoped data (sessions, email_verifications, password_resets, memberships)
  await db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  await db.run('DELETE FROM email_verifications WHERE user_id = ?', userId);
  await db.run('DELETE FROM password_resets WHERE user_id = ?', userId);
  await db.run('DELETE FROM workspace_memberships WHERE user_id = ?', userId);
  await db.run('DELETE FROM oauth_identities WHERE user_id = ?', userId);
  await db.run('DELETE FROM users WHERE id = ?', userId);
}

/** Delete a workspace and all its associated data. */
export async function deleteWorkspaceData(db: DbAdapter, workspaceId: string): Promise<void> {
  // Delete all workspace-scoped tables. Order matters for FK constraints.
  await db.run('DELETE FROM audit_log WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM usage_counters WHERE workspace_id = ?', workspaceId);
  await db.run(
    'DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id = ?)',
    workspaceId,
  );
  await db.run('DELETE FROM tasks WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM events WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM context_entries WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM artifacts WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM messages WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM agents WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM playbooks WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM workflow_runs WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM schedules WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM agent_profiles WHERE workspace_id = ?', workspaceId);
  await db.run(
    'DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE workspace_id = ?)',
    workspaceId,
  );
  await db.run('DELETE FROM webhooks WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM inbound_endpoints WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM api_keys WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM workspace_memberships WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM workspace_invitations WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM workspace_subscriptions WHERE workspace_id = ?', workspaceId);
  await db.run('DELETE FROM workspaces WHERE id = ?', workspaceId);
}
