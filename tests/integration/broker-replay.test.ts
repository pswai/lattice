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

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', () => resolve());
  });
}

function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: no frame received')), 5000);
    ws.once('message', (data) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        reject(new Error('response is not valid JSON'));
      }
    });
    ws.once('error', (err) => { clearTimeout(t); reject(err); });
  });
}

// Connect, attach collection handler FIRST, then send hello.
// Returns all frames including the welcome, so callers can slice.
// Must attach before send to avoid dropping replay frames that arrive
// before a later collectFrames call can register its handler.
function collectFrames(ws: WebSocket, count: number, timeout = 10000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    const t = setTimeout(
      () => reject(new Error(`timeout: collected ${frames.length}/${count} frames`)),
      timeout,
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

// Collect frames until a 'gap' op arrives (inclusive), or timeout.
// Attach handler BEFORE sending hello to avoid dropping frames.
function collectUntilGap(ws: WebSocket, timeout = 20000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    const t = setTimeout(
      () => reject(new Error(`timeout: collected ${frames.length} frames, no gap op`)),
      timeout,
    );
    const handler = (data: WebSocket.RawData): void => {
      try {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.op === 'gap') {
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

// Standard handshake: send hello, consume welcome, return authenticated socket.
async function handshake(port: number, agentId: string, token: string): Promise<WebSocket> {
  const ws = await connect(port);
  const framePromise = nextFrame(ws);
  ws.send(JSON.stringify({ op: 'hello', agent_id: agentId, token, protocol_version: 1 }));
  const frame = await framePromise;
  if (frame.op !== 'welcome') throw new Error(`expected welcome, got ${JSON.stringify(frame)}`);
  return ws;
}

// Replay handshake: attach collector BEFORE sending hello so no frames are dropped.
// Returns { ws, welcome, replayFrames } where replayFrames is everything after welcome.
async function replayHandshake(
  port: number,
  agentId: string,
  token: string,
  lastAckedCursor: number,
  expectedReplayCount: number, // how many replay message frames to wait for
): Promise<{ ws: WebSocket; welcome: Record<string, unknown>; replayFrames: Record<string, unknown>[] }> {
  const ws = await connect(port);
  // Attach collector BEFORE sending hello — replay frames may arrive immediately
  const framesPromise = collectFrames(ws, 1 + expectedReplayCount); // +1 for welcome
  ws.send(
    JSON.stringify({
      op: 'hello',
      agent_id: agentId,
      token,
      protocol_version: 1,
      last_acked_cursor: lastAckedCursor,
      replay: true,
    }),
  );
  const allFrames = await framesPromise;
  return { ws, welcome: allFrames[0]!, replayFrames: allFrames.slice(1) };
}

// Replay handshake for gap scenario — attach gap collector BEFORE hello.
async function replayHandshakeUntilGap(
  port: number,
  agentId: string,
  token: string,
  lastAckedCursor: number,
): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const ws = await connect(port);
  // Attach BEFORE sending hello
  const framesPromise = collectUntilGap(ws);
  ws.send(
    JSON.stringify({
      op: 'hello',
      agent_id: agentId,
      token,
      protocol_version: 1,
      last_acked_cursor: lastAckedCursor,
      replay: true,
    }),
  );
  const frames = await framesPromise;
  return { ws, frames };
}

// ── fixture ───────────────────────────────────────────────────────────────────

let tmp: TmpDb;
let broker: BrokerServer;
let port: number;
let tokenA: string;
let tokenB: string;

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

// ── replay: basic direct messages ─────────────────────────────────────────────

describe('replay: basic direct messages', () => {
  test('B reconnects with replay:true — receives all missed direct messages', async () => {
    // Get B online to record baseCursor, then disconnect cleanly
    const wsB0 = await handshake(port, 'agent-b', tokenB);
    const baseCursor = (
      tmp.db
        .prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages')
        .get() as { max_id: number }
    ).max_id;
    wsB0.close();
    await waitForClose(wsB0);
    await new Promise((r) => setTimeout(r, 50));

    // A sends 5 direct messages while B is offline
    const wsA = await handshake(port, 'agent-a', tokenA);
    for (let i = 0; i < 5; i++) {
      wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { seq: i } }));
    }
    await new Promise((r) => setTimeout(r, 50));

    // B reconnects with replay:true — attach collector BEFORE hello
    const { ws: wsB1, welcome, replayFrames } = await replayHandshake(
      port, 'agent-b', tokenB, baseCursor, 5,
    );

    expect(welcome.replaying).toBe(true);
    expect(replayFrames).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(replayFrames[i]!.op).toBe('message');
      expect((replayFrames[i]!.payload as Record<string, unknown>).seq).toBe(i);
      expect(replayFrames[i]!.topic).toBeNull();
    }
    const cursors = replayFrames.map((f) => f.cursor as number);
    for (let i = 1; i < cursors.length; i++) {
      expect(cursors[i]!).toBeGreaterThan(cursors[i - 1]!);
    }

    wsA.close();
    wsB1.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB1)]);
  });

  test('replay:false — missed messages are NOT delivered', async () => {
    // Get baseCursor, disconnect B
    const wsB0 = await handshake(port, 'agent-b', tokenB);
    const baseCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;
    wsB0.close();
    await waitForClose(wsB0);
    await new Promise((r) => setTimeout(r, 50));

    // A sends 3 messages to B
    const wsA = await handshake(port, 'agent-a', tokenA);
    for (let i = 0; i < 3; i++) {
      wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { seq: i } }));
    }
    await new Promise((r) => setTimeout(r, 50));

    // B reconnects with replay:false
    const ws = await connect(port);
    const welcomePromise = nextFrame(ws);
    ws.send(
      JSON.stringify({
        op: 'hello',
        agent_id: 'agent-b',
        token: tokenB,
        protocol_version: 1,
        last_acked_cursor: baseCursor,
        replay: false,
      }),
    );
    const welcome = await welcomePromise;
    expect(welcome.op).toBe('welcome');
    expect(welcome.replaying).toBe(false);

    // No replay frames should arrive
    const raceResult = await Promise.race([
      nextFrame(ws).then(() => 'received'),
      new Promise<'silence'>((r) => setTimeout(() => r('silence'), 200)),
    ]);
    expect(raceResult).toBe('silence');

    wsA.close();
    ws.close();
    await Promise.all([waitForClose(wsA), waitForClose(ws)]);
  });
});

