import type { DbAdapter } from '../db/adapter.js';
import { randomBytes } from 'crypto';
import type { User } from './user.js';

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

export interface FindOrCreateOAuthUserInput {
  provider: string;
  providerUid: string;
  email: string | null;
  name?: string | null;
}

/**
 * Idempotently resolve a user from an OAuth identity.
 *
 * 1. If (provider, providerUid) identity already exists → return linked user.
 * 2. Else if a user with the same email exists → link identity to that user.
 * 3. Else create a new user (email-verified, no password) and link identity.
 */
export async function findOrCreateOAuthUser(
  db: DbAdapter,
  input: FindOrCreateOAuthUserInput,
): Promise<User> {
  const { provider, providerUid } = input;
  const email = input.email ? input.email.trim().toLowerCase() : null;

  const existing = await db.get<UserRow>(
    `SELECT u.* FROM oauth_identities oi
       JOIN users u ON u.id = oi.user_id
      WHERE oi.provider = ? AND oi.provider_uid = ?`,
    provider, providerUid,
  );
  if (existing) return rowToUser(existing);

  const userId = await db.transaction(async (tx) => {
    let uid: string;

    if (email) {
      const userRow = await tx.get<UserRow>(
        'SELECT * FROM users WHERE LOWER(email) = LOWER(?)',
        email,
      );
      if (userRow) {
        uid = userRow.id;
      } else {
        uid = await createOAuthUser(tx, email, input.name ?? null);
      }
    } else {
      // No email from provider — create a placeholder user with a
      // synthetic email so the unique index holds.
      const placeholder = `oauth_${provider}_${providerUid}@users.noreply`.toLowerCase();
      uid = await createOAuthUser(tx, placeholder, input.name ?? null);
    }

    await tx.run(
      'INSERT INTO oauth_identities (provider, provider_uid, user_id, email) VALUES (?, ?, ?, ?)',
      provider, providerUid, uid, email,
    );

    return uid;
  });

  const row = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  return rowToUser(row!);
}

async function createOAuthUser(
  db: DbAdapter,
  email: string,
  name: string | null,
): Promise<string> {
  const id = `u_${randomBytes(12).toString('hex')}`;
  // No password for OAuth-only users; store a sentinel that can never verify.
  const passwordHash = `oauth:${randomBytes(16).toString('hex')}`;
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, email_verified_at)
     VALUES (?, ?, ?, ?, ?)`,
    id, email, passwordHash, name, new Date().toISOString(),
  );
  return id;
}
