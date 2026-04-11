#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runInit } from './cli/init.js';

const { positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
});

const [command, ...rest] = positionals;

try {
  switch (command) {
    case 'init':
      runInit(rest);
      break;
    default:
      process.stderr.write(
        `error: unknown command '${command ?? ''}'\n` +
          `Usage: lattice <command> [options]\n\n` +
          `Commands:\n` +
          `  init <workspace-path>   Create a new workspace and mint the first admin token\n`,
      );
      process.exit(1);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
