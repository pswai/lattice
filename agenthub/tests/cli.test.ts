import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, setupWorkspace } from './helpers.js';
import { createHash, randomBytes } from 'crypto';
import { SCHEMA_SQL } from '../src/db/schema.js';
import Database from 'better-sqlite3';

/**
 * CLI tests — we can't invoke the interactive CLI directly,
 * but we can test the core init logic that creates DB, team, and API key.
 */
describe('CLI Init Logic', () => {
  it('should create a database with the full schema', async () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    // Verify all expected tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('workspaces');
    expect(tableNames).toContain('api_keys');
    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('context_entries');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('task_dependencies');
    expect(tableNames).toContain('messages');

    await db.close();
  });

  it('should create a team and API key', async () => {
    const db = createTestDb();

    // Simulate what CLI init does
    const workspaceId = 'cli-test-team';
    const workspaceName = 'CLI Test Team';
    db.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(workspaceId, workspaceName);

    const rawKey = `lt_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    db.prepare('INSERT INTO api_keys (workspace_id, key_hash, label) VALUES (?, ?, ?)').run(
      workspaceId,
      keyHash,
      'cli-init',
    );

    // Verify team exists
    const team = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as any;
    expect(team).toBeDefined();
    expect(team.name).toBe('CLI Test Team');

    // Verify API key exists and is hashed
    const key = db.prepare('SELECT * FROM api_keys WHERE workspace_id = ?').get(workspaceId) as any;
    expect(key).toBeDefined();
    expect(key.key_hash).toBe(keyHash);
    expect(key.label).toBe('cli-init');

    // Verify the raw key can be verified by re-hashing
    const verifyHash = createHash('sha256').update(rawKey).digest('hex');
    expect(verifyHash).toBe(key.key_hash);

    await db.close();
  });

  it('should generate API keys with lt_ prefix', () => {
    const rawKey = `lt_${randomBytes(24).toString('hex')}`;
    expect(rawKey).toMatch(/^lt_[a-f0-9]{48}$/);
  });

  it('should handle existing team gracefully (generate new key only)', async () => {
    const db = createTestDb();
    const workspaceId = 'existing-team';

    // First init creates team
    db.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(workspaceId, 'Existing Team');
    const key1Hash = createHash('sha256').update('key1').digest('hex');
    db.prepare('INSERT INTO api_keys (workspace_id, key_hash, label) VALUES (?, ?, ?)').run(
      workspaceId,
      key1Hash,
      'cli-init',
    );

    // Second init: team exists, just add new key
    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    expect(existing).toBeDefined();

    const key2Hash = createHash('sha256').update('key2').digest('hex');
    db.prepare('INSERT INTO api_keys (workspace_id, key_hash, label) VALUES (?, ?, ?)').run(
      workspaceId,
      key2Hash,
      'cli-init',
    );

    // Should have 2 keys, 1 team
    const keys = db.prepare('SELECT * FROM api_keys WHERE workspace_id = ?').all(workspaceId);
    expect(keys).toHaveLength(2);

    const teams = db.prepare('SELECT * FROM workspaces WHERE id = ?').all(workspaceId);
    expect(teams).toHaveLength(1);

    await db.close();
  });

  it('should validate team ID format', () => {
    // Valid IDs
    expect(/^[a-z0-9_-]+$/.test('my-team')).toBe(true);
    expect(/^[a-z0-9_-]+$/.test('team_123')).toBe(true);
    expect(/^[a-z0-9_-]+$/.test('a')).toBe(true);

    // Invalid IDs
    expect(/^[a-z0-9_-]+$/.test('My Team')).toBe(false);
    expect(/^[a-z0-9_-]+$/.test('UPPERCASE')).toBe(false);
    expect(/^[a-z0-9_-]+$/.test('has spaces')).toBe(false);
    expect(/^[a-z0-9_-]+$/.test('')).toBe(false);
    expect(/^[a-z0-9_-]+$/.test('special!@#')).toBe(false);
  });
});

describe('CLI — Schema Integrity', () => {
  it('should create FTS virtual table for context search', async () => {
    const db = createTestDb();

    // Verify FTS table exists
    const fts = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'context_entries_fts'",
    ).get() as any;
    expect(fts).toBeDefined();

    await db.close();
  });

  it('should create expected indexes', async () => {
    const db = createTestDb();

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_context_workspace');
    expect(indexNames).toContain('idx_events_workspace_time');
    expect(indexNames).toContain('idx_tasks_workspace');
    expect(indexNames).toContain('idx_tasks_status');
    expect(indexNames).toContain('idx_agents_heartbeat');
    expect(indexNames).toContain('idx_messages_recipient');

    await db.close();
  });

  it('should enforce foreign keys on api_keys', async () => {
    const db = createTestDb();

    // Try to insert an API key for a non-existent team — should fail with FK constraint
    expect(() => {
      db.prepare(
        "INSERT INTO api_keys (workspace_id, key_hash, label) VALUES ('nonexistent', 'abc123', 'test')",
      ).run();
    }).toThrow();

    await db.close();
  });
});
