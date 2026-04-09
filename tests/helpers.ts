import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { SCHEMA_SQL, TASK_COLUMN_MIGRATIONS, CONTEXT_COLUMN_MIGRATIONS, MESSAGE_COLUMN_MIGRATIONS, API_KEY_COLUMN_MIGRATIONS, PLAYBOOK_COLUMN_MIGRATIONS } from '../src/db/schema.js';
import { PG_SCHEMA_SQL } from '../src/db/schema-pg.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { SqliteAdapter, PgAdapter } from '../src/db/adapter.js';
import type { DbAdapter } from '../src/db/adapter.js';
import type { AppConfig } from '../src/config.js';
import type { Hono } from 'hono';

export const TEST_ADMIN_KEY = 'test-admin-key-secret';

export interface TestContext {
  /** DbAdapter — pass to model functions and createApp. */
  db: DbAdapter;
  /** Raw better-sqlite3 handle — for direct SQL in test setup/assertions. */
  rawDb: Database.Database;
  app: Hono;
  workspaceId: string;
  apiKey: string;
  agentId: string;
}

/**
 * Create an in-memory SQLite adapter with the full schema.
 */
export function createTestAdapter(): SqliteAdapter {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Run additive column migrations (same as production createSqliteAdapter)
  const existing = (table: string) =>
    new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name));
  for (const { name, sql } of TASK_COLUMN_MIGRATIONS) if (!existing('tasks').has(name)) db.exec(sql);
  for (const { name, sql } of API_KEY_COLUMN_MIGRATIONS) if (!existing('api_keys').has(name)) db.exec(sql);
  for (const { name, sql } of CONTEXT_COLUMN_MIGRATIONS) if (!existing('context_entries').has(name)) db.exec(sql);
  for (const { name, sql } of MESSAGE_COLUMN_MIGRATIONS) if (!existing('messages').has(name)) db.exec(sql);
  for (const { name, sql } of PLAYBOOK_COLUMN_MIGRATIONS) if (!existing('playbooks').has(name)) db.exec(sql);

  return new SqliteAdapter(db);
}

/**
 * Legacy alias — returns a SqliteAdapter (which satisfies DbAdapter).
 * Tests that need raw DB access can use `.rawDb` on the returned adapter.
 */
export function createTestDb(): SqliteAdapter {
  return createTestAdapter();
}

/**
 * Set up a test team with an API key.
 * Accepts either a DbAdapter or raw Database for backward compat.
 */
export function setupWorkspace(
  db: DbAdapter | Database.Database,
  workspaceId: string = 'test-team',
  apiKey: string = 'ltk_test_key_12345678901234567890',
  scope: 'read' | 'write' | 'admin' = 'write',
): { workspaceId: string; apiKey: string; keyHash: string } {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const rawDb = getRawDb(db);

  rawDb.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(workspaceId, `Team ${workspaceId}`);
  rawDb.prepare('INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
    workspaceId,
    keyHash,
    'test key',
    scope,
  );

  return { workspaceId, apiKey, keyHash };
}

/**
 * Add an additional API key with a specific scope to an existing team.
 */
export function addApiKey(
  db: DbAdapter | Database.Database,
  workspaceId: string,
  apiKey: string,
  scope: 'read' | 'write' | 'admin' = 'write',
): { apiKey: string; keyHash: string } {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const rawDb = getRawDb(db);
  rawDb.prepare('INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
    workspaceId,
    keyHash,
    `${scope} key`,
    scope,
  );
  return { apiKey, keyHash };
}

/** Extract raw better-sqlite3 Database from either a DbAdapter or raw Database. */
function getRawDb(db: DbAdapter | Database.Database): Database.Database {
  if ('rawDb' in db && db.rawDb) return (db as SqliteAdapter).rawDb;
  return db as Database.Database;
}

/**
 * Create a full test context with app, db, team, and auth
 */
export function testConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    port: 3000,
    dbPath: ':memory:',
    databaseUrl: '',
    pollIntervalMs: 5000,
    taskReapTimeoutMinutes: 30,
    taskReapIntervalMs: 60000,
    eventRetentionDays: 30,
    agentHeartbeatTimeoutMinutes: 10,
    adminKey: TEST_ADMIN_KEY,
    logLevel: 'error',
    logFormat: '',
    auditEnabled: true,
    auditRetentionDays: 365,
    metricsEnabled: true,
    rateLimitPerMinute: 0,
    maxBodyBytes: 0,
    hstsEnabled: false,
    corsOrigins: [],
    rateLimitPerMinuteWorkspace: 0,
    mcpRateLimitPerMinute: 0,
    ...overrides,
  };
}

