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
    const t = setTimeout(() => reject(new Error('timeout: no frame received')), 3000);
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

function collectFrames(ws: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    const t = setTimeout(
      () => reject(new Error(`timeout: collected ${frames.length}/${count} frames`)),
      3000,
    );
    const handler = (data: WebSocket.RawData): void => {
      try {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (frames.length === count) {
          clearTimeout(t);
          ws.off('message', handler);
          resolve(frames);
        }
      } catch {
        clearTimeout(t);
        ws.off('message', handler);
        reject(new Error('frame is not valid JSON'));
      }
    };
    ws.on('message', handler);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', () => resolve());
  });
}

// hello + discard welcome, return the authenticated ws
async function handshake(port: number, agentId: string, token: string): Promise<WebSocket> {
  const ws = await connect(port);
  const welcomePromise = nextFrame(ws);
  ws.send(JSON.stringify({ op: 'hello', agent_id: agentId, token, protocol_version: 1 }));
  const welcome = await welcomePromise;
  if (welcome.op !== 'welcome') throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);
  return ws;
}

// ── fixture ───────────────────────────────────────────────────────────────────

let tmp: TmpDb;
let broker: BrokerServer;
let port: number;
let tokenA: string; // agent-a
let tokenB: string; // agent-b

beforeAll(async () => {
  tmp = createTmpDb();
  runMigrations(tmp.db);

  ({ plaintext: tokenA } = mintToken(tmp.db, { agent_id: 'agent-a', scope: 'admin' }));
  ({ plaintext: tokenB } = mintToken(tmp.db, { agent_id: 'agent-b', scope: 'agent' }));

  broker = new BrokerServer(tmp.db);
  await broker.start(0);
  port = broker.address()!.port;
});

afterAll(async () => {
  await broker.close();
  tmp.cleanup();
});

// ── send → message delivery ───────────────────────────────────────────────────

describe('send / message delivery', () => {
  test('A sends to B: B receives message with all required fields', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    const msgPromise = nextFrame(wsB);
    wsA.send(
      JSON.stringify({
        op: 'send',
        to: 'agent-b',
        type: 'direct',
        payload: { hello: 'world' },
        idempotency_key: 'idem-1',
        correlation_id: 'corr-1',
      }),
    );
    const msg = await msgPromise;

    expect(msg.op).toBe('message');
    expect(typeof msg.cursor).toBe('number');
    expect(msg.from).toBe('agent-a');
    expect(msg.type).toBe('direct');
    expect(msg.payload).toEqual({ hello: 'world' });
    expect(msg.idempotency_key).toBe('idem-1');
    expect(msg.correlation_id).toBe('corr-1');
    expect(typeof msg.created_at).toBe('number');

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('message row persisted in bus_messages after send', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    const msgPromise = nextFrame(wsB);
    wsA.send(
      JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { persisted: true } }),
    );
    const msg = await msgPromise;
    const cursor = msg.cursor as number;

    const row = tmp.db
      .prepare('SELECT from_agent, to_agent, type, payload FROM bus_messages WHERE id = ?')
      .get(cursor) as { from_agent: string; to_agent: string; type: string; payload: Buffer } | undefined;

    expect(row).toBeDefined();
    expect(row!.from_agent).toBe('agent-a');
    expect(row!.to_agent).toBe('agent-b');
    expect(row!.type).toBe('direct');
    // payload stored as Buffer (BLOB); round-trips through JSON
    expect(JSON.parse(row!.payload.toString('utf8'))).toEqual({ persisted: true });

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('null idempotency_key and correlation_id in message frame when not provided', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    const msgPromise = nextFrame(wsB);
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: {} }));
    const msg = await msgPromise;

    expect(msg.idempotency_key).toBeNull();
    expect(msg.correlation_id).toBeNull();

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('from_agent is the authenticated sender, not a client-declared field', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    const msgPromise = nextFrame(wsB);
    // The send frame has no 'from' field — broker fills it from the session
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: {} }));
    const msg = await msgPromise;

    expect(msg.from).toBe('agent-a');

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('round-trip to self: A sends to A, A receives', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);

    const msgPromise = nextFrame(wsA);
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-a', type: 'direct', payload: { self: true } }));
    const msg = await msgPromise;

    expect(msg.op).toBe('message');
    expect(msg.from).toBe('agent-a');
    expect(msg.payload).toEqual({ self: true });

    wsA.close();
    await waitForClose(wsA);
  });

  test('multiple connections for same agent both receive the message', async () => {
    // Two connections for agent-b using the same token
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB1 = await handshake(port, 'agent-b', tokenB);
    const wsB2 = await handshake(port, 'agent-b', tokenB);

    const msg1Promise = nextFrame(wsB1);
    const msg2Promise = nextFrame(wsB2);
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { broadcast: true } }));

    const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);

    expect(msg1.op).toBe('message');
    expect(msg2.op).toBe('message');
    expect(msg1.payload).toEqual({ broadcast: true });
    expect(msg2.payload).toEqual({ broadcast: true });

    wsA.close();
    wsB1.close();
    wsB2.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB1), waitForClose(wsB2)]);
  });

  test('send to offline recipient: row persisted in DB, no error to sender', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    // agent-b is not connected

    // Give the send time to complete; no message should arrive back at wsA
    const countBefore = (
      tmp.db
        .prepare('SELECT COUNT(*) AS n FROM bus_messages WHERE to_agent = ?')
        .get('agent-b') as { n: number }
    ).n;

    wsA.send(
      JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { offline: true } }),
    );

    // Wait a bit, then verify: no error to sender and row exists in DB
    await new Promise((r) => setTimeout(r, 100));

    const countAfter = (
      tmp.db
        .prepare('SELECT COUNT(*) AS n FROM bus_messages WHERE to_agent = ?')
        .get('agent-b') as { n: number }
    ).n;
    expect(countAfter).toBe(countBefore + 1);

    wsA.close();
    await waitForClose(wsA);
  });

  test('per-recipient FIFO: 5 messages arrive in send order with strictly increasing cursors', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    const framesPromise = collectFrames(wsB, 5);
    for (let i = 0; i < 5; i++) {
      wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { seq: i } }));
    }
    const frames = await framesPromise;

    expect(frames).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect((frames[i]!.payload as Record<string, unknown>).seq).toBe(i);
    }
    const cursors = frames.map((f) => f.cursor as number);
    for (let i = 1; i < cursors.length; i++) {
      expect(cursors[i]!).toBeGreaterThan(cursors[i - 1]!);
    }

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });
});

