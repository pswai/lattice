import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  SCHEMA_SQL,
  TASK_COLUMN_MIGRATIONS,
  API_KEY_COLUMN_MIGRATIONS,
  TEAMS_COLUMN_MIGRATIONS,
} from './schema.js';
import { DEFAULT_PLANS } from '../models/plan.js';
import { SqliteAdapter, PgAdapter } from './adapter.js';
import type { DbAdapter } from './adapter.js';
import { PG_SCHEMA_SQL } from './schema-pg.js';

export type { DbAdapter } from './adapter.js';
export { SqliteAdapter } from './adapter.js';

/**
 * Legacy sync init — returns raw better-sqlite3 Database for backward compat.
 * Used by all existing model/route/service code until the Slice 2 migration.
 */
export function initDatabase(dbPath: string): Database.Database {
  return createSqliteAdapter(dbPath).rawDb;
}

/**
 * Create a database adapter based on config.
 * - If `databaseUrl` starts with `postgres://` or `postgresql://`, creates a PgAdapter.
 * - Otherwise, creates a SqliteAdapter using `dbPath`.
 */
export async function createAdapter(opts: {
  databaseUrl?: string;
  dbPath?: string;
}): Promise<DbAdapter> {
  const url = opts.databaseUrl || '';
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return createPgAdapter(url);
  }
  return createSqliteAdapter(opts.dbPath || './data/lattice.db');
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Original SQLite init path — preserved exactly for backward compat.
 * Returns a SqliteAdapter wrapping the better-sqlite3 Database.
 */
export function createSqliteAdapter(dbPath: string): SqliteAdapter {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Additive column migrations for existing databases
  runSqliteColumnMigrations(db, 'tasks', TASK_COLUMN_MIGRATIONS);
  runSqliteColumnMigrations(db, 'teams', TEAMS_COLUMN_MIGRATIONS);
  runSqliteColumnMigrations(db, 'api_keys', API_KEY_COLUMN_MIGRATIONS);

  migrateFtsToTrigram(db);
  migrateInboundActionTypes(db);

  const adapter = new SqliteAdapter(db);
  seedDefaultPlansSyncSqlite(db);

  return adapter;
}

/**
 * Create an in-memory SQLite adapter (for tests).
 */
export function createMemoryAdapter(): SqliteAdapter {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  const adapter = new SqliteAdapter(db);
  seedDefaultPlansSyncSqlite(db);
  return adapter;
}

/**
 * Synchronously seed default plans using raw better-sqlite3 API.
 * This avoids the async-seed-after-return problem in initDatabase().
 */
function seedDefaultPlansSyncSqlite(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO subscription_plans
      (id, name, price_cents, exec_quota, api_call_quota, storage_bytes_quota, seat_quota, retention_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of DEFAULT_PLANS) {
    stmt.run(p.id, p.name, p.priceCents, p.execQuota, p.apiCallQuota, p.storageBytesQuota, p.seatQuota, p.retentionDays);
  }
}

function runSqliteColumnMigrations(
  db: Database.Database,
  table: string,
  migrations: Array<{ name: string; sql: string }>,
): void {
  const existing = new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
  );
  for (const migration of migrations) {
    if (!existing.has(migration.name)) {
      db.exec(migration.sql);
    }
  }
}

function migrateInboundActionTypes(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inbound_endpoints'")
    .get() as { sql: string } | undefined;

  if (!row) return;
  if (row.sql.includes("'run_playbook'")) return;

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

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

async function createPgAdapter(databaseUrl: string): Promise<PgAdapter> {
  // Dynamic import so `pg` is not required when running in SQLite mode
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
  });

  // Run Postgres schema init
  await pool.query(PG_SCHEMA_SQL);

  // Seed default plans (idempotent via ON CONFLICT DO NOTHING)
  const { DEFAULT_PLANS } = await import('../models/plan.js');
  for (const p of DEFAULT_PLANS) {
    await pool.query(
      `INSERT INTO subscription_plans
        (id, name, price_cents, exec_quota, api_call_quota, storage_bytes_quota, seat_quota, retention_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.name, p.priceCents, p.execQuota, p.apiCallQuota, p.storageBytesQuota, p.seatQuota, p.retentionDays],
    );
  }

  return new PgAdapter(pool);
}
