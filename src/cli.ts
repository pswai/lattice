#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runInit } from './cli/init.js';
import { runStart } from './cli/start.js';

const { positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
});

const [command, ...rest] = positionals;

(async () => {
  try {
    switch (command) {
      case 'init':
        runInit(rest);
        break;
      case 'start':
        await runStart(rest);
        break;
      default:
        process.stderr.write(
          `error: unknown command '${command ?? ''}'\n` +
            `Usage: lattice <command> [options]\n\n` +
            `Commands:\n` +
            `  init <workspace-path>                                   Create a new workspace\n` +
            `  start --workspace <path> [--port <port>] [--host <h>]  Start the broker\n`,
        );
        process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
  }
})();
