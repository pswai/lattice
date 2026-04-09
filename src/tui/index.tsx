#!/usr/bin/env node

/**
 * Lattice TUI entry point.
 * Usage: lattice tui [--server URL] [--key API_KEY]
 */

import React from 'react';
import { render } from 'ink';
import { LatticeClient } from './client.js';
import { App } from './app.js';

interface TuiOptions {
  server?: string;
  key?: string;
}

export async function startTui(opts: TuiOptions = {}): Promise<void> {
  const baseUrl = opts.server || process.env.LATTICE_URL || `http://localhost:${process.env.PORT || '3000'}`;
  const apiKey = opts.key || process.env.LATTICE_API_KEY || '';

  if (!apiKey) {
    console.error('\x1b[31mError: No API key provided.\x1b[0m');
    console.error('Set LATTICE_API_KEY or pass --key <key>');
    process.exit(1);
  }

  const client = new LatticeClient({ baseUrl, apiKey });

  // Health check
  const healthy = await client.health();
  if (!healthy) {
    console.error(`\x1b[31mError: Cannot reach Lattice server at ${baseUrl}\x1b[0m`);
    console.error('Start the server with: npx lattice start');
    process.exit(1);
  }

  const workspace = new URL(baseUrl).host;

  const { waitUntilExit } = render(
    <App client={client} workspace={workspace} />,
    { exitOnCtrlC: true },
  );

  await waitUntilExit();
}
