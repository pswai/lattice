import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTmpDb, type TmpDb } from '../fixtures/tmp-db.js';
import { hashToken, mintToken } from '../../src/bus/tokens.js';
import { runMigrations } from '../../src/bus/migrations.js';

describe('mintToken', () => {
  let tmp: TmpDb;

  beforeEach(() => {
    tmp = createTmpDb();
    runMigrations(tmp.db);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  test('admin tokens have lat_admin_ prefix', () => {
    const { plaintext } = mintToken(tmp.db, { agent_id: 'agent-a', scope: 'admin' });
    expect(plaintext.startsWith('lat_admin_')).toBe(true);
  });

  test('agent tokens have lat_live_ prefix', () => {
    const { plaintext } = mintToken(tmp.db, { agent_id: 'agent-a', scope: 'agent' });
    expect(plaintext.startsWith('lat_live_')).toBe(true);
  });

  test('successive calls produce unique plaintext tokens', () => {
    const a = mintToken(tmp.db, { agent_id: 'agent-a', scope: 'admin' });
    const b = mintToken(tmp.db, { agent_id: 'agent-b', scope: 'admin' });
    expect(a.plaintext).not.toBe(b.plaintext);
  });

  test('successive calls produce unique hashes (catches collapsed hash functions)', () => {
    const a = mintToken(tmp.db, { agent_id: 'agent-a', scope: 'admin' });
    const b = mintToken(tmp.db, { agent_id: 'agent-b', scope: 'admin' });
    expect(hashToken(a.plaintext)).not.toBe(hashToken(b.plaintext));
  });

  test('returned hash is consistent with hashToken(plaintext)', () => {
    const { plaintext, hash } = mintToken(tmp.db, { agent_id: 'agent-a', scope: 'admin' });
    expect(hashToken(plaintext)).toBe(hash);
  });

  test('inserts a row into bus_tokens with correct fields', () => {
    const { hash } = mintToken(tmp.db, { agent_id: 'agent-a', scope: 'admin' });
    const row = tmp.db
      .prepare('SELECT * FROM bus_tokens WHERE token_hash = ?')
      .get(hash) as {
        token_hash: string;
        agent_id: string;
        scope: string;
        revoked_at: number | null;
      } | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_id).toBe('agent-a');
    expect(row!.scope).toBe('admin');
    expect(row!.revoked_at).toBeNull();
  });
});
