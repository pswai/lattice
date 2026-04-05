import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { seedDefaultPlans } from '../src/models/plan.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { AppConfig } from '../src/config.js';
import type { Hono } from 'hono';

export const TEST_ADMIN_KEY = 'test-admin-key-secret';

export interface TestContext {
  db: Database.Database;
  app: Hono;
  teamId: string;
  apiKey: string;
  agentId: string;
}

/**
 * Create an in-memory SQLite database with the full schema
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  seedDefaultPlans(db);
  return db;
}

/**
 * Set up a test team with an API key
 */
export function setupTeam(
  db: Database.Database,
  teamId: string = 'test-team',
  apiKey: string = 'ahk_test_key_12345678901234567890',
  scope: 'read' | 'write' | 'admin' = 'write',
): { teamId: string; apiKey: string; keyHash: string } {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(teamId, `Team ${teamId}`);
  db.prepare('INSERT INTO api_keys (team_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
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
  db: Database.Database,
  teamId: string,
  apiKey: string,
  scope: 'read' | 'write' | 'admin' = 'write',
): { apiKey: string; keyHash: string } {
  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  db.prepare('INSERT INTO api_keys (team_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
    teamId,
    keyHash,
    `${scope} key`,
    scope,
  );
  return { apiKey, keyHash };
}

/**
 * Create a full test context with app, db, team, and auth
 */
export function testConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    port: 3000,
    dbPath: ':memory:',
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
    emailFromAddress: 'noreply@agenthub.local',
    appBaseUrl: 'http://localhost:3000',
    corsOrigins: [],
    quotaEnforcement: false,
    ...overrides,
  };
}

export function createTestContext(teamId?: string, apiKey?: string): TestContext {
  const db = createTestDb();
  const team = setupTeam(db, teamId, apiKey);
  const config = testConfig();
  const app = createApp(db, () => createMcpServer(db), config);

  return {
    db,
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
