#!/usr/bin/env node
import { runInit } from './cli/init.js';

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case 'init':
      runInit(args);
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
