import http from 'node:http';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { BrokerServer } from '../../src/bus/broker.js';
import { log } from '../../src/bus/logger.js';
import { runMigrations } from '../../src/bus/migrations.js';
import { mintToken } from '../../src/bus/tokens.js';
import { createTmpDb, type TmpDb } from '../fixtures/tmp-db.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

function httpPost(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function wsConnect(port: number): Promise<WebSocket> {
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

// ── suite ─────────────────────────────────────────────────────────────────────

describe('observability endpoints', () => {
  let tmp: TmpDb;
  let broker: BrokerServer;
  let port: number;
  let baseUrl: string;
  let agentToken: string;

  beforeAll(async () => {
    tmp = createTmpDb();
    runMigrations(tmp.db);
    ({ plaintext: agentToken } = mintToken(tmp.db, { agent_id: 'obs-agent', scope: 'agent' }));
    broker = new BrokerServer(tmp.db, tmp.path);
    await broker.start(0);
    port = broker.address()!.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await broker.close();
    tmp.cleanup();
  });

  // 1 ── /healthz happy path ─────────────────────────────────────────────────

  test('GET /healthz with live DB → 200 {status:"ok"}', async () => {
    const { status, body, headers } = await httpGet(`${baseUrl}/healthz`);
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('application/json');
    const parsed = JSON.parse(body) as { status: string };
    expect(parsed.status).toBe('ok');
  });

  // 2 ── /healthz 503 on closed DB ───────────────────────────────────────────

  test('GET /healthz with closed DB → 503 {status:"error"}', async () => {
    // Close the DB so SELECT 1 throws, then immediately reopen with the same path
    // so broker teardown still works.
    tmp.db.close();
    const { status, body } = await httpGet(`${baseUrl}/healthz`);
    // Reopen before asserting so afterAll cleanup can proceed even if the test fails.
    const { openDatabase } = await import('../../src/bus/db.js');
    // Reassign db handle on both tmp and broker (private field access for test only)
    const reopened = openDatabase(tmp.path);
    (tmp as unknown as Record<string, unknown>).db = reopened;
    (broker as unknown as Record<string, unknown>).db = reopened;

    expect(status).toBe(503);
    const parsed = JSON.parse(body) as { status: string; reason: string };
    expect(parsed.status).toBe('error');
    expect(parsed.reason).toBe('db_unreachable');
  });

  // 3 ── /readyz 200 when running ────────────────────────────────────────────

  test('GET /readyz after start → 200 {status:"ready"}', async () => {
    const { status, body } = await httpGet(`${baseUrl}/readyz`);
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as { status: string };
    expect(parsed.status).toBe('ready');
  });

  // 4 ── /readyz 503 when not ready ─────────────────────────────────────────

  test('GET /readyz when ready=false → 503 {status:"not_ready"}', async () => {
    // Temporarily flip the ready flag (test-only introspection)
    (broker as unknown as Record<string, unknown>).ready = false;
    const { status, body } = await httpGet(`${baseUrl}/readyz`);
    (broker as unknown as Record<string, unknown>).ready = true;

    expect(status).toBe(503);
    const parsed = JSON.parse(body) as { status: string };
    expect(parsed.status).toBe('not_ready');
  });

  // 5 ── /bus_stats shape ───────────────────────────────────────────────────

  test('GET /bus_stats → 200 with all 9 required numeric fields', async () => {
    const { status, body } = await httpGet(`${baseUrl}/bus_stats`);
    expect(status).toBe(200);
    const stats = JSON.parse(body) as Record<string, unknown>;

    const numericFields = [
      'connections_active',
      'agents_active',
      'messages_total',
      'messages_per_sec',
      'replay_gaps_total',
      'inbox_full_total',
      'dead_letters_total',
      'db_size_bytes',
      'db_growth_rate_bytes_per_day',
    ] as const;
    for (const field of numericFields) {
      expect(stats, `expected field ${field}`).toHaveProperty(field);
      expect(typeof stats[field], `${field} should be number`).toBe('number');
    }
  });

  // 6 ── connections_active and messages_total ───────────────────────────────

  test('connections_active and messages_total reflect live state', async () => {
    // Baseline stats before connecting
    const before = JSON.parse((await httpGet(`${baseUrl}/bus_stats`)).body) as Record<string, number>;

    // Connect a WS client and send a message
    const ws = await wsConnect(port);
    const welcomeP = nextFrame(ws);
    ws.send(JSON.stringify({ op: 'hello', agent_id: 'obs-agent', token: agentToken, protocol_version: 1 }));
    const welcome = await welcomeP;
    expect(welcome.op).toBe('welcome');

    // Send a direct message (to self)
    ws.send(JSON.stringify({ op: 'send', to: 'obs-agent', type: 'direct', payload: { x: 1 } }));
    // Give broker a tick to persist and fan out
    await new Promise((r) => setTimeout(r, 50));

    const after = JSON.parse((await httpGet(`${baseUrl}/bus_stats`)).body) as Record<string, number>;

    expect(after.connections_active).toBeGreaterThan(before.connections_active);
    expect(after.messages_total).toBe(before.messages_total + 1);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  // 7 ── dead_letters_total increments after retention dead-letter ───────────

  test('dead_letters_total increments when a retention dead-letter is recorded', async () => {
    const { runRetentionCleanup } = await import('../../src/bus/retention.js');

    const before = JSON.parse((await httpGet(`${baseUrl}/bus_stats`)).body) as Record<string, number>;

    // Insert an expired unacked direct message (40 days old, no cursor row → unacked)
    const PAST = Date.now() - 40 * 86_400_000;
    const payload = Buffer.from('{}', 'utf8');
    tmp.db
      .prepare(
        `INSERT INTO bus_messages
           (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at)
         VALUES ('sender', 'nobody', NULL, 'direct', ?, NULL, NULL, ?)`,
      )
      .run(payload, PAST);

    runRetentionCleanup(tmp.db, 30);

    const after = JSON.parse((await httpGet(`${baseUrl}/bus_stats`)).body) as Record<string, number>;
    expect(after.dead_letters_total).toBe(before.dead_letters_total + 1);
  });

  // 8 ── unknown path → 404 ─────────────────────────────────────────────────

  test('GET /doesnotexist → 404', async () => {
    const { status, body } = await httpGet(`${baseUrl}/doesnotexist`);
    expect(status).toBe(404);
    const parsed = JSON.parse(body) as { error: string };
    expect(parsed.error).toBe('not_found');
  });

  // 9 ── POST /healthz → 405 ────────────────────────────────────────────────

  test('POST /healthz → 405 method not allowed', async () => {
    const { status } = await httpPost(`${baseUrl}/healthz`);
    expect(status).toBe(405);
  });

  // 10 ── log() emits valid JSON to stderr ───────────────────────────────────

  test('log() emits a valid JSON line to stderr with t/level/event fields', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });

    const before = Date.now();
    log('info', 'test_observability_event', { x: 42, tag: 'unit' });
    const after = Date.now();

    spy.mockRestore();

    // Filter to lines containing our test event (other handlers may also write)
    const matching = lines
      .flatMap((l) => l.split('\n').filter((s) => s.includes('test_observability_event')))
      .map((s) => JSON.parse(s) as Record<string, unknown>);

    expect(matching).toHaveLength(1);
    const entry = matching[0]!;
    expect(entry.level).toBe('info');
    expect(entry.event).toBe('test_observability_event');
    expect(typeof entry.t).toBe('number');
    expect(entry.t as number).toBeGreaterThanOrEqual(before);
    expect(entry.t as number).toBeLessThanOrEqual(after);
    expect(entry.x).toBe(42);
    expect(entry.tag).toBe('unit');
  });
});
