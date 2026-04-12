import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bus } from '../../../sdk-ts/dist/index.js';

const CLI_PATH = resolve('dist/cli.js');
const SHIM_PATH = resolve('packages/shim-claude-code/dist/index.js');

async function runCmd(cmd: string, args: string[]): Promise<string> {
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout!.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  await new Promise<void>((res, rej) => {
    proc.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exit ${code}`))));
  });
  return stdout;
}

describe('Claude Code channel shim', () => {
  let dir: string;
  let brokerPort: number;
  let brokerProc: ReturnType<typeof spawn>;
  let shimToken: string;
  let senderToken: string;
  let mcpClient: Client;
  let mcpTransport: StdioClientTransport;
  let senderBus: Bus;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-shim-test-'));
    const dbPath = join(dir, 'bus.db');

    // Init workspace + create tokens
    const initOut = await runCmd('node', [CLI_PATH, 'init', dbPath]);
    const adminMatch = initOut.match(/\s+(lat_admin_\S+)/);
    if (!adminMatch) throw new Error('no admin token from init');

    const shimOut = await runCmd('node', [CLI_PATH, 'token', 'create', 'shim-agent', '--workspace', dbPath]);
    shimToken = shimOut.match(/\s+(lat_live_\S+)/)?.[1] ?? '';
    if (!shimToken) throw new Error('no shim token');

    const senderOut = await runCmd('node', [CLI_PATH, 'token', 'create', 'sender-agent', '--workspace', dbPath]);
    senderToken = senderOut.match(/\s+(lat_live_\S+)/)?.[1] ?? '';
    if (!senderToken) throw new Error('no sender token');

    // Start broker on port 0
    brokerProc = spawn('node', [CLI_PATH, 'start', '--workspace', dbPath, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    brokerPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('broker start timeout')), 5000);
      brokerProc.stderr!.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          try {
            const obj = JSON.parse(line);
            if (obj.event === 'broker_start' && obj.port) {
              clearTimeout(timeout);
              resolve(obj.port as number);
            }
          } catch {
            /* not JSON */
          }
        }
      });
      brokerProc.on('close', () => {
        clearTimeout(timeout);
        reject(new Error('broker exited'));
      });
    });

    // Start shim via StdioClientTransport (it spawns the shim process internally)
    mcpTransport = new StdioClientTransport({
      command: 'node',
      args: [SHIM_PATH],
      env: {
        ...process.env,
        LATTICE_URL: `ws://127.0.0.1:${brokerPort}`,
        LATTICE_AGENT_ID: 'shim-agent',
        LATTICE_TOKEN: shimToken,
      },
    });
    mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await mcpClient.connect(mcpTransport);

    // Connect sender directly via SDK
    senderBus = new Bus({
      url: `ws://127.0.0.1:${brokerPort}`,
      agentId: 'sender-agent',
      token: senderToken,
    });
    await senderBus.connect();
  }, 15000);

  afterAll(async () => {
    try {
      await senderBus?.close();
    } catch {
      /* */
    }
    try {
      await mcpClient?.close();
    } catch {
      /* */
    }
    try {
      brokerProc?.kill('SIGTERM');
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 300));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('MCP initialize returns experimental claude/channel capability', () => {
    const caps = mcpClient.getServerCapabilities();
    expect(caps?.experimental).toHaveProperty('claude/channel');
  });

  test('lists lattice tools', async () => {
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toContain('lattice_send_message');
    expect(names).toContain('lattice_subscribe');
  });

  test('lattice_send_message tool sends a message through the broker', async () => {
    const result = await mcpClient.callTool({
      name: 'lattice_send_message',
      arguments: {
        to: 'sender-agent',
        type: 'direct',
        payload: { hello: 'from shim' },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(JSON.parse(text!)).toEqual({ ok: true });
  });

  test('lattice_subscribe tool subscribes to a topic', async () => {
    const result = await mcpClient.callTool({
      name: 'lattice_subscribe',
      arguments: { topics: ['test-topic'] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(JSON.parse(text!)).toMatchObject({ ok: true, topics: ['test-topic'] });
  });

  test('shim emits channel notification when a Lattice message arrives', async () => {
    // Use fallbackNotificationHandler for custom notification methods
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no channel notification in 5s')), 5000);
      mcpClient.fallbackNotificationHandler = async (notification: any) => {
        if (notification.method === 'notifications/claude/channel') {
          clearTimeout(timeout);
          resolve(notification.params as Record<string, unknown>);
        }
      };
    });

    // Send from external agent to shim-agent
    senderBus.send({
      to: 'shim-agent',
      type: 'direct',
      payload: { ping: true, ts: Date.now() },
    });

    const notification = await received;
    expect(notification).toMatchObject({
      source: 'lattice',
      from: 'sender-agent',
      type: 'direct',
    });
    expect(notification.payload).toMatchObject({ ping: true });
  }, 10000);
});
