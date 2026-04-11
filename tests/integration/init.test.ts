import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/bus/db.js';
import { runInit } from '../../src/cli/init.js';

describe('lattice init', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-init-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('creates a workspace, applies migrations, writes exactly one admin token row', () => {
    const dbPath = join(dir, 'team.db');

    runInit([dbPath]);

    expect(existsSync(dbPath)).toBe(true);

    const db = openDatabase(dbPath);

    // schema_migrations has exactly one row (migration 0001)
    const migrations = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.version).toBe(1);

    // bus_tokens has exactly one row
    const tokens = db
      .prepare('SELECT agent_id, scope, revoked_at FROM bus_tokens')
      .all() as { agent_id: string; scope: string; revoked_at: number | null }[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.agent_id).toBe('workspace-admin');
    expect(tokens[0]!.scope).toBe('admin');
    expect(tokens[0]!.revoked_at).toBeNull();

    db.close();
  });

  test('errors with exit 1 when workspace already exists', () => {
    const dbPath = join(dir, 'team.db');

    // First init succeeds
    runInit([dbPath]);

    // Intercept process.exit and stderr for the second call
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string) => {
        throw new Error(`process.exit(${code})`);
      });
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    expect(() => runInit([dbPath])).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const stderrOutput = stderrChunks.join('');
    expect(stderrOutput).toContain('workspace already exists');
    expect(stderrOutput).toContain("Use 'lattice token create'");

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('creates parent directories if they do not exist', () => {
    const deepPath = join(dir, 'a', 'b', 'c', 'team.db');
    runInit([deepPath]);
    expect(existsSync(deepPath)).toBe(true);
  });
});
