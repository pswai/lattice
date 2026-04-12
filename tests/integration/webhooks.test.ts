import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { createTmpDb, type TmpDb } from '../fixtures/tmp-db.js';
import { runMigrations } from '../../src/bus/migrations.js';
import { dispatchWebhook } from '../../src/bus/webhooks.js';

describe('webhook dispatcher', () => {
  let tmp: TmpDb;
  let httpServer: HttpServer;
  let serverPort: number;
  let receivedRequests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;
  let respondWith: { status: number };

  beforeEach(async () => {
    tmp = createTmpDb();
    runMigrations(tmp.db);
    receivedRequests = [];
    respondWith = { status: 200 };

    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        receivedRequests.push({ headers: req.headers, body });
        res.writeHead(respondWith.status).end();
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpServer.address();
    if (typeof addr === 'object' && addr) serverPort = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    tmp.cleanup();
  });

  function registerWebhook(agentId: string, secret: string) {
    tmp.db
      .prepare('INSERT INTO bus_webhooks (agent_id, url, secret, created_at) VALUES (?, ?, ?, ?)')
      .run(agentId, `http://127.0.0.1:${serverPort}/webhook`, secret, Date.now());
  }

  function insertMessage(id: number, fromAgent: string, toAgent: string, payload: unknown) {
    tmp.db
      .prepare(
        `INSERT INTO bus_messages (id, from_agent, to_agent, topic, type, payload, created_at)
         VALUES (?, ?, ?, NULL, 'direct', ?, ?)`,
      )
      .run(id, fromAgent, toAgent, Buffer.from(JSON.stringify(payload), 'utf8'), Date.now());
  }

  test('delivers to registered webhook with HMAC signature', async () => {
    const secret = 'test-secret-key';
    registerWebhook('agent-b', secret);
    insertMessage(1, 'agent-a', 'agent-b', { hello: 'world' });

    const result = await dispatchWebhook(
      tmp.db, 1, 'agent-b', { hello: 'world' }, 'agent-a', 'direct', null, null, Date.now(),
    );

    expect(result).toBe(true);
    expect(receivedRequests).toHaveLength(1);

    const req = receivedRequests[0]!;
    const body = JSON.parse(req.body);
    expect(body.from).toBe('agent-a');
    expect(body.to).toBe('agent-b');
    expect(body.payload).toEqual({ hello: 'world' });

    // Verify HMAC
    const expectedSig = createHmac('sha256', secret).update(req.body, 'utf8').digest('hex');
    expect(req.headers['x-lattice-signature']).toBe(`sha256=${expectedSig}`);
    expect(req.headers['x-lattice-message-id']).toBe('1');
  });

  test('returns false when no webhook registered for agent', async () => {
    insertMessage(1, 'agent-a', 'agent-b', { data: 1 });
    const result = await dispatchWebhook(
      tmp.db, 1, 'agent-b', { data: 1 }, 'agent-a', 'direct', null, null, Date.now(),
    );
    expect(result).toBe(false);
    expect(receivedRequests).toHaveLength(0);
  });

  test('retries on non-2xx response then dead-letters on exhaustion', async () => {
    const secret = 'retry-secret';
    registerWebhook('agent-b', secret);
    insertMessage(1, 'agent-a', 'agent-b', { important: true });
    respondWith = { status: 500 };

    const result = await dispatchWebhook(
      tmp.db, 1, 'agent-b', { important: true }, 'agent-a', 'direct', null, null, Date.now(),
      { maxRetries: 2, initialRetryMs: 50 },
    );

    expect(result).toBe(false);
    expect(receivedRequests.length).toBe(3); // initial + 2 retries

    // Check dead letter was created
    const dl = tmp.db
      .prepare('SELECT * FROM bus_dead_letters WHERE message_id = ?')
      .get(1) as any;
    expect(dl).toBeDefined();
    expect(dl.reason).toBe('permanent_failure');
  }, 10000);

  test('succeeds on second attempt after initial failure', async () => {
    const secret = 'retry-success-secret';
    registerWebhook('agent-b', secret);
    insertMessage(1, 'agent-a', 'agent-b', { will: 'retry' });

    let callCount = 0;
    httpServer.removeAllListeners('request');
    httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        callCount++;
        receivedRequests.push({ headers: req.headers, body });
        res.writeHead(callCount === 1 ? 500 : 200).end();
      });
    });

    const result = await dispatchWebhook(
      tmp.db, 1, 'agent-b', { will: 'retry' }, 'agent-a', 'direct', null, null, Date.now(),
      { maxRetries: 3, initialRetryMs: 50 },
    );

    expect(result).toBe(true);
    expect(callCount).toBe(2);

    // No dead letter
    const dl = tmp.db.prepare('SELECT COUNT(*) AS n FROM bus_dead_letters').get() as { n: number };
    expect(dl.n).toBe(0);
  }, 10000);

  test('includes correlation_id and topic in webhook body', async () => {
    registerWebhook('agent-b', 'secret');
    insertMessage(1, 'agent-a', 'agent-b', { data: 1 });

    await dispatchWebhook(
      tmp.db, 1, 'agent-b', { data: 1 }, 'agent-a', 'broadcast', 'ci-alerts', 'req-123', Date.now(),
    );

    const body = JSON.parse(receivedRequests[0]!.body);
    expect(body.correlation_id).toBe('req-123');
    expect(body.topic).toBe('ci-alerts');
    expect(body.type).toBe('broadcast');
  });
});
