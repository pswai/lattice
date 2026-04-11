import { createHash, randomBytes } from 'node:crypto';
import type { DB } from './db.js';

export type TokenScope = 'admin' | 'agent';

export type MintTokenResult = {
  plaintext: string;
  hash: string;
};

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function mintToken(
  db: DB,
  { agent_id, scope }: { agent_id: string; scope: TokenScope },
): MintTokenResult {
  const prefix = scope === 'admin' ? 'lat_admin_' : 'lat_live_';
  const body = randomBytes(32).toString('base64url');
  const plaintext = `${prefix}${body}`;
  const hash = hashToken(plaintext);

  db.prepare(
    'INSERT INTO bus_tokens (token_hash, agent_id, scope, created_at) VALUES (?, ?, ?, ?)',
  ).run(hash, agent_id, scope, Date.now());

  return { plaintext, hash };
}
