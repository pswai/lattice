import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { BrokerServer } from '../../src/bus/broker.js';
import { runMigrations } from '../../src/bus/migrations.js';
import { runRetentionCleanup } from '../../src/bus/retention.js';
import { mintToken } from '../../src/bus/tokens.js';
import { createTmpDb, type TmpDb } from '../fixtures/tmp-db.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const PAST = Date.now() - 40 * 86_400_000; // 40 days ago — always past 30-day retention
const RECENT = Date.now() - 1 * 86_400_000; // 1 day ago — always within 30-day retention
const PAYLOAD = Buffer.from('{"x":1}', 'utf8');

function insertMsg(
  db: ReturnType<typeof createTmpDb>['db'],
  opts: { toAgent?: string; topic?: string; createdAt: number },
): number {
  const res = db
    .prepare(
      `INSERT INTO bus_messages
         (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at)
       VALUES (?, ?, ?, 'direct', ?, NULL, NULL, ?)`,
    )
    .run('sender', opts.toAgent ?? null, opts.topic ?? null, PAYLOAD, opts.createdAt);
  return res.lastInsertRowid as number;
}

function setAgentCursor(
  db: ReturnType<typeof createTmpDb>['db'],
  agentId: string,
  cursor: number,
): void {
  db.prepare(
    `INSERT INTO bus_agent_cursors (agent_id, last_acked_cursor, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE
       SET last_acked_cursor = ?, updated_at = ?`,
  ).run(agentId, cursor, Date.now(), cursor, Date.now());
}

function subscribeTopic(
  db: ReturnType<typeof createTmpDb>['db'],
  agentId: string,
  topic: string,
): void {
  db.prepare('INSERT OR IGNORE INTO bus_topics (agent_id, topic) VALUES (?, ?)').run(agentId, topic);
}

function msgExists(db: ReturnType<typeof createTmpDb>['db'], id: number): boolean {
  return db.prepare('SELECT 1 FROM bus_messages WHERE id = ?').get(id) !== undefined;
}

function deadLetterCount(db: ReturnType<typeof createTmpDb>['db']): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM bus_dead_letters').get() as { n: number }).n;
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

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', () => resolve());
  });
}

// ── direct message retention ──────────────────────────────────────────────────

describe('direct message retention', () => {
  let tmp: TmpDb;

  beforeAll(() => {
    tmp = createTmpDb();
    runMigrations(tmp.db);
  });

  afterAll(() => tmp.cleanup());

  test('empty DB → {deleted:0, deadLettered:0}', () => {
    const result = runRetentionCleanup(tmp.db, 30);
    expect(result).toEqual({ deleted: 0, deadLettered: 0 });
  });

  test('fully acked + past retention → deleted from bus_messages', () => {
    const id = insertMsg(tmp.db, { toAgent: 'agent-acked', createdAt: PAST });
    setAgentCursor(tmp.db, 'agent-acked', id); // cursor = msg id → acked

    const result = runRetentionCleanup(tmp.db, 30);

    expect(result.deleted).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(msgExists(tmp.db, id)).toBe(false);
    expect(deadLetterCount(tmp.db)).toBe(0);
  });

  test('not acked + past retention → dead-lettered and removed from bus_messages', () => {
    const id = insertMsg(tmp.db, { toAgent: 'agent-unacked', createdAt: PAST });
    // No bus_agent_cursors row for agent-unacked → cursor effectively 0 < id

    const result = runRetentionCleanup(tmp.db, 30);

    expect(result.deleted).toBe(0);
    expect(result.deadLettered).toBe(1);
    expect(msgExists(tmp.db, id)).toBe(false);

    const dlRow = tmp.db
      .prepare('SELECT message_id, reason FROM bus_dead_letters WHERE message_id = ?')
      .get(id) as { message_id: number; reason: string } | undefined;
    expect(dlRow).toBeDefined();
    expect(dlRow!.message_id).toBe(id);
    expect(dlRow!.reason).toBe('retention_expired');
  });

  test('within retention window → untouched', () => {
    const id = insertMsg(tmp.db, { toAgent: 'agent-recent', createdAt: RECENT });

    const result = runRetentionCleanup(tmp.db, 30);

    // Only the 'recent' message exists; it should be untouched
    expect(msgExists(tmp.db, id)).toBe(true);
    // Nothing new should have been processed
    expect(result.deleted).toBe(0);
    expect(result.deadLettered).toBe(0);
  });

  test('CRITICAL: disconnected + previously acked → deleted (not dead-lettered)', () => {
    // This catches the regression where isFullyAcked used bus_subscriptions
    // (deleted on disconnect) instead of bus_agent_cursors (persistent).
    const id = insertMsg(tmp.db, { toAgent: 'agent-offline', createdAt: PAST });
    setAgentCursor(tmp.db, 'agent-offline', id); // agent acked before disconnecting
    // No bus_subscriptions row (agent is offline) — intentionally omitted

    const dlBefore = deadLetterCount(tmp.db); // shared DB may have prior dead letters
    const result = runRetentionCleanup(tmp.db, 30);

    expect(result.deleted).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(msgExists(tmp.db, id)).toBe(false);
    expect(deadLetterCount(tmp.db)).toBe(dlBefore); // no new dead letters added
  });

  test('forever → no-op, messages untouched', () => {
    const id = insertMsg(tmp.db, { toAgent: 'agent-forever', createdAt: PAST });

    const result = runRetentionCleanup(tmp.db, 'forever');

    expect(result).toEqual({ deleted: 0, deadLettered: 0 });
    expect(msgExists(tmp.db, id)).toBe(true);
  });
});