// ── replay: topic messages ─────────────────────────────────────────────────────

describe('replay: topic messages', () => {
  test('topic messages replayed for subscribed agent', async () => {
    // B subscribes to topic, then disconnects
    const wsB0 = await handshake(port, 'agent-b', tokenB);
    wsB0.send(JSON.stringify({ op: 'subscribe', topics: ['replay-alerts'] }));
    await new Promise((r) => setTimeout(r, 50));
    const baseCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;
    wsB0.close();
    await waitForClose(wsB0);
    await new Promise((r) => setTimeout(r, 50));

    // A sends 3 topic broadcasts while B is offline
    const wsA = await handshake(port, 'agent-a', tokenA);
    for (let i = 0; i < 3; i++) {
      wsA.send(
        JSON.stringify({ op: 'send', topic: 'replay-alerts', type: 'broadcast', payload: { seq: i } }),
      );
    }
    await new Promise((r) => setTimeout(r, 50));

    // B reconnects with replay
    const { ws: wsB1, welcome, replayFrames } = await replayHandshake(
      port, 'agent-b', tokenB, baseCursor, 3,
    );

    expect(welcome.replaying).toBe(true);
    expect(replayFrames).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(replayFrames[i]!.op).toBe('message');
      expect(replayFrames[i]!.topic).toBe('replay-alerts');
      expect((replayFrames[i]!.payload as Record<string, unknown>).seq).toBe(i);
    }

    wsA.close();
    wsB1.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB1)]);
  });

  test('mixed direct + topic replay arrive in cursor order', async () => {
    // B subscribes then disconnects
    const wsB0 = await handshake(port, 'agent-b', tokenB);
    wsB0.send(JSON.stringify({ op: 'subscribe', topics: ['mixed-topic'] }));
    await new Promise((r) => setTimeout(r, 50));
    const baseCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;
    wsB0.close();
    await waitForClose(wsB0);
    await new Promise((r) => setTimeout(r, 50));

    // A sends: direct, topic, direct, topic — interleaved
    const wsA = await handshake(port, 'agent-a', tokenA);
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { n: 0 } }));
    wsA.send(JSON.stringify({ op: 'send', topic: 'mixed-topic', type: 'broadcast', payload: { n: 1 } }));
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { n: 2 } }));
    wsA.send(JSON.stringify({ op: 'send', topic: 'mixed-topic', type: 'broadcast', payload: { n: 3 } }));
    await new Promise((r) => setTimeout(r, 50));

    // B reconnects with replay — expects 4 interleaved frames in cursor order
    const { ws: wsB1, replayFrames } = await replayHandshake(
      port, 'agent-b', tokenB, baseCursor, 4,
    );

    expect(replayFrames).toHaveLength(4);
    expect((replayFrames[0]!.payload as Record<string, unknown>).n).toBe(0);
    expect(replayFrames[0]!.topic).toBeNull();

    expect((replayFrames[1]!.payload as Record<string, unknown>).n).toBe(1);
    expect(replayFrames[1]!.topic).toBe('mixed-topic');

    expect((replayFrames[2]!.payload as Record<string, unknown>).n).toBe(2);
    expect(replayFrames[2]!.topic).toBeNull();

    expect((replayFrames[3]!.payload as Record<string, unknown>).n).toBe(3);
    expect(replayFrames[3]!.topic).toBe('mixed-topic');

    // Cursors strictly increasing — OR clause preserves global cursor order
    for (let i = 1; i < replayFrames.length; i++) {
      expect(replayFrames[i]!.cursor as number).toBeGreaterThan(
        replayFrames[i - 1]!.cursor as number,
      );
    }

    wsA.close();
    wsB1.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB1)]);
  });

  test('only own messages replayed — messages for other agents excluded', async () => {
    const tokenC = mintToken(tmp.db, { agent_id: 'agent-c', scope: 'agent' }).plaintext;

    // B disconnects to set baseline
    const wsB0 = await handshake(port, 'agent-b', tokenB);
    const baseCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;
    wsB0.close();
    await waitForClose(wsB0);
    await new Promise((r) => setTimeout(r, 50));

    // A sends: to-B, to-C, to-B
    const wsA = await handshake(port, 'agent-a', tokenA);
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { for: 'b' } }));
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-c', type: 'direct', payload: { for: 'c' } }));
    wsA.send(JSON.stringify({ op: 'send', to: 'agent-b', type: 'direct', payload: { for: 'b2' } }));
    await new Promise((r) => setTimeout(r, 50));

    // B replays — should receive only B's 2 messages
    const { ws: wsB1, replayFrames } = await replayHandshake(
      port, 'agent-b', tokenB, baseCursor, 2,
    );

    expect(replayFrames).toHaveLength(2);
    expect((replayFrames[0]!.payload as Record<string, unknown>).for).toBe('b');
    expect((replayFrames[1]!.payload as Record<string, unknown>).for).toBe('b2');

    // No third frame arrives
    const raceResult = await Promise.race([
      nextFrame(wsB1).then(() => 'received'),
      new Promise<'silence'>((r) => setTimeout(() => r('silence'), 150)),
    ]);
    expect(raceResult).toBe('silence');

    wsA.close();
    wsB1.close();
    await Promise.all([waitForClose(wsA), waitForClose(wsB1)]);
    void tokenC;
  });
});