export function createTestContext(workspaceId?: string, apiKey?: string): TestContext {
  const adapter = createTestAdapter();
  const team = setupWorkspace(adapter, workspaceId, apiKey);
  const config = testConfig();
  const app = createApp(adapter, () => createMcpServer(adapter), config);

  return {
    db: adapter,
    rawDb: adapter.rawDb,
    app,
    workspaceId: team.workspaceId,
    apiKey: team.apiKey,
    agentId: 'test-agent',
  };
}

/**
 * Make an authenticated request to the app
 */
export function authHeaders(apiKey: string, agentId: string = 'test-agent'): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-Agent-ID': agentId,
    'Content-Type': 'application/json',
  };
}

/**
 * Helper to make requests against the Hono app
 */
export async function request(
  app: Hono,
  method: string,
  path: string,
  opts: {
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: opts.headers || {},
  };
  if (opts.body) {
    init.body = JSON.stringify(opts.body);
  }
  return app.request(path, init);
}

// ---------------------------------------------------------------------------
// Postgres test helpers
// ---------------------------------------------------------------------------

const PG_TRUNCATE_SQL = `
  TRUNCATE workspaces, api_keys, context_entries, events, tasks, task_dependencies,
           agents, messages, playbooks, artifacts, agent_profiles, workflow_runs,
           webhooks, webhook_deliveries, schedules, inbound_endpoints, audit_log
  CASCADE;
`;

/**
 * Create a PgAdapter connected to TEST_DATABASE_URL.
 * Returns null if the env var is not set.
 */
export async function createTestPgAdapter(): Promise<PgAdapter | null> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await pool.query(PG_SCHEMA_SQL);

  return new PgAdapter(pool);
}

/**
 * Truncate all tables between tests (fast, keeps schema).
 */
export async function truncatePgTables(db: DbAdapter): Promise<void> {
  await db.exec(PG_TRUNCATE_SQL);
}

/**
 * Create a full test context backed by Postgres.
 */
export async function createPgTestContext(db: DbAdapter): Promise<{
  app: Hono;
  workspaceId: string;
  apiKey: string;
  agentId: string;
}> {
  const workspaceId = 'test-team';
  const apiKey = 'ltk_test_key_12345678901234567890';
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  await db.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', workspaceId, `Team ${workspaceId}`);
  await db.run(
    'INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)',
    workspaceId, keyHash, 'test key', 'write',
  );

  const config = testConfig();
  const app = createApp(db, () => createMcpServer(db), config);

  return { app, workspaceId, apiKey, agentId: 'test-agent' };
}

// ---------------------------------------------------------------------------
// Adapter-level seed helpers (work with both SQLite and Postgres)
// ---------------------------------------------------------------------------

export async function seedTask(
  db: DbAdapter,
  workspaceId: string,
  opts: {
    description?: string;
    status: string;
    createdBy: string;
    claimedBy?: string | null;
    createdAt: string;
    updatedAt: string;
  },
): Promise<number> {
  const result = await db.run(
    `INSERT INTO tasks (workspace_id, description, status, created_by, claimed_by, claimed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    workspaceId,
    opts.description ?? 'test task',
    opts.status,
    opts.createdBy,
    opts.claimedBy ?? null,
    opts.claimedBy ? opts.createdAt : null,
    opts.createdAt,
    opts.updatedAt,
  );
  return Number(result.lastInsertRowid);
}

export async function seedEvent(
  db: DbAdapter,
  workspaceId: string,
  opts: { eventType: string; message: string; createdBy: string; createdAt: string },
): Promise<void> {
  await db.run(
    `INSERT INTO events (workspace_id, event_type, message, tags, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    workspaceId, opts.eventType, opts.message, '[]', opts.createdBy, opts.createdAt,
  );
}

export async function seedAgent(
  db: DbAdapter,
  workspaceId: string,
  opts: { id: string; status: string },
): Promise<void> {
  await db.run(
    `INSERT INTO agents (id, workspace_id, capabilities, status, metadata) VALUES (?, ?, ?, ?, ?)`,
    opts.id, workspaceId, '[]', opts.status, '{}',
  );
}

export async function seedContext(
  db: DbAdapter,
  workspaceId: string,
  opts: { key: string; value: string; createdBy: string; createdAt: string },
): Promise<void> {
  await db.run(
    `INSERT INTO context_entries (workspace_id, key, value, tags, created_by, created_at)
     VALUES (?, ?, ?, '[]', ?, ?)`,
    workspaceId, opts.key, opts.value, opts.createdBy, opts.createdAt,
  );
}

export async function seedMessage(
  db: DbAdapter,
  workspaceId: string,
  opts: { from: string; to: string; message: string; createdAt: string },
): Promise<void> {
  await db.run(
    `INSERT INTO messages (workspace_id, from_agent, to_agent, message, tags, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`,
    workspaceId, opts.from, opts.to, opts.message, opts.createdAt,
  );
}