// ── topic message retention ───────────────────────────────────────────────────

describe('topic message retention', () => {
  let tmp: TmpDb;

  beforeAll(() => {
    tmp = createTmpDb();
    runMigrations(tmp.db);
  });

  afterAll(() => tmp.cleanup());

  test('all topic subscribers acked → deleted', () => {
    subscribeTopic(tmp.db, 'sub-a', 'news');
    subscribeTopic(tmp.db, 'sub-b', 'news');
    const id = insertMsg(tmp.db, { topic: 'news', createdAt: PAST });
    setAgentCursor(tmp.db, 'sub-a', id);
    setAgentCursor(tmp.db, 'sub-b', id);

    const result = runRetentionCleanup(tmp.db, 30);

    expect(result.deleted).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(msgExists(tmp.db, id)).toBe(false);
  });

  test('one topic subscriber behind → dead-lettered', () => {
    subscribeTopic(tmp.db, 'sub-c', 'alerts');
    subscribeTopic(tmp.db, 'sub-d', 'alerts');
    const id = insertMsg(tmp.db, { topic: 'alerts', createdAt: PAST });
    setAgentCursor(tmp.db, 'sub-c', id);
    // sub-d has no cursor row → has not acked

    const result = runRetentionCleanup(tmp.db, 30);

    expect(result.deleted).toBe(0);
    expect(result.deadLettered).toBe(1);
    expect(msgExists(tmp.db, id)).toBe(false);

    const dlRow = tmp.db
      .prepare('SELECT reason FROM bus_dead_letters WHERE message_id = ?')
      .get(id) as { reason: string } | undefined;
    expect(dlRow?.reason).toBe('retention_expired');
  });
});

// ── ack op propagates cursor to bus_agent_cursors ─────────────────────────────

describe('ack op cursor propagation', () => {
  let tmp: TmpDb;
  let broker: BrokerServer;
  let port: number;
  let token: string;

  beforeAll(async () => {
    tmp = createTmpDb();
    runMigrations(tmp.db);
    ({ plaintext: token } = mintToken(tmp.db, { agent_id: 'acker', scope: 'agent' }));
    broker = new BrokerServer(tmp.db); // no retention = 'forever', no timer
    await broker.start(0);
    port = broker.address()!.port;
  });

  afterAll(async () => {
    await broker.close();
    tmp.cleanup();
  });

  test('ack op through broker upserts bus_agent_cursors', async () => {
    // Connect + hello
    const ws = await connect(port);
    const welcomeP = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'acker', token, protocol_version: 1 }));
    const welcome = await welcomeP;
    expect(welcome.op).toBe('welcome');

    // Insert a message so there's something to ack
    const payload = Buffer.from('{}', 'utf8');
    const msgId = tmp.db
      .prepare(
        `INSERT INTO bus_messages
           (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at)
         VALUES ('sender', 'acker', NULL, 'direct', ?, NULL, NULL, ?)`,
      )
      .run(payload, Date.now()).lastInsertRowid as number;

    // Send ack
    ws.send(JSON.stringify({ op: 'ack', cursor: msgId }));
    await new Promise((r) => setTimeout(r, 50));

    // bus_agent_cursors should now have a row for 'acker'
    const row = tmp.db
      .prepare('SELECT last_acked_cursor FROM bus_agent_cursors WHERE agent_id = ?')
      .get('acker') as { last_acked_cursor: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.last_acked_cursor).toBe(msgId);

    ws.close();
    await waitForClose(ws);
    // Give the server-side close handler a tick to run
    await new Promise((r) => setTimeout(r, 50));

    // After disconnect, cursor should still be in bus_agent_cursors
    const rowAfter = tmp.db
      .prepare('SELECT last_acked_cursor FROM bus_agent_cursors WHERE agent_id = ?')
      .get('acker') as { last_acked_cursor: number } | undefined;
    expect(rowAfter).toBeDefined();
    expect(rowAfter!.last_acked_cursor).toBe(msgId);
    // bus_subscriptions row should be gone (deleted on close)
    const subRow = tmp.db
      .prepare('SELECT 1 FROM bus_subscriptions WHERE agent_id = ?')
      .get('acker');
    expect(subRow).toBeUndefined();
  });
});
