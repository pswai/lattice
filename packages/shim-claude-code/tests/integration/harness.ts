// Shared test harness: runs a real broker, mints tokens, and spawns the shim
// as a child process under MCP stdio. Used by integration tests that need to
// exercise the shim with varying env configurations.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bus } from '../../../sdk-ts/dist/index.js';
import { openDatabase } from '../../../../dist/bus/db.js';
import { runMigrations } from '../../../../dist/bus/migrations.js';
import { mintToken as mintTokenSync } from '../../../../dist/bus/tokens.js';

export const CLI_PATH = resolve('dist/cli.js');
export const SHIM_PATH = resolve('packages/shim-claude-code/dist/index.js');

export type Broker = {
  port: number;
  dir: string;
  dbPath: string;
  proc: ChildProcessWithoutNullStreams;
  mintToken: (agentId: string) => Promise<string>;
  stop: () => Promise<void>;
};

export async function startBroker(): Promise<Broker> {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-shim-test-'));
  const dbPath = join(dir, 'bus.db');

  // Initialize the workspace in-process instead of shelling out to
  // `cli init` + one `cli token create` per agent. We open/close the DB per
  // mint to avoid a long-lived handle coexisting with the broker subprocess
  // (WAL tolerates it, but intermittent contention under vitest
  // concurrency produced §2.10 flakes during development).
  {
    const db = openDatabase(dbPath);
    runMigrations(db);
    db.close();
  }
  const mintToken = async (agentId: string): Promise<string> => {
    const db = openDatabase(dbPath);
    try {
      const { plaintext } = mintTokenSync(db, { agent_id: agentId, scope: 'agent' });
      return plaintext;
    } finally {
      db.close();
    }
  };

  const proc = spawn('node', [CLI_PATH, 'start', '--workspace', dbPath, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const port = await new Promise<number>((res, rej) => {
    const t = setTimeout(() => rej(new Error('broker start timeout')), 5000);
    proc.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          if (obj.event === 'broker_start' && obj.port) {
            clearTimeout(t);
            res(obj.port as number);
          }
        } catch { /* not JSON */ }
      }
    });
    proc.on('close', () => { clearTimeout(t); rej(new Error('broker exited')); });
  });

  const stop = async () => {
    try { proc.kill('SIGTERM'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true });
  };

  return { port, dir, dbPath, proc, mintToken, stop };
}

export type ShimHandle = {
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
  close: () => Promise<void>;
};

// Spawn a shim with the given env. Captures stderr as lines for log assertions.
export async function startShim(opts: {
  broker: Broker;
  agentId: string;
  token: string;
  extraEnv?: Record<string, string>;
}): Promise<ShimHandle> {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SHIM_PATH],
    env: {
      ...process.env,
      LATTICE_URL: `ws://127.0.0.1:${opts.broker.port}`,
      LATTICE_AGENT_ID: opts.agentId,
      LATTICE_TOKEN: opts.token,
      ...opts.extraEnv,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  const sp = transport.stderr;
  if (sp) {
    sp.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) stderr.push(line);
    });
  }
  return {
    client,
    transport,
    stderr,
    close: async () => {
      try { await client.close(); } catch { /* */ }
    },
  };
}

export async function connectSenderBus(broker: Broker, agentId: string, token: string): Promise<Bus> {
  const bus = new Bus({
    url: `ws://127.0.0.1:${broker.port}`,
    agentId,
    token,
  });
  await bus.connect();
  return bus;
}

// Connect an agent's bus and start an inbox-collector iterator. The IIFE
// terminates cleanly on close: the `closed` flag swallows the AbortError
// thrown by the iterator when bus.close() is called from the test teardown.
export type AgentWithInbox = {
  bus: Bus;
  inbox: import('../../../sdk-ts/dist/index.js').MessageFrame[];
  close: () => Promise<void>;
};

export async function connectAgentWithInbox(
  broker: Broker,
  agentId: string,
  token: string,
): Promise<AgentWithInbox> {
  const bus = await connectSenderBus(broker, agentId, token);
  const inbox: AgentWithInbox['inbox'] = [];
  let closed = false;
  (async () => {
    try {
      for await (const msg of bus.messages()) inbox.push(msg);
    } catch (err) {
      if (!closed) throw err;
    }
  })().catch((err) => {
    if (!closed) throw err;
  });
  return {
    bus,
    inbox,
    close: async () => {
      closed = true;
      try { await bus.close(); } catch { /* */ }
    },
  };
}

// Attach a collector to the shim's MCP client that appends every
// `notifications/claude/channel` params object to the returned array.
export function collectChannelNotifications(shim: ShimHandle): Array<{
  content: string;
  meta: Record<string, string>;
}> {
  const out: Array<{ content: string; meta: Record<string, string> }> = [];
  shim.client.fallbackNotificationHandler = async (n: any) => {
    if (n.method === 'notifications/claude/channel') {
      out.push(n.params as { content: string; meta: Record<string, string> });
    }
  };
  return out;
}

export function findLogLine(stderr: string[], event: string): Record<string, unknown> | undefined {
  for (const line of stderr) {
    try {
      const obj = JSON.parse(line);
      if (obj.event === event) return obj;
    } catch { /* not JSON */ }
  }
  return undefined;
}

export async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// Call an MCP tool on the shim and parse the first text content as JSON.
// Returns the parsed object plus the isError flag for negative-path assertions.
export async function callToolJson<T = Record<string, unknown>>(
  shim: ShimHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: T; isError: boolean }> {
  const result = await shim.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return { parsed: JSON.parse(text) as T, isError: result.isError === true };
}

export function findAllLogLines(stderr: string[], event: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of stderr) {
    try {
      const obj = JSON.parse(line);
      if (obj.event === event) out.push(obj);
    } catch { /* */ }
  }
  return out;
}
