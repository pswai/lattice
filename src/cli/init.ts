import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from '../bus/db.js';
import { runMigrations } from '../bus/migrations.js';
import { mintToken } from '../bus/tokens.js';

export function runInit(args: string[]): void {
  const workspacePath = args[0];
  if (!workspacePath) {
    process.stderr.write(
      'error: workspace path is required\n' +
        '  Usage: lattice init <workspace-path>\n',
    );
    process.exit(1);
  }

  const resolved = resolve(workspacePath);

  if (existsSync(resolved)) {
    process.stderr.write(
      `error: workspace already exists at ${resolved}. ` +
        `Use 'lattice token create' to mint additional tokens.\n`,
    );
    process.exit(1);
  }

  // Create parent directories if they don't exist (e.g. /var/lib/lattice/)
  mkdirSync(dirname(resolved), { recursive: true });

  const db = openDatabase(resolved);
  runMigrations(db);
  const { plaintext } = mintToken(db, { agent_id: 'workspace-admin', scope: 'admin' });
  db.close();

  process.stdout.write(`\nWorkspace created at ${resolved}\n`);
  process.stdout.write(`\nFirst admin token (save this — it will not be shown again):\n\n`);
  process.stdout.write(`  ${plaintext}\n\n`);
  process.stdout.write(`Run 'lattice start --workspace ${resolved}' to start the broker.\n\n`);
}
