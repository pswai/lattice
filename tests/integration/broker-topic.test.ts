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

  broker = new BrokerServer(tmp.db, tmp.path);
  await broker.start(0);
  port = broker.address()!.port;
});

afterAll(async () => {
  await broker.close();
  tmp.cleanup();
});

// ── subscribe persistence ─────────────────────────────────────────────────────

describe('subscribe persistence', () => {
  test('subscribe persists rows in bus_topics', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);

    wsA.send(JSON.stringify({ op: 'subscribe', topics: ['ci-alerts'] }));
    await new Promise((r) => setTimeout(r, 50));

    const row = tmp.db
      .prepare('SELECT agent_id, topic FROM bus_topics WHERE agent_id = ? AND topic = ?')
      .get('agent-a', 'ci-alerts') as { agent_id: string; topic: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.agent_id).toBe('agent-a');
    expect(row!.topic).toBe('ci-alerts');

    wsA.close();
    await waitForClose(wsA);
  });

  test('subscribe twice to same topic is idempotent (INSERT OR IGNORE)', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);

    wsA.send(JSON.stringify({ op: 'subscribe', topics: ['idempotent-topic'] }));
    wsA.send(JSON.stringify({ op: 'subscribe', topics: ['idempotent-topic'] }));
    await new Promise((r) => setTimeout(r, 50));

    const count = (
      tmp.db
        .prepare('SELECT COUNT(*) AS n FROM bus_topics WHERE agent_id = ? AND topic = ?')
        .get('agent-a', 'idempotent-topic') as { n: number }
    ).n;
    expect(count).toBe(1);

    wsA.close();
    await waitForClose(wsA);
  });

  test('multi-topic subscribe in one call: 3 rows inserted', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);

    // Clear any prior rows for agent-a to make count assertions clean
    tmp.db
      .prepare("DELETE FROM bus_topics WHERE agent_id = ? AND topic IN ('multi-1', 'multi-2', 'multi-3')")
      .run('agent-a');

    wsA.send(JSON.stringify({ op: 'subscribe', topics: ['multi-1', 'multi-2', 'multi-3'] }));
    await new Promise((r) => setTimeout(r, 50));

    const count = (
      tmp.db
        .prepare("SELECT COUNT(*) AS n FROM bus_topics WHERE agent_id = ? AND topic IN ('multi-1', 'multi-2', 'multi-3')")
        .get('agent-a') as { n: number }
    ).n;
    expect(count).toBe(3);

    wsA.close();
    await waitForClose(wsA);
  });

  test('subscription survives reconnect (agent-scoped, not connection-scoped)', async () => {
    // A subscribes on first connection
    const wsA1 = await handshake(port, 'agent-a', tokenA);
    wsA1.send(JSON.stringify({ op: 'subscribe', topics: ['reconnect-topic'] }));
    await new Promise((r) => setTimeout(r, 50));
    wsA1.close();
    await waitForClose(wsA1);
    await new Promise((r) => setTimeout(r, 50)); // wait for server-side cleanup

    // A reconnects on a new connection; the bus_topics row is still there
    const wsA2 = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    const msgPromise = nextFrame(wsA2);
    wsB.send(JSON.stringify({ op: 'send', topic: 'reconnect-topic', type: 'broadcast', payload: { reconnected: true } }));
    const msg = await msgPromise;

    expect(msg.op).toBe('message');
    expect(msg.topic).toBe('reconnect-topic');
    expect(msg.payload).toEqual({ reconnected: true });

    wsA2.close();
    wsB.close();
    await Promise.all([waitForClose(wsA2), waitForClose(wsB)]);
  });
});

// ── topic delivery ────────────────────────────────────────────────────────────

