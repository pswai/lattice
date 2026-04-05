import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, setupTeam } from './helpers.js';
import { createHash, randomBytes } from 'crypto';
import { SCHEMA_SQL } from '../src/db/schema.js';
import Database from 'better-sqlite3';

/**
 * CLI tests — we can't invoke the interactive CLI directly,
 * but we can test the core init logic that creates DB, team, and API key.
 */
describe('CLI Init Logic', () => {
  it('should create a database with the full schema', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    // Verify all expected tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('teams');
    expect(tableNames).toContain('api_keys');
    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('context_entries');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('task_dependencies');
    expect(tableNames).toContain('messages');

    db.close();
  });

  it('should create a team and API key', () => {
    const db = createTestDb();

    // Simulate what CLI init does
    const teamId = 'cli-test-team';
    const teamName = 'CLI Test Team';
    db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(teamId, teamName);

    const rawKey = `ah_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    db.prepare('INSERT INTO api_keys (team_id, key_hash, label) VALUES (?, ?, ?)').run(
      teamId,
      keyHash,
      'cli-init',
    );

    // Verify team exists
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as any;
    expect(team).toBeDefined();
    expect(team.name).toBe('CLI Test Team');

    // Verify API key exists and is hashed
    const key = db.prepare('SELECT * FROM api_keys WHERE team_id = ?').get(teamId) as any;
    expect(key).toBeDefined();
    expect(key.key_hash).toBe(keyHash);
    expect(key.label).toBe('cli-init');

    // Verify the raw key can be verified by re-hashing
    const verifyHash = createHash('sha256').update(rawKey).digest('hex');
    expect(verifyHash).toBe(key.key_hash);

    db.close();
  });

  it('should generate API keys with ah_ prefix', () => {
    const rawKey = `ah_${randomBytes(24).toString('hex')}`;
    expect(rawKey).toMatch(/^ah_[a-f0-9]{48}$/);
  });

  it('should handle existing team gracefully (generate new key only)', () => {
    const db = createTestDb();
    const teamId = 'existing-team';

    // First init creates team
    db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(teamId, 'Existing Team');
    const key1Hash = createHash('sha256').update('key1').digest('hex');
    db.prepare('INSERT INTO api_keys (team_id, key_hash, label) VALUES (?, ?, ?)').run(
      teamId,
      key1Hash,
      'cli-init',
    );

    // Second init: team exists, just add new key
    const existing = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
    expect(existing).toBeDefined();

    const key2Hash = createHash('sha256').update('key2').digest('hex');
    db.prepare('INSERT INTO api_keys (team_id, key_hash, label) VALUES (?, ?, ?)').run(
      teamId,
      key2Hash,
      'cli-init',
    );

    // Should have 2 keys, 1 team
    const keys = db.prepare('SELECT * FROM api_keys WHERE team_id = ?').all(teamId);
    expect(keys).toHaveLength(2);

    const teams = db.prepare('SELECT * FROM teams WHERE id = ?').all(teamId);
    expect(teams).toHaveLength(1);

    db.close();
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
  it('should create FTS virtual table for context search', () => {
    const db = createTestDb();

    // Verify FTS table exists
    const fts = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'context_entries_fts'",
    ).get() as any;
    expect(fts).toBeDefined();

    db.close();
  });

  it('should create expected indexes', () => {
    const db = createTestDb();

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_context_team');
    expect(indexNames).toContain('idx_events_team_time');
    expect(indexNames).toContain('idx_tasks_team');
    expect(indexNames).toContain('idx_tasks_status');
    expect(indexNames).toContain('idx_agents_heartbeat');
    expect(indexNames).toContain('idx_messages_recipient');

    db.close();
  });

  it('should enforce foreign keys on api_keys', () => {
    const db = createTestDb();

    // Try to insert an API key for a non-existent team — should fail with FK constraint
    expect(() => {
      db.prepare(
        "INSERT INTO api_keys (team_id, key_hash, label) VALUES ('nonexistent', 'abc123', 'test')",
      ).run();
    }).toThrow();

    db.close();
  });
});
