import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { SCHEMA_SQL, TASK_COLUMN_MIGRATIONS, API_KEY_COLUMN_MIGRATIONS } from './schema.js';

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema migrations
  db.exec(SCHEMA_SQL);

  // Additive column migrations for existing databases (CREATE TABLE IF NOT
  // EXISTS won't add new columns to an existing tasks table).
  const existingCols = new Set(
    (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name),
  );
  for (const migration of TASK_COLUMN_MIGRATIONS) {
    if (!existingCols.has(migration.name)) {
      db.exec(migration.sql);
    }
  }

  // Additive column migrations for api_keys (e.g. scope for RBAC).
  const existingApiKeyCols = new Set(
    (db.pragma('table_info(api_keys)') as Array<{ name: string }>).map((c) => c.name),
  );
  for (const migration of API_KEY_COLUMN_MIGRATIONS) {
    if (!existingApiKeyCols.has(migration.name)) {
      db.exec(migration.sql);
    }
  }

  // FTS tokenizer migration: legacy tables use the default unicode61
  // tokenizer which indexes whole words. Trigram indexes substrings, letting
  // short queries like "cli" and middle-of-word fragments match.
  migrateFtsToTrigram(db);

  // inbound_endpoints CHECK constraint migration: older DBs may be missing
  // the 'run_playbook' action type in the CHECK constraint.
  migrateInboundActionTypes(db);

  return db;
}

function migrateInboundActionTypes(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inbound_endpoints'")
    .get() as { sql: string } | undefined;

  if (!row) return;
  if (row.sql.includes("'run_playbook'")) return; // already migrated

  // Recreate the table with the updated CHECK constraint, preserving data.
  db.exec(`
    ALTER TABLE inbound_endpoints RENAME TO inbound_endpoints_old;
    CREATE TABLE inbound_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        endpoint_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK(action_type IN ('create_task', 'broadcast_event', 'save_context', 'run_playbook')),
        action_config TEXT NOT NULL DEFAULT '{}',
        hmac_secret TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO inbound_endpoints SELECT * FROM inbound_endpoints_old;
    DROP TABLE inbound_endpoints_old;
    CREATE INDEX IF NOT EXISTS idx_inbound_endpoints_team ON inbound_endpoints(team_id);
  `);
}

function migrateFtsToTrigram(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='context_entries_fts'")
    .get() as { sql: string } | undefined;

  if (!row) return;
  if (/tokenize\s*=\s*['"]?trigram/i.test(row.sql)) return;

  // Drop and recreate with trigram tokenizer, then rebuild from content table.
  db.exec(`
    DROP TABLE context_entries_fts;
    CREATE VIRTUAL TABLE context_entries_fts USING fts5(
        key,
        value,
        tags,
        content='context_entries',
        content_rowid='id',
        tokenize='trigram'
    );
    INSERT INTO context_entries_fts(context_entries_fts) VALUES('rebuild');
  `);
}
