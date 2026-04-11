import { parseArgs } from 'node:util';
import { openDatabase } from '../bus/db.js';
import { runMigrations } from '../bus/migrations.js';
import { BrokerServer } from '../bus/broker.js';

export async function runStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: 'string', short: 'w' },
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
    },
    strict: true,
  });

  if (!values.workspace) {
    process.stderr.write(
      'error: --workspace <path> is required\n' +
        '  Usage: lattice start --workspace <path> [--port <port>] [--host <host>]\n',
    );
    process.exit(1);
  }

  const port = values.port !== undefined ? Number.parseInt(values.port, 10) : 8787;
  const host = values.host ?? '127.0.0.1';

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    process.stderr.write(`error: invalid port '${values.port}'\n`);
    process.exit(1);
  }

  const db = openDatabase(values.workspace);
  runMigrations(db);

  const broker = new BrokerServer(db);
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
