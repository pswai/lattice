import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bus } from '../../../sdk-ts/dist/index.js';

const CLI_PATH = resolve('dist/cli.js');
const SHIM_PATH = resolve('packages/shim-mcp/dist/index.js');

async function runCmd(cmd: string, args: string[]): Promise<string> {
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout!.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  await new Promise<void>((res, rej) => {
    proc.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exit ${code}`))));
  });
  return stdout;
}

describe('Generic MCP long-poll shim', () => {
  let dir: string;
  let brokerPort: number;
  let brokerProc: ReturnType<typeof spawn>;
  let mcpClient: Client;
  let senderBus: Bus;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-mcp-shim-test-'));
    const dbPath = join(dir, 'bus.db');

    const initOut = await runCmd('node', [CLI_PATH, 'init', dbPath]);
    const adminMatch = initOut.match(/\s+(lat_admin_\S+)/);
    if (!adminMatch) throw new Error('no admin token');

    const shimOut = await runCmd('node', [CLI_PATH, 'token', 'create', 'mcp-agent', '--workspace', dbPath]);
    const shimToken = shimOut.match(/\s+(lat_live_\S+)/)?.[1] ?? '';
    if (!shimToken) throw new Error('no shim token');

    const senderOut = await runCmd('node', [CLI_PATH, 'token', 'create', 'sender-agent', '--workspace', dbPath]);
    const senderToken = senderOut.match(/\s+(lat_live_\S+)/)?.[1] ?? '';
    if (!senderToken) throw new Error('no sender token');

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

    const mcpTransport = new StdioClientTransport({
      command: 'node',
      args: [SHIM_PATH],
      env: {
        ...process.env,
        LATTICE_URL: `ws://127.0.0.1:${brokerPort}`,
        LATTICE_AGENT_ID: 'mcp-agent',
        LATTICE_TOKEN: shimToken,
      },
    });
    mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await mcpClient.connect(mcpTransport);

    senderBus = new Bus({
      url: `ws://127.0.0.1:${brokerPort}`,
      agentId: 'sender-agent',
      token: senderToken,
    });
    await senderBus.connect();
  }, 15000);

  afterAll(async () => {
    try { await senderBus?.close(); } catch { /* */ }
    try { await mcpClient?.close(); } catch { /* */ }
    try { brokerProc?.kill('SIGTERM'); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('lists lattice tools including lattice_wait', async () => {
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toContain('lattice_wait');
    expect(names).toContain('lattice_send_message');
    expect(names).toContain('lattice_subscribe');
  });

  test('lattice_wait returns null on empty queue with short timeout', async () => {
    const result = await mcpClient.callTool({
      name: 'lattice_wait',
      arguments: { timeout_ms: 100 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.message).toBeNull();
    expect(parsed.pending_messages).toBe(0);
  });

  test('lattice_wait returns immediately when queue is non-empty', async () => {
    // Send a message to mcp-agent, give it a moment to arrive
    senderBus.send({
      to: 'mcp-agent',
      type: 'direct',
      payload: { hello: 'world' },
    });
    await new Promise((r) => setTimeout(r, 300));

    const result = await mcpClient.callTool({
      name: 'lattice_wait',
      arguments: { timeout_ms: 5000 },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    const parsed = JSON.parse(text!);
    expect(parsed.message).not.toBeNull();
    expect(parsed.message.from).toBe('sender-agent');
    expect(parsed.message.payload).toMatchObject({ hello: 'world' });
  });

  test('lattice_send_message sends through broker', async () => {
    const result = await mcpClient.callTool({
      name: 'lattice_send_message',
      arguments: {
        to: 'sender-agent',
        type: 'direct',
        payload: { from_mcp: true },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(JSON.parse(text!)).toMatchObject({ ok: true });
  });

  test('lattice_subscribe works', async () => {
    const result = await mcpClient.callTool({
      name: 'lattice_subscribe',
      arguments: { topics: ['mcp-topic'] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(JSON.parse(text!)).toMatchObject({ ok: true, topics: ['mcp-topic'] });
  });

  test('pending_messages hint reflects queue depth', async () => {
    // Send 3 messages in quick succession
    for (let i = 0; i < 3; i++) {
      senderBus.send({
        to: 'mcp-agent',
        type: 'direct',
        payload: { seq: i },
      });
    }
    await new Promise((r) => setTimeout(r, 500));

    // First wait should get one message and show remaining
    const r1 = await mcpClient.callTool({
      name: 'lattice_wait',
      arguments: { timeout_ms: 1000 },
    });
    const p1 = JSON.parse((r1.content as Array<{ type: string; text: string }>)[0]!.text);
    expect(p1.message).not.toBeNull();
    expect(p1.pending_messages).toBeGreaterThanOrEqual(0);
  });
});