// ── send validation ───────────────────────────────────────────────────────────

describe('send validation', () => {
  test('topic field present → malformed_frame with specific message', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);

    const framePromise = nextFrame(wsA);
    const closePromise = waitForClose(wsA);
    wsA.send(
      JSON.stringify({
        op: 'send',
        to: 'agent-b',
        topic: 'ci-alerts',
        type: 'direct',
        payload: {},
      }),
    );
    const [frame] = await Promise.all([framePromise, closePromise]);

    expect(frame.op).toBe('error');
    expect(frame.code).toBe('malformed_frame');
    expect(frame.message as string).toContain('topic sends not yet implemented');
  });
});

// ── ack ───────────────────────────────────────────────────────────────────────

describe('ack', () => {
  test('ack advances last_acked_cursor in bus_subscriptions', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    // Get B's connection_id for DB assertions
    const msgPromise = nextFrame(wsB);
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: {} }));
    const msg = await msgPromise;
    const cursor = msg.cursor as number;

    // Get B's connection_id from DB
    const subBefore = tmp.db
      .prepare(
        'SELECT connection_id, last_acked_cursor FROM bus_subscriptions WHERE agent_id = ? ORDER BY connected_at DESC LIMIT 1',
      )
      .get('agent-b') as { connection_id: string; last_acked_cursor: number };
    expect(subBefore.last_acked_cursor).toBe(0);

    // B acks
    wsB.send(JSON.stringify({ op: 'ack', cursor }));
    await new Promise((r) => setTimeout(r, 50));

    const subAfter = tmp.db
      .prepare('SELECT last_acked_cursor FROM bus_subscriptions WHERE connection_id = ?')
      .get(subBefore.connection_id) as { last_acked_cursor: number };
    expect(subAfter.last_acked_cursor).toBe(cursor);

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('ack ≤ last_acked_cursor is ignored (monotonic guard)', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    // Send and ack to get cursor > 0
    const msgPromise = nextFrame(wsB);
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: {} }));
    const msg = await msgPromise;
    const cursor = msg.cursor as number;

    wsB.send(JSON.stringify({ op: 'ack', cursor }));
    await new Promise((r) => setTimeout(r, 50));

    const sub = tmp.db
      .prepare(
        'SELECT connection_id, last_acked_cursor FROM bus_subscriptions WHERE agent_id = ? ORDER BY connected_at DESC LIMIT 1',
      )
      .get('agent-b') as { connection_id: string; last_acked_cursor: number };
    expect(sub.last_acked_cursor).toBe(cursor);

    // Now ack an earlier cursor — should be ignored
    wsB.send(JSON.stringify({ op: 'ack', cursor: Math.max(0, cursor - 1) }));
    await new Promise((r) => setTimeout(r, 50));

    const subAfter = tmp.db
      .prepare('SELECT last_acked_cursor FROM bus_subscriptions WHERE connection_id = ?')
      .get(sub.connection_id) as { last_acked_cursor: number };
    expect(subAfter.last_acked_cursor).toBe(cursor); // unchanged

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('ack past current head is ignored', async () => {
    const wsB = await handshake(port, 'agent-b', tokenB);

    const sub = tmp.db
      .prepare(
        'SELECT connection_id, last_acked_cursor FROM bus_subscriptions WHERE agent_id = ? ORDER BY connected_at DESC LIMIT 1',
      )
      .get('agent-b') as { connection_id: string; last_acked_cursor: number };

    const head = (
      tmp.db
        .prepare('SELECT COALESCE(MAX(id), 0) AS head FROM bus_messages')
        .get() as { head: number }
    ).head;

    // Ack well past current head
    wsB.send(JSON.stringify({ op: 'ack', cursor: head + 1000 }));
    await new Promise((r) => setTimeout(r, 50));

    const subAfter = tmp.db
      .prepare('SELECT last_acked_cursor FROM bus_subscriptions WHERE connection_id = ?')
      .get(sub.connection_id) as { last_acked_cursor: number };
    expect(subAfter.last_acked_cursor).toBe(sub.last_acked_cursor); // unchanged

    wsB.close();
    await waitForClose(wsB);
  });
});
