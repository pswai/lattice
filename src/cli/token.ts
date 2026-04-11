import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from '../bus/db.js';
import { hashToken, mintToken } from '../bus/tokens.js';

export function runTokenCreate(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      workspace: { type: 'string', short: 'w' },
      scope: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const agentId = positionals[0];
  if (!agentId) {
    process.stderr.write(
      'error: agent_id is required\n' +
        '  Usage: lattice token create <agent_id> --workspace <path> [--scope admin|agent]\n',
    );
    process.exit(1);
  }

  if (!values.workspace) {
    process.stderr.write(
      'error: --workspace <path> is required\n' +
        '  Usage: lattice token create <agent_id> --workspace <path> [--scope admin|agent]\n',
    );
    process.exit(1);
  }

  const rawScope = values.scope;
  if (rawScope !== undefined && rawScope !== 'admin' && rawScope !== 'agent') {
    process.stderr.write(`error: --scope must be 'admin' or 'agent'\n`);
    process.exit(1);
  }
  const scope = rawScope === 'admin' ? 'admin' : 'agent';

  const resolved = resolve(values.workspace);
  if (!existsSync(resolved)) {
    process.stderr.write(`error: workspace not found at ${resolved}\n`);
    process.exit(1);
  }

  const db = openDatabase(resolved);
  const { plaintext } = mintToken(db, { agent_id: agentId, scope });
  db.close();

  process.stdout.write(`\nToken for ${agentId} (save this — it will not be shown again):\n\n`);
  process.stdout.write(`  ${plaintext}\n\n`);
}

export function runTokenRevoke(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      workspace: { type: 'string', short: 'w' },
    },
    allowPositionals: true,
    strict: true,
  });

  const token = positionals[0];
  if (!token) {
    process.stderr.write(
      'error: token is required\n' +
        '  Usage: lattice token revoke <token> --workspace <path>\n',
    );
    process.exit(1);
  }

  if (!values.workspace) {
    process.stderr.write(
      'error: --workspace <path> is required\n' +
        '  Usage: lattice token revoke <token> --workspace <path>\n',
    );
    process.exit(1);
  }

  const resolved = resolve(values.workspace);
  if (!existsSync(resolved)) {
    process.stderr.write(`error: workspace not found at ${resolved}\n`);
    process.exit(1);
  }

  const db = openDatabase(resolved);
  const hash = hashToken(token);
  const result = db
    .prepare('UPDATE bus_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(Date.now(), hash);

  if (result.changes === 0) {
    // Distinguish not-found from already-revoked for clearer operator feedback
    const row = db.prepare('SELECT revoked_at FROM bus_tokens WHERE token_hash = ?').get(hash);
    db.close();
    if (row) {
      process.stderr.write('error: token is already revoked\n');
    } else {
      process.stderr.write('error: token not found\n');
    }
    process.exit(1);
  }

  db.close();
  process.stdout.write('Revoked.\n');
}
