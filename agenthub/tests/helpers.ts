import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { DEFAULT_PLANS } from '../src/models/plan.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { SqliteAdapter } from '../src/db/adapter.js';
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
  teamId: string;
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
  // Seed default plans synchronously via raw SQL (seedDefaultPlans is async now)
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO subscription_plans
      (id, name, price_cents, exec_quota, api_call_quota, storage_bytes_quota, seat_quota, retention_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of DEFAULT_PLANS) {
    stmt.run(p.id, p.name, p.priceCents, p.execQuota, p.apiCallQuota, p.storageBytesQuota, p.seatQuota, p.retentionDays);
  }
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
export function setupTeam(
  db: DbAdapter | Database.Database,
  teamId: string = 'test-team',
  apiKey: string = 'ltk_test_key_12345678901234567890',
  scope: 'read' | 'write' | 'admin' = 'write',
): { teamId: string; apiKey: string; keyHash: string } {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const rawDb = getRawDb(db);

  rawDb.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(teamId, `Team ${teamId}`);
  rawDb.prepare('INSERT INTO api_keys (team_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
    teamId,
    keyHash,
    'test key',
    scope,
  );

  return { teamId, apiKey, keyHash };
}

/**
 * Add an additional API key with a specific scope to an existing team.
 */
export function addApiKey(
  db: DbAdapter | Database.Database,
  teamId: string,
  apiKey: string,
  scope: 'read' | 'write' | 'admin' = 'write',
): { apiKey: string; keyHash: string } {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const rawDb = getRawDb(db);
  rawDb.prepare('INSERT INTO api_keys (team_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
    teamId,
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
    cookieSecure: false,
    emailVerificationReturnTokens: true,
    githubOAuthClientId: '',
    githubOAuthClientSecret: '',
    githubOAuthRedirectUri: '',
    emailProvider: 'stub',
    emailResendApiKey: '',
    emailFromAddress: 'noreply@lattice.local',
    appBaseUrl: 'http://localhost:3000',
    corsOrigins: [],
    quotaEnforcement: false,
    ...overrides,
  };
}

export function createTestContext(teamId?: string, apiKey?: string): TestContext {
  const adapter = createTestAdapter();
  const team = setupTeam(adapter, teamId, apiKey);
  const config = testConfig();
  const app = createApp(adapter, () => createMcpServer(adapter), config);

  return {
    db: adapter,
    rawDb: adapter.rawDb,
    app,
    teamId: team.teamId,
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
