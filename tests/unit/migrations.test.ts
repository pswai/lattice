import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  MigrationDowngradeError,
  runMigrations,
} from '../../src/bus/index.js';
import { createTmpDb, type TmpDb } from '../fixtures/tmp-db.js';

describe('runMigrations', () => {
  let tmp: TmpDb;

  beforeEach(() => {
    tmp = createTmpDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  test('applies migration 0001 on a fresh database', () => {
    const result = runMigrations(tmp.db);

    expect(result.applied).toEqual([1]);
    expect(result.skipped).toEqual([]);
    expect(result.head).toBe(1);

    const tables = tmp.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      'bus_dead_letters',
      'bus_messages',
      'bus_subscriptions',
      'bus_tokens',
      'bus_topics',
      'schema_migrations',
    ]);

    const busTables = tmp.db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 'bus_%'",
      )
      .all() as { name: string; sql: string }[];
    expect(busTables.length).toBe(5);
    for (const row of busTables) {
      expect(row.sql.toUpperCase()).toContain('STRICT');
    }

    const indexes = tmp.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual([
      'idx_bus_msg_created',
      'idx_bus_msg_recipient',
      'idx_bus_msg_topic',
      'idx_bus_sub_agent',
      'idx_bus_tokens_agent',
      'idx_bus_topics_topic',
    ]);
  });

  test('second run is a no-op', () => {
    runMigrations(tmp.db);
    const result = runMigrations(tmp.db);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([1]);
    expect(result.head).toBe(1);
  });

  test('throws MigrationDowngradeError when DB version exceeds code version', () => {
    tmp.db.exec(
      `CREATE TABLE schema_migrations (
         version    INTEGER PRIMARY KEY,
         applied_at INTEGER NOT NULL
       ) STRICT;`,
    );
    tmp.db
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(99, Date.now());

    expect(() => runMigrations(tmp.db)).toThrow(MigrationDowngradeError);
  });

  test('openDatabase enforces WAL journal mode', () => {
    const row = tmp.db.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(row.journal_mode.toLowerCase()).toBe('wal');
  });

  test('records applied_at timestamp in schema_migrations', () => {
    const before = Date.now();
    runMigrations(tmp.db);
    const after = Date.now();
    const row = tmp.db
      .prepare(
        'SELECT version, applied_at FROM schema_migrations WHERE version = ?',
      )
      .get(1) as { version: number; applied_at: number };
    expect(row.version).toBe(1);
    expect(row.applied_at).toBeGreaterThanOrEqual(before);
    expect(row.applied_at).toBeLessThanOrEqual(after);
  });
});
