import http from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { BrokerServer } from '../../src/bus/broker.js';
import { runMigrations } from '../../src/bus/migrations.js';
import { mintToken } from '../../src/bus/tokens.js';
import { createTmpDb, type TmpDb } from '../fixtures/tmp-db.js';

// ── constants ─────────────────────────────────────────────────────────────────

const LIMIT = 5; // small limit so tests don't need to insert thousands of rows
const PAYLOAD = Buffer.from('{}', 'utf8');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Insert `count` direct messages addressed to `recipient` (unacked). */
function fillDirectInbox(
  db: ReturnType<typeof createTmpDb>['db'],
  recipient: string,
  count: number,
): number[] {
  const insert = db.prepare(
    `INSERT INTO bus_messages
       (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at)
     VALUES ('__fill__', ?, NULL, 'direct', ?, NULL, NULL, ?)`,
  );
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(Number(insert.run(recipient, PAYLOAD, Date.now()).lastInsertRowid));
  }
  return ids;
}

function directMsgCount(
  db: ReturnType<typeof createTmpDb>['db'],
  recipient: string,
): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM bus_messages WHERE to_agent = ?')
      .get(recipient) as { n: number }
  ).n;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    ws.once('message', (data) => {
      clearTimeout(t);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    ws.once('error', (err) => { clearTimeout(t); reject(err); });
  });
}

