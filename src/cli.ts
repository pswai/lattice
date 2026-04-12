#!/usr/bin/env node
import { runInit } from './cli/init.js';
import { runStart } from './cli/start.js';
import { runTokenCreate, runTokenRevoke } from './cli/token.js';

// Slice raw argv so subcommand handlers receive their flags unmodified
const [command, ...rest] = process.argv.slice(2);

(async () => {
  try {
    switch (command) {
      case 'init':
        runInit(rest);
        break;
      case 'start':
        await runStart(rest);
        break;
      case 'token': {
        const [subcommand, ...subArgs] = rest;
        switch (subcommand) {
          case 'create':
            runTokenCreate(subArgs);
            break;
          case 'revoke':
            runTokenRevoke(subArgs);
            break;
          default:
            process.stderr.write(
              `error: unknown token subcommand '${subcommand ?? ''}'\n` +
                `  Usage: lattice token <create|revoke> [options]\n` +
                `  Commands:\n` +
                `    token create <agent_id> --workspace <path> [--scope admin|agent]\n` +
                `    token revoke <token> --workspace <path>\n`,
            );
            process.exit(1);
        }
        break;
      }
      default:
        process.stderr.write(
          `error: unknown command '${command ?? ''}'\n` +
            `Usage: lattice <command> [options]\n\n` +
            `Commands:\n` +
            `  init <workspace-path>                                          Create a new workspace\n` +
            `  start --workspace <path> [--port <port>] [--host <h>]         Start the broker\n` +
            `  token create <agent_id> --workspace <path> [--scope a|admin]  Mint a new token\n` +
            `  token revoke <token> --workspace <path>                        Revoke a token\n`,
        );
        process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
  }
})();
