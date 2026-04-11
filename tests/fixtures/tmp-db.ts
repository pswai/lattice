import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/bus/db.js';

export type TmpDb = {
  db: DB;
  path: string;
  dir: string;
  cleanup(): void;
};

export function createTmpDb(): TmpDb {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-test-'));
  const path = join(dir, 'test.db');
  const db = openDatabase(path);
  return {
    db,
    path,
    dir,
    cleanup() {
      try {
        db.close();
      } catch {
        // close is best-effort; we still wipe the directory below
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
