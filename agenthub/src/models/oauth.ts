import type Database from 'better-sqlite3';
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
export function findOrCreateOAuthUser(
  db: Database.Database,
  input: FindOrCreateOAuthUserInput,
): User {
  const { provider, providerUid } = input;
  const email = input.email ? input.email.trim().toLowerCase() : null;

  const existing = db
    .prepare(
      `SELECT u.* FROM oauth_identities oi
         JOIN users u ON u.id = oi.user_id
        WHERE oi.provider = ? AND oi.provider_uid = ?`,
    )
    .get(provider, providerUid) as UserRow | undefined;
  if (existing) return rowToUser(existing);

  const tx = db.transaction(() => {
    let userId: string;

    if (email) {
      const userRow = db
        .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)')
        .get(email) as UserRow | undefined;
      if (userRow) {
        userId = userRow.id;
      } else {
        userId = createOAuthUser(db, email, input.name ?? null);
      }
    } else {
      // No email from provider — create a placeholder user with a
      // synthetic email so the unique index holds.
      const placeholder = `oauth_${provider}_${providerUid}@users.noreply`.toLowerCase();
      userId = createOAuthUser(db, placeholder, input.name ?? null);
    }

    db.prepare(
      'INSERT INTO oauth_identities (provider, provider_uid, user_id, email) VALUES (?, ?, ?, ?)',
    ).run(provider, providerUid, userId, email);

    return userId;
  });

  const userId = tx();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
  return rowToUser(row);
}

function createOAuthUser(
  db: Database.Database,
  email: string,
  name: string | null,
): string {
  const id = `u_${randomBytes(12).toString('hex')}`;
  // No password for OAuth-only users; store a sentinel that can never verify.
  const passwordHash = `oauth:${randomBytes(16).toString('hex')}`;
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, email_verified_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(id, email, passwordHash, name);
  return id;
}
