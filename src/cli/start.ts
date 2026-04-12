import { parseArgs } from 'node:util';
import { openDatabase } from '../bus/db.js';
import { runMigrations } from '../bus/migrations.js';
import { BrokerServer } from '../bus/broker.js';
import { parseRetentionDays } from '../bus/retention.js';

export async function runStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: 'string', short: 'w' },
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      'retention-days': { type: 'string' },
    },
    strict: true,
  });

  if (!values.workspace) {
    process.stderr.write(
      'error: --workspace <path> is required\n' +
        '  Usage: lattice start --workspace <path> [--port <port>] [--host <host>] [--retention-days <N|forever>]\n',
    );
    process.exit(1);
  }

  const port = values.port !== undefined ? Number.parseInt(values.port, 10) : 8787;
  const host = values.host ?? '127.0.0.1';

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    process.stderr.write(`error: invalid port '${values.port}'\n`);
    process.exit(1);
  }

  // Resolution order: CLI flag > LATTICE_RETENTION_DAYS env > default 30 days
  const retentionRaw =
    values['retention-days'] ?? process.env['LATTICE_RETENTION_DAYS'] ?? '30';
  let retentionDays: number | 'forever';
  try {
    retentionDays = parseRetentionDays(retentionRaw);
  } catch (err) {
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n` +
        '  Usage: lattice start ... [--retention-days <positive-integer|forever>]\n',
    );
    process.exit(1);
  }

  const db = openDatabase(values.workspace);
  runMigrations(db);

  const broker = new BrokerServer(db, { retentionDays });
  await broker.start(port, host);

  const addr = broker.address()!;
  process.stderr.write(`lattice broker listening on ws://${addr.host}:${addr.port}\n`);

  const shutdown = (): void => {
    process.stderr.write('shutting down...\n');
    broker.close().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