// ── replay from cursor 0 ──────────────────────────────────────────────────────

describe('replay from cursor 0', () => {
  test('replay:true, last_acked_cursor:0 replays messages from the beginning', async () => {
    // Insert 3 messages directly into the DB
    const payload = Buffer.from(JSON.stringify({ from_zero: true }), 'utf8');
    const now = Date.now();
    const insertStmt = tmp.db.prepare(
      'INSERT INTO bus_messages (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?)',
    );
    for (let i = 0; i < 3; i++) {
      insertStmt.run('agent-a', 'agent-b', 'direct', payload, now);
    }

    const currentCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;

    // Count how many messages agent-b can see from cursor 0 (respecting topic subscriptions)
    const { cnt: bVisibleCount } = tmp.db.prepare(`
      SELECT COUNT(*) AS cnt FROM bus_messages
      WHERE id > 0 AND id <= ?
        AND (to_agent = 'agent-b'
             OR (topic IS NOT NULL
                 AND topic IN (SELECT topic FROM bus_topics WHERE agent_id = 'agent-b')))
    `).get(currentCursor) as { cnt: number };

    // Shared DB accumulates messages across tests but stays well within the 1000-msg cap
    expect(bVisibleCount).toBeLessThanOrEqual(1000);

    // B connects with last_acked_cursor:0 — attach collector BEFORE hello
    const { ws, welcome, replayFrames } = await replayHandshake(
      port, 'agent-b', tokenB, 0, bVisibleCount,
    );

    expect(welcome.replaying).toBe(true);
    expect(replayFrames).toHaveLength(bVisibleCount);

    // The 3 from_zero messages must be present
    const fromZeroFrames = replayFrames.filter(
      (f) => (f.payload as Record<string, unknown>)?.from_zero === true,
    );
    expect(fromZeroFrames).toHaveLength(3);

    ws.close();
    await waitForClose(ws);
  });
});

