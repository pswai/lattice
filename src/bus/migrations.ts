import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { log } from './logger.js';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('./migrations/', import.meta.url),
);

export type MigrationResult = {
  applied: number[];
  skipped: number[];
  head: number;
};

export class MigrationDowngradeError extends Error {
  constructor(
    public readonly dbHead: number,
    public readonly codeHead: number,
  ) {
    super(
      `DB schema version ${dbHead} is ahead of code version ${codeHead}; ` +
        `refusing to start. Downgrades are not supported — upgrade the code.`,
    );
    this.name = 'MigrationDowngradeError';
  }
}

export class MigrationApplyError extends Error {
  constructor(
    public readonly version: number,
    public readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to apply migration ${version}: ${reason}`);
    this.name = 'MigrationApplyError';
  }
}

type MigrationFile = {
  version: number;
  name: string;
  sql: string;
};

const FILENAME_RE = /^(\d+)_[^.]+\.sql$/;

function loadMigrationFiles(dir: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = FILENAME_RE.exec(entry.name);
    if (!match) continue;
    const version = Number.parseInt(match[1]!, 10);
    files.push({
      version,
      name: entry.name,
      sql: readFileSync(join(dir, entry.name), 'utf8'),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

export function runMigrations(
  db: DB,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): MigrationResult {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     ) STRICT;`,
  );

  const files = loadMigrationFiles(migrationsDir);
  const codeHead = files.at(-1)?.version ?? 0;

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as { version: number }[];
  const appliedSet = new Set(appliedRows.map((r) => r.version));
  const dbHead = appliedRows.at(-1)?.version ?? 0;

  if (dbHead > codeHead) {
    throw new MigrationDowngradeError(dbHead, codeHead);
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );
  const applied: number[] = [];
  const skipped: number[] = [];

  for (const file of files) {
    if (appliedSet.has(file.version)) {
      skipped.push(file.version);
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(file.sql);
      insert.run(file.version, Date.now());
    });
    try {
      apply();
    } catch (err) {
      throw new MigrationApplyError(file.version, err);
    }
    log('info', 'migration_applied', { version: file.version });
    applied.push(file.version);
  }

  return { applied, skipped, head: Math.max(codeHead, dbHead) };
}