async function handshake(
  port: number,
  agentId: string,
  token: string,
): Promise<WebSocket> {
  const ws = await connect(port);
  const welcomeP = nextFrame(ws);
  ws.send(JSON.stringify({ op: 'hello', agent_id: agentId, token, protocol_version: 1 }));
  const welcome = await welcomeP;
  expect(welcome.op).toBe('welcome');
  return ws;
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('inbox-full back-pressure', () => {
  let tmp: TmpDb;
  let broker: BrokerServer;
  let port: number;
  let baseUrl: string;

  // Tokens keyed by agent_id
  const tokens: Record<string, string> = {};

  const AGENTS = [
    'agent-a',           // primary sender
    'agent-b-happy',     // test 1: happy path
    'agent-b-below',     // test 2: just below limit
    'agent-b-full',      // test 3+4: at limit / error frame fields
    'agent-b-open',      // test 5: connection stays open
    'agent-c-open',      // test 5: second recipient (empty inbox)
    'agent-b-persist',   // test 6: rejected not persisted
    'agent-b-stats',     // test 7: stats counters
    'agent-b-recover',   // test 8: recovery after ack
    'agent-a-topic',     // test 9: topic send unrelated to direct inbox
    'agent-b-topic',     // test 9: topic subscriber (clean)
    'agent-a-self',      // test 10: self-send
  ];

  beforeAll(async () => {
    tmp = createTmpDb();
    runMigrations(tmp.db);

    for (const agentId of AGENTS) {
      const { plaintext } = mintToken(tmp.db, { agent_id: agentId, scope: 'agent' });
      tokens[agentId] = plaintext;
    }

    broker = new BrokerServer(tmp.db, tmp.path, { inboxLimit: LIMIT });
    await broker.start(0);
    port = broker.address()!.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await broker.close();
    tmp.cleanup();
  });

  // 1 ── happy path: empty inbox → accepted ─────────────────────────────────

  test('direct send to empty inbox is accepted', async () => {
    const before = directMsgCount(tmp.db, 'agent-b-happy');
    const ws = await handshake(port, 'agent-a', tokens['agent-a']!);

    ws.send(JSON.stringify({
      op: 'send', to: 'agent-b-happy', type: 'direct', payload: { x: 1 },
    }));
    // No error frame expected; give broker a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(directMsgCount(tmp.db, 'agent-b-happy')).toBe(before + 1);
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 2 ── just below limit (limit-1 unacked) → accepted ─────────────────────

  test('send when inbox depth is limit-1 is accepted', async () => {
    // Fill to LIMIT-1 unacked messages
    fillDirectInbox(tmp.db, 'agent-b-below', LIMIT - 1);
    const before = directMsgCount(tmp.db, 'agent-b-below');
    expect(before).toBe(LIMIT - 1);

    const ws = await handshake(port, 'agent-a', tokens['agent-a']!);
    ws.send(JSON.stringify({
      op: 'send', to: 'agent-b-below', type: 'direct', payload: {},
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Message accepted: count increased to LIMIT (inbox now AT limit)
    expect(directMsgCount(tmp.db, 'agent-b-below')).toBe(LIMIT);
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 3 ── at limit: send rejected ────────────────────────────────────────────

  test('direct send when inbox is at limit is rejected', async () => {
    fillDirectInbox(tmp.db, 'agent-b-full', LIMIT);

    const ws = await handshake(port, 'agent-a', tokens['agent-a']!);
    const errorP = nextFrame(ws);
    ws.send(JSON.stringify({
      op: 'send', to: 'agent-b-full', type: 'direct', payload: {},
    }));
    const err = await errorP;

    expect(err.op).toBe('error');
    expect(err.code).toBe('inbox_full');
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 4 ── error frame carries correct fields ─────────────────────────────────

  test('inbox_full error frame has agent_id, current_depth, limit fields', async () => {
    // agent-b-full already has LIMIT messages from test 3
    const ws = await handshake(port, 'agent-a', tokens['agent-a']!);
    const errorP = nextFrame(ws);
    ws.send(JSON.stringify({
      op: 'send', to: 'agent-b-full', type: 'direct', payload: {},
    }));
    const err = await errorP;

    expect(err).toMatchObject({
      op: 'error',
      code: 'inbox_full',
      agent_id: 'agent-b-full', // RECIPIENT, not sender
      current_depth: LIMIT,
      limit: LIMIT,
    });
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 5 ── connection stays open after inbox_full ──────────────────────────────

  test('sender connection stays open after receiving inbox_full', async () => {
    fillDirectInbox(tmp.db, 'agent-b-open', LIMIT);

    const ws = await handshake(port, 'agent-a', tokens['agent-a']!);
    let closed = false;
    ws.once('close', () => { closed = true; });

    // First send → inbox_full (connection should NOT close)
    const errorP = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'send', to: 'agent-b-open', type: 'direct', payload: {} }));
    const err = await errorP;
    expect(err.code).toBe('inbox_full');

    // Wait a tick — if the server closed the connection it would fire by now
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);

    // Second op on the SAME connection — send to a different (empty-inbox) recipient
    ws.send(JSON.stringify({ op: 'send', to: 'agent-c-open', type: 'direct', payload: {} }));
    await new Promise((r) => setTimeout(r, 50));

    // Verify the second send succeeded (message written, no second error frame)
    expect(directMsgCount(tmp.db, 'agent-c-open')).toBe(1);
    expect(closed).toBe(false);

    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 6 ── rejected send not written to bus_messages ───────────────────────────

  test('rejected send does not persist a row in bus_messages', async () => {
    fillDirectInbox(tmp.db, 'agent-b-persist', LIMIT);
    const before = directMsgCount(tmp.db, 'agent-b-persist');

    const ws = await handshake(port, 'agent-a', tokens['agent-a']!);
    const errorP = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'send', to: 'agent-b-persist', type: 'direct', payload: {} }));
    const err = await errorP;
    expect(err.code).toBe('inbox_full');

    expect(directMsgCount(tmp.db, 'agent-b-persist')).toBe(before);
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 7 ── stats: messages_total unchanged, inbox_full_total incremented ───────

  test('inbox_full_total increments on rejection, messages_total does not', async () => {
    fillDirectInbox(tmp.db, 'agent-b-stats', LIMIT);

    const before = JSON.parse((await httpGet(`${baseUrl}/bus_stats`)).body) as Record<string, number>;

    const ws = await handshake(port, 'agent-a', tokens['agent-a']!);
    const errorP = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'send', to: 'agent-b-stats', type: 'direct', payload: {} }));
    await errorP;
    await new Promise((r) => setTimeout(r, 50));

    const after = JSON.parse((await httpGet(`${baseUrl}/bus_stats`)).body) as Record<string, number>;

    expect(after.messages_total).toBe(before.messages_total);
    expect(after.inbox_full_total).toBe(before.inbox_full_total + 1);

    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 8 ── recovery after ack: depth drops, next send accepted ─────────────────

  test('send succeeds after recipient acks enough messages', async () => {
    const ids = fillDirectInbox(tmp.db, 'agent-b-recover', LIMIT);
    // Inbox is now at LIMIT — any direct send would be rejected.

    // Connect recipient (agent-b-recover), ack one message to drop depth below limit
    const recipWs = await handshake(port, 'agent-b-recover', tokens['agent-b-recover']!);
    recipWs.send(JSON.stringify({ op: 'ack', cursor: ids[0]! }));
    await new Promise((r) => setTimeout(r, 50));

    // Depth is now LIMIT - 1 < LIMIT — send from agent-a should succeed
    const senderWs = await handshake(port, 'agent-a', tokens['agent-a']!);
    const beforeCount = directMsgCount(tmp.db, 'agent-b-recover');
    senderWs.send(JSON.stringify({ op: 'send', to: 'agent-b-recover', type: 'direct', payload: {} }));
    await new Promise((r) => setTimeout(r, 50));

    expect(directMsgCount(tmp.db, 'agent-b-recover')).toBe(beforeCount + 1);

    recipWs.close();
    senderWs.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 9 ── topic sends always accepted regardless of direct inbox depth ─────────

  test('topic send succeeds even when sender direct inbox is at limit', async () => {
    fillDirectInbox(tmp.db, 'agent-a-topic', LIMIT);

    // Subscribe agent-b-topic to the test topic via direct SQL (simpler than WS subscribe)
    tmp.db
      .prepare('INSERT OR IGNORE INTO bus_topics (agent_id, topic) VALUES (?, ?)')
      .run('agent-b-topic', 't/inbox-test');

    const ws = await handshake(port, 'agent-a-topic', tokens['agent-a-topic']!);
    const beforeTopicCount = (
      tmp.db
        .prepare("SELECT COUNT(*) AS n FROM bus_messages WHERE topic = 't/inbox-test'")
        .get() as { n: number }
    ).n;

    // No error frame expected for topic send
    ws.send(JSON.stringify({ op: 'send', topic: 't/inbox-test', type: 'event', payload: {} }));
    await new Promise((r) => setTimeout(r, 50));

    const afterTopicCount = (
      tmp.db
        .prepare("SELECT COUNT(*) AS n FROM bus_messages WHERE topic = 't/inbox-test'")
        .get() as { n: number }
    ).n;
    expect(afterTopicCount).toBe(beforeTopicCount + 1);

    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  // 10 ── self-send: inbox_full applies when sending to yourself ─────────────

  test('self-send is rejected when own direct inbox is at limit', async () => {
    fillDirectInbox(tmp.db, 'agent-a-self', LIMIT);

    const ws = await handshake(port, 'agent-a-self', tokens['agent-a-self']!);
    const errorP = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'send', to: 'agent-a-self', type: 'direct', payload: {} }));
    const err = await errorP;

    expect(err).toMatchObject({
      op: 'error',
      code: 'inbox_full',
      agent_id: 'agent-a-self',
      current_depth: LIMIT,
      limit: LIMIT,
    });

    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });
});