// ── gap handling ──────────────────────────────────────────────────────────────

describe('gap handling', () => {
  test('count cap: 1001 messages → 1000 replayed then gap op', async () => {
    // Snapshot cursor before bulk insert
    const baseCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;

    // Insert exactly 1001 direct messages for agent-b
    const payload = Buffer.from('{}', 'utf8');
    const now = Date.now();
    const insert = tmp.db.prepare(
      'INSERT INTO bus_messages (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?)',
    );
    for (let i = 0; i < 1001; i++) {
      insert.run('agent-a', 'agent-b', 'direct', payload, now);
    }

    const currentCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;

    // B reconnects with replay — attach gap collector BEFORE hello
    const { ws, frames } = await replayHandshakeUntilGap(port, 'agent-b', tokenB, baseCursor);

    // First frame is welcome
    expect(frames[0]!.op).toBe('welcome');
    expect(frames[0]!.replaying).toBe(true);

    const messageFrames = frames.filter((f) => f.op === 'message');
    const gapFrame = frames[frames.length - 1]!;

    expect(messageFrames).toHaveLength(1000);
    expect(gapFrame.op).toBe('gap');
    expect(gapFrame.from).toBe(baseCursor);
    expect(gapFrame.to).toBe(currentCursor);
    expect(gapFrame.reason).toBe('replay_cap');
    // Exact field check — no extra fields on the gap frame
    expect(Object.keys(gapFrame).sort()).toEqual(['from', 'op', 'reason', 'to']);

    ws.close();
    await waitForClose(ws);
  });

  test('time cap: messages spanning >5 min → gap op after first message', async () => {
    // Snapshot cursor before insert
    const baseCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;

    // Insert 2 messages: first now, second 6 min in the future (simulates a 6-min span)
    const payload = Buffer.from('{}', 'utf8');
    const now = Date.now();
    const sixMinLater = now + 6 * 60 * 1000;
    tmp.db
      .prepare(
        'INSERT INTO bus_messages (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?)',
      )
      .run('agent-a', 'agent-b', 'direct', payload, now);
    tmp.db
      .prepare(
        'INSERT INTO bus_messages (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?)',
      )
      .run('agent-a', 'agent-b', 'direct', payload, sixMinLater);

    const currentCursor = (
      tmp.db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages').get() as { max_id: number }
    ).max_id;

    // B reconnects with replay — attach gap collector BEFORE hello
    const { ws, frames } = await replayHandshakeUntilGap(port, 'agent-b', tokenB, baseCursor);

    // First frame welcome, then 1 message, then gap
    expect(frames[0]!.op).toBe('welcome');
    const messageFrames = frames.filter((f) => f.op === 'message');
    const gapFrame = frames[frames.length - 1]!;

    expect(messageFrames).toHaveLength(1);
    expect(gapFrame.op).toBe('gap');
    expect(gapFrame.from).toBe(baseCursor);
    expect(gapFrame.to).toBe(currentCursor);
    expect(gapFrame.reason).toBe('replay_cap');

    ws.close();
    await waitForClose(ws);
  });
});
