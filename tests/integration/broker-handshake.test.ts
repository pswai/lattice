import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { BrokerServer } from '../../src/bus/broker.js';
import { runMigrations } from '../../src/bus/migrations.js';
import { mintToken } from '../../src/bus/tokens.js';
import { createTmpDb, type TmpDb } from '../fixtures/tmp-db.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: no frame received')), 2000);
    ws.once('message', (data) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        reject(new Error('response is not valid JSON'));
      }
    });
    ws.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', () => resolve());
  });
}

// ── fixture ───────────────────────────────────────────────────────────────────

let tmp: TmpDb;
let broker: BrokerServer;
let port: number;
let adminToken: string; // minted for agent-a
let agentToken: string; // minted for agent-b

beforeAll(async () => {
  tmp = createTmpDb();
  runMigrations(tmp.db);

  ({ plaintext: adminToken } = mintToken(tmp.db, { agent_id: 'agent-a', scope: 'admin' }));
  ({ plaintext: agentToken } = mintToken(tmp.db, { agent_id: 'agent-b', scope: 'agent' }));

  broker = new BrokerServer(tmp.db);
  await broker.start(0); // OS-assigned ephemeral port
  port = broker.address()!.port;
});

afterAll(async () => {
  await broker.close();
  tmp.cleanup();
});

// ── happy path ────────────────────────────────────────────────────────────────

describe('valid hello → welcome', () => {
  test('admin token: welcome frame has all required fields', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-a', token: adminToken, protocol_version: 1 }));
    const frame = await framePromise;

    expect(frame).toMatchObject({
      op: 'welcome',
      agent_id: 'agent-a',
      current_cursor: 0,
      replaying: false,
      protocol_version: 1,
    });

    ws.close();
    await waitForClose(ws);
  });

  test('agent token: welcome frame returned', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-b', token: agentToken, protocol_version: 1 }));
    const frame = await framePromise;

    expect(frame.op).toBe('welcome');
    expect(frame.agent_id).toBe('agent-b');

    ws.close();
    await waitForClose(ws);
  });

  test('hello with last_acked_cursor: welcome returned, cursor stored', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-a', token: adminToken, protocol_version: 1, last_acked_cursor: 42 }));
    const frame = await framePromise;

    expect(frame.op).toBe('welcome');

    // Verify the cursor was stored in bus_subscriptions
    const row = tmp.db
      .prepare('SELECT last_acked_cursor FROM bus_subscriptions WHERE agent_id = ? ORDER BY connected_at DESC LIMIT 1')
      .get('agent-a') as { last_acked_cursor: number } | undefined;
    expect(row?.last_acked_cursor).toBe(42);

    ws.close();
    await waitForClose(ws);
  });
});

// ── error cases ───────────────────────────────────────────────────────────────

describe('authentication errors', () => {
  test('nonexistent token → unauthorized + close', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-a', token: 'lat_live_doesnotexist', protocol_version: 1 }));
    const [frame] = await Promise.all([framePromise, closePromise]);

    expect(frame).toMatchObject({ op: 'error', code: 'unauthorized' });
    expect(typeof frame.message).toBe('string');
  });

  test('revoked token → token_revoked + close', async () => {
    const { plaintext: revoked, hash } = mintToken(tmp.db, { agent_id: 'agent-revoked', scope: 'agent' });
    tmp.db.prepare('UPDATE bus_tokens SET revoked_at = ? WHERE token_hash = ?').run(Date.now(), hash);

    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-revoked', token: revoked, protocol_version: 1 }));
    const [frame] = await Promise.all([framePromise, closePromise]);

    expect(frame).toMatchObject({ op: 'error', code: 'token_revoked' });
    expect(typeof frame.message).toBe('string');
  });

  test('token for different agent_id → unauthorized + close', async () => {
    // adminToken is for agent-a; claiming agent-b is impersonation
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-b', token: adminToken, protocol_version: 1 }));
    const [frame] = await Promise.all([framePromise, closePromise]);

    expect(frame).toMatchObject({ op: 'error', code: 'unauthorized' });
    expect(typeof frame.message).toBe('string');
  });
});

describe('protocol errors', () => {
  test('unsupported protocol_version → error + close', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-a', token: adminToken, protocol_version: 99 }));
    const [frame] = await Promise.all([framePromise, closePromise]);

    expect(frame).toMatchObject({ op: 'error', code: 'unsupported_protocol_version' });
    expect(typeof frame.message).toBe('string');
  });

  test('malformed JSON → malformed_frame + close', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    const closePromise = waitForClose(ws);
    ws.send('not json');
    const [frame] = await Promise.all([framePromise, closePromise]);

    expect(frame).toMatchObject({ op: 'error', code: 'malformed_frame' });
    expect(frame.message).toContain('invalid JSON');
  });

  test('valid JSON but wrong op → malformed_frame + close', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    const closePromise = waitForClose(ws);
    ws.send(JSON.stringify({ op: 'subscribe', topics: ['x'] }));
    const [frame] = await Promise.all([framePromise, closePromise]);

    expect(frame).toMatchObject({ op: 'error', code: 'malformed_frame' });
  });

  test('binary frame → malformed_frame + close', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    const closePromise = waitForClose(ws);
    ws.send(Buffer.from([0x00, 0x01, 0x02])); // binary frame
    const [frame] = await Promise.all([framePromise, closePromise]);

    expect(frame).toMatchObject({ op: 'error', code: 'malformed_frame' });
    expect(frame.message).toContain('binary');
  });
});

// ── subscription lifecycle ────────────────────────────────────────────────────

describe('bus_subscriptions lifecycle', () => {
  test('clean close removes subscription row from DB', async () => {
    const ws = await connect(port);
    const framePromise = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'agent-a', token: adminToken, protocol_version: 1 }));
    await framePromise; // welcome

    // Verify row exists
    const before = tmp.db
      .prepare('SELECT COUNT(*) AS n FROM bus_subscriptions WHERE agent_id = ?')
      .get('agent-a') as { n: number };
    expect(before.n).toBeGreaterThan(0);

    // Close connection and wait for server-side cleanup
    ws.close();
    await waitForClose(ws);
    // Small delay for server-side close handler to run
    await new Promise((r) => setTimeout(r, 50));

    // Subscription row should be gone (all connections for agent-a closed)
    const after = tmp.db
      .prepare('SELECT COUNT(*) AS n FROM bus_subscriptions WHERE agent_id = ?')
      .get('agent-a') as { n: number };
    expect(after.n).toBe(0);
  });

  test('close before hello completes leaves no orphan rows', async () => {
    const before = tmp.db
      .prepare('SELECT COUNT(*) AS n FROM bus_subscriptions')
      .get() as { n: number };

    const ws = await connect(port);
    // Close immediately without sending hello
    ws.terminate();
    await waitForClose(ws);
    await new Promise((r) => setTimeout(r, 50));

    const after = tmp.db
      .prepare('SELECT COUNT(*) AS n FROM bus_subscriptions')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