describe('topic delivery', () => {
  test('A subscribes to topic, B sends to topic, A receives', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    wsA.send(JSON.stringify({ op: 'subscribe', topics: ['ci-alerts'] }));
    await new Promise((r) => setTimeout(r, 50));

    const msgPromise = nextFrame(wsA);
    wsB.send(JSON.stringify({ op: 'send', topic: 'ci-alerts', type: 'broadcast', payload: { alert: 'build-failed' } }));
    const msg = await msgPromise;

    expect(msg.op).toBe('message');
    expect(msg.from).toBe('agent-b');
    expect(msg.topic).toBe('ci-alerts');
    expect(msg.payload).toEqual({ alert: 'build-failed' });
    expect(typeof msg.cursor).toBe('number');
    expect(typeof msg.created_at).toBe('number');

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('topic field is null in direct message frames', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    const msgPromise = nextFrame(wsB);
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: {} }));
    const msg = await msgPromise;

    expect(msg.topic).toBeNull();

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('topic field is topic name in topic message frames', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    wsA.send(JSON.stringify({ op: 'subscribe', topics: ['deploys'] }));
    await new Promise((r) => setTimeout(r, 50));

    const msgPromise = nextFrame(wsA);
    wsB.send(JSON.stringify({ op: 'send', topic: 'deploys', type: 'broadcast', payload: {} }));
    const msg = await msgPromise;

    expect(msg.topic).toBe('deploys');

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('unsubscribed agent does not receive topic messages', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    // agent-b has NOT subscribed to this topic
    // agent-a sends to it; agent-b should NOT receive
    wsA.send(JSON.stringify({ op: 'send', topic: 'unsubscribed-topic', type: 'broadcast', payload: {} }));

    // Wait; if agent-b receives anything, the test fails
    const raceResult = await Promise.race([
      nextFrame(wsB).then(() => 'received'),
      new Promise<'silence'>((r) => setTimeout(() => r('silence'), 200)),
    ]);
    expect(raceResult).toBe('silence');

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });

  test('sender-is-subscriber: A subscribes to topic, A sends, A receives (no self-suppression)', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);

    wsA.send(JSON.stringify({ op: 'subscribe', topics: ['self-topic'] }));
    await new Promise((r) => setTimeout(r, 50));

    const msgPromise = nextFrame(wsA);
    wsA.send(JSON.stringify({ op: 'send', topic: 'self-topic', type: 'broadcast', payload: { self: true } }));
    const msg = await msgPromise;

    expect(msg.op).toBe('message');
    expect(msg.from).toBe('agent-a');
    expect(msg.topic).toBe('self-topic');
    expect(msg.payload).toEqual({ self: true });

    wsA.close();
    await waitForClose(wsA);
  });

  test('multiple connections per subscriber: both connections receive', async () => {
    // Two connections for agent-a using the same token
    const wsA1 = await handshake(port, 'agent-a', tokenA);
    const wsA2 = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    // Subscribe on either connection — subscription is agent-scoped, not connection-scoped
    wsA1.send(JSON.stringify({ op: 'subscribe', topics: ['multi-conn-topic'] }));
    await new Promise((r) => setTimeout(r, 50));

    const msg1Promise = nextFrame(wsA1);
    const msg2Promise = nextFrame(wsA2);
    wsB.send(JSON.stringify({ op: 'send', topic: 'multi-conn-topic', type: 'broadcast', payload: { all: true } }));

    const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);

    expect(msg1.op).toBe('message');
    expect(msg2.op).toBe('message');
    expect(msg1.payload).toEqual({ all: true });
    expect(msg2.payload).toEqual({ all: true });

    wsA1.close();
    wsA2.close();
    wsB.close();
    await Promise.all([waitForClose(wsA1), waitForClose(wsA2), waitForClose(wsB)]);
  });

  test('multi-topic subscribe: deliver to subscribed topic, not to unsubscribed topic', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    // Subscribe to 3 topics in one call
    wsA.send(JSON.stringify({ op: 'subscribe', topics: ['mt-alerts', 'mt-deploys', 'mt-events'] }));
    await new Promise((r) => setTimeout(r, 50));

    // Send to a subscribed topic → A receives
    const msgPromise = nextFrame(wsA);
    wsB.send(JSON.stringify({ op: 'send', topic: 'mt-deploys', type: 'broadcast', payload: { deployed: true } }));
    const msg = await msgPromise;
    expect(msg.topic).toBe('mt-deploys');
    expect(msg.payload).toEqual({ deployed: true });

    // Send to an unsubscribed topic → A does NOT receive
    wsB.send(JSON.stringify({ op: 'send', topic: 'mt-other', type: 'broadcast', payload: {} }));
    const raceResult = await Promise.race([
      nextFrame(wsA).then(() => 'received'),
      new Promise<'silence'>((r) => setTimeout(() => r('silence'), 200)),
    ]);
    expect(raceResult).toBe('silence');

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });
});

// ── topic persistence in bus_messages ─────────────────────────────────────────

describe('topic message storage', () => {
  test('topic send: to_agent is NULL, topic is set in bus_messages', async () => {
    const wsA = await handshake(port, 'agent-a', tokenA);
    const wsB = await handshake(port, 'agent-b', tokenB);

    wsB.send(JSON.stringify({ op: 'subscribe', topics: ['storage-topic'] }));
    await new Promise((r) => setTimeout(r, 50));

    const msgPromise = nextFrame(wsB);
    wsA.send(JSON.stringify({ op: 'send', topic: 'storage-topic', type: 'broadcast', payload: { stored: true } }));
    const msg = await msgPromise;
    const cursor = msg.cursor as number;

    const row = tmp.db
      .prepare('SELECT to_agent, topic FROM bus_messages WHERE id = ?')
      .get(cursor) as { to_agent: string | null; topic: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.to_agent).toBeNull();
    expect(row!.topic).toBe('storage-topic');

    wsA.close();
    wsB.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
  });
});
