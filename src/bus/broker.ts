import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { DB } from './db.js';
import { hashToken } from './tokens.js';
import { runRetentionCleanup, type RetentionDays } from './retention.js';
import { log } from './logger.js';
import { Metrics } from './metrics.js';

const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

const MAX_REPLAY_COUNT = 1000;
const MAX_REPLAY_SPAN_MS = 5 * 60 * 1000;

// ── Frame schemas ─────────────────────────────────────────────────────────────

const HelloSchema = z.object({
  op: z.literal('hello'),
  agent_id: z.string().min(1),
  token: z.string().min(1),
  protocol_version: z.number().int().positive(),
  last_acked_cursor: z.number().int().min(0).optional(),
  replay: z.boolean().optional(),
});

// Two strict variants: one for direct sends (requires `to`), one for topic sends (requires `topic`).
// .strict() on each branch rejects unknown fields and forces Zod to try the other branch.
const DirectSendSchema = z
  .object({
    op: z.literal('send'),
    to: z.string().min(1),
    type: z.enum(['direct', 'broadcast', 'event']),
    payload: z.unknown(),
    idempotency_key: z.string().optional(),
    correlation_id: z.string().optional(),
  })
  .strict();

const TopicSendSchema = z
  .object({
    op: z.literal('send'),
    topic: z.string().min(1),
    type: z.enum(['direct', 'broadcast', 'event']),
    payload: z.unknown(),
    idempotency_key: z.string().optional(),
    correlation_id: z.string().optional(),
  })
  .strict();

const SendSchema = z.union([DirectSendSchema, TopicSendSchema]);

const SubscribeSchema = z
  .object({
    op: z.literal('subscribe'),
    topics: z.array(z.string().min(1)).min(1),
  })
  .strict();

const AckSchema = z
  .object({
    op: z.literal('ack'),
    cursor: z.number().int().min(0),
  })
  .strict();

// ── DB row types ──────────────────────────────────────────────────────────────

type TokenRow = { agent_id: string; revoked_at: number | null };
type SubRow = { agent_id: string; last_acked_cursor: number };
type HeadRow = { head: number };
type ConnIdRow = { connection_id: string };
type TopicAgentRow = { agent_id: string };
type MsgRow = {
  id: number;
  from_agent: string;
  to_agent: string | null;
  topic: string | null;
  type: string;
  payload: Buffer;
  idempotency_key: string | null;
  correlation_id: string | null;
  created_at: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function sendFrame(ws: WebSocket, frame: object): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Socket closed mid-send; close handler will clean up
  }
}

function errorAndClose(ws: WebSocket, code: string, message: string): void {
  sendFrame(ws, { op: 'error', code, message });
  ws.close();
}

// ── BrokerServer ──────────────────────────────────────────────────────────────

export type BrokerConfig = {
  /** Days to retain messages. 'forever' disables the cleanup job entirely. Default: 'forever'. */
  retentionDays?: RetentionDays;
  /** Override the cleanup interval in ms. Default: 86_400_000 (24 h). Primarily for tests. */
  cleanupIntervalMs?: number;
  /** Maximum unacked direct messages per recipient before sends are rejected. Default: 10000. */
  inboxLimit?: number;
};

/**
 * Parse the --inbox-limit / LATTICE_INBOX_LIMIT value.
 *  - undefined → default 10000
 *  - positive integer string → number
 *  - anything else → throws
 */
export function parseInboxLimit(raw: string | undefined): number {
  if (raw === undefined) return 10_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isNaN(n) && n > 0 && String(n) === raw.trim()) return n;
  throw new Error(
    `invalid --inbox-limit value: '${raw}' (expected positive integer)`,
  );
}

export class BrokerServer {
  private readonly db: DB;
  private readonly dbPath: string;
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;
  private readonly retentionDays: RetentionDays;
  private readonly cleanupIntervalMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly metrics: Metrics;
  private readonly inboxLimit: number;

  // Readiness flag: false until start() resolves, false again when close() is called.
  private ready = false;

  // In-memory connection registries — populated on hello, cleaned up on close
  private readonly connectionsById = new Map<string, WebSocket>();
  private readonly connectionsByAgent = new Map<string, Set<string>>();

  constructor(db: DB, dbPath: string, config: BrokerConfig = {}) {
    this.db = db;
    this.dbPath = dbPath;
    this.retentionDays = config.retentionDays ?? 'forever';
    this.cleanupIntervalMs = config.cleanupIntervalMs ?? 86_400_000;
    this.inboxLimit = config.inboxLimit ?? 10_000;
    this.metrics = new Metrics(dbPath);
    this.httpServer = createServer();
    // TLS is operator-terminated via reverse proxy; the broker serves plain HTTP/WS.
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 1_048_576, // 1 MB hard cap per RFC 0002 §Delivery semantics
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));

    // HTTP handler for observability endpoints (ws uses 'upgrade' not 'request',
    // so these coexist on the same port without conflict).
    this.httpServer.on('request', (req, res) => this.handleRequest(req, res));
  }

  // ── HTTP observability endpoints ───────────────────────────────────────────

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (url === '/healthz') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      try {
        this.db.prepare('SELECT 1 AS ok').get();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        log('error', 'healthz_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', reason: 'db_unreachable' }));
      }
    } else if (url === '/readyz') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      if (this.ready) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready' }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_ready' }));
      }
    } else if (url === '/bus_stats') {
      if (method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      const stats = {
        connections_active: this.connectionsById.size,
        agents_active: this.connectionsByAgent.size,
        ...this.metrics.snapshot(this.db),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  }

  // ── WebSocket connection handling ──────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let connectionId: string | null = null;
    let agentId: string | null = null;

    ws.on('error', () => {
      // Suppress socket-level errors; close handler performs cleanup
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // Reject binary frames — Lattice is JSON text only
      if (isBinary) {
        errorAndClose(ws, 'malformed_frame', 'binary frames are not supported');
        return;
      }

      // JSON parse — separate try/catch from schema validation
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawToString(data));
      } catch {
        errorAndClose(ws, 'malformed_frame', 'invalid JSON');
        return;
      }

      if (connectionId === null) {
        // Pre-hello: only hello frames accepted
        const ids = this.handleHello(ws, parsed);
        if (ids) {
          connectionId = ids.connectionId;
          agentId = ids.agentId;
        }
      } else {
        // Post-hello: send / ack ops
        this.handlePostHello(ws, parsed, connectionId, agentId!);
      }
    });

    ws.on('close', () => {
      if (connectionId !== null) {
        // Remove from both in-memory registries atomically
        this.connectionsById.delete(connectionId);
        const agentConns = this.connectionsByAgent.get(agentId!);
        if (agentConns) {
          agentConns.delete(connectionId);
          if (agentConns.size === 0) this.connectionsByAgent.delete(agentId!);
        }
        // Safety-net: propagate this connection's last acked cursor to bus_agent_cursors
        // before deleting the subscription row.  This ensures the retention cleanup
        // can see the cursor even when the agent is offline.  The ack-time upsert
        // already handles the common path; this covers the lagging-connection case.
        this.db
          .prepare(
            `INSERT INTO bus_agent_cursors (agent_id, last_acked_cursor, updated_at)
             SELECT agent_id, last_acked_cursor, ?
             FROM bus_subscriptions WHERE connection_id = ?
             ON CONFLICT(agent_id) DO UPDATE
               SET last_acked_cursor = MAX(bus_agent_cursors.last_acked_cursor, excluded.last_acked_cursor),
                   updated_at        = excluded.updated_at`,
          )
          .run(Date.now(), connectionId);
        // Remove subscription row; safe even if row was never inserted
        this.db
          .prepare('DELETE FROM bus_subscriptions WHERE connection_id = ?')
          .run(connectionId);
        log('info', 'close', { agent_id: agentId, connection_id: connectionId });
      }
    });
  }

  // Returns connection/agent IDs on success, null on failure (error already sent)
  private handleHello(
    ws: WebSocket,
    parsed: unknown,
  ): { connectionId: string; agentId: string } | null {
    const result = HelloSchema.safeParse(parsed);
    if (!result.success) {
      errorAndClose(ws, 'malformed_frame', 'frame failed validation');
      return null;
    }

    const hello = result.data;

    // Protocol version check
    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(hello.protocol_version)) {
      errorAndClose(
        ws,
        'unsupported_protocol_version',
        `protocol version ${hello.protocol_version} not supported`,
      );
      return null;
    }

    // Token lookup and verification
    const tokenRow = this.db
      .prepare('SELECT agent_id, revoked_at FROM bus_tokens WHERE token_hash = ?')
      .get(hashToken(hello.token)) as TokenRow | undefined;

    if (!tokenRow) {
      errorAndClose(ws, 'unauthorized', 'bearer token invalid or revoked');
      return null;
    }

    if (tokenRow.revoked_at !== null) {
      errorAndClose(ws, 'token_revoked', 'token has been revoked');
      return null;
    }

    // Agent identity check — token's agent_id must match hello.agent_id
    if (tokenRow.agent_id !== hello.agent_id) {
      errorAndClose(ws, 'unauthorized', 'bearer token invalid or revoked');
      return null;
    }

    // Register subscription row
    const connectionId = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO bus_subscriptions
           (agent_id, connection_id, last_acked_cursor, connected_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hello.agent_id, connectionId, hello.last_acked_cursor ?? 0, now, now);

    // Snapshot current cursor once. Any messages with id > currentCursor will be
    // delivered via live fanout after the replay window is closed.
    const cursorRow = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM bus_messages')
      .get() as { max_id: number };
    const currentCursor = cursorRow.max_id;

    const willReplay = hello.replay === true;

    sendFrame(ws, {
      op: 'welcome',
      agent_id: hello.agent_id,
      current_cursor: currentCursor,
      replaying: willReplay,
      protocol_version: 1,
    });

    log('info', 'welcome', { agent_id: hello.agent_id, connection_id: connectionId });

    // Replay MUST run before adding this connection to the in-memory registries.
    // Node.js is single-threaded and better-sqlite3 is synchronous, so no
    // concurrent fanout can interleave with the replay loop. A live send arriving
    // while replay is in flight will find the registry empty for this connection
    // and skip it — the message was already captured by id <= currentCursor
    // (if id ≤ currentCursor) or will be delivered live after registry insertion
    // (if id > currentCursor). Both cases preserve FIFO with no duplication.
    if (willReplay) {
      this.handleReplay(ws, hello.agent_id, hello.last_acked_cursor ?? 0, currentCursor, connectionId);
    }

    // Add to in-memory registries after replay — live fanout starts from here
    this.connectionsById.set(connectionId, ws);
    if (!this.connectionsByAgent.has(hello.agent_id)) {
      this.connectionsByAgent.set(hello.agent_id, new Set());
    }
    this.connectionsByAgent.get(hello.agent_id)!.add(connectionId);

    return { connectionId, agentId: hello.agent_id };
  }

  private handlePostHello(
    ws: WebSocket,
    parsed: unknown,
    connectionId: string,
    agentId: string,
  ): void {
    // Bump liveness timestamp on every received op
    this.db
      .prepare('UPDATE bus_subscriptions SET last_seen_at = ? WHERE connection_id = ?')
      .run(Date.now(), connectionId);

    if (typeof parsed !== 'object' || parsed === null || !('op' in parsed)) {
      errorAndClose(ws, 'malformed_frame', 'frame missing op field');
      return;
    }

    const op = (parsed as Record<string, unknown>).op;

    if (op === 'send') {
      const result = SendSchema.safeParse(parsed);
      if (!result.success) {
        errorAndClose(ws, 'malformed_frame', 'frame failed validation');
        return;
      }
      this.handleSend(ws, result.data, agentId);
    } else if (op === 'subscribe') {
      const result = SubscribeSchema.safeParse(parsed);
      if (!result.success) {
        errorAndClose(ws, 'malformed_frame', 'frame failed validation');
        return;
      }
      this.handleSubscribe(result.data.topics, agentId);
    } else if (op === 'ack') {
      const result = AckSchema.safeParse(parsed);
      if (!result.success) {
        errorAndClose(ws, 'malformed_frame', 'frame failed validation');
        return;
      }
      this.handleAck(connectionId, result.data.cursor);
    } else {
      errorAndClose(ws, 'malformed_frame', 'unknown op');
    }
  }

  private handleSend(ws: WebSocket, frame: z.infer<typeof SendSchema>, fromAgent: string): void {
    // Frame size capped at 1 MB by ws maxPayload (decoder-level).
    // message_too_large error code is reserved for protocol completeness but never
    // emitted here — the ws library closes the socket with 1009 before this handler
    // is reached for oversized frames.

    const now = Date.now();
    // payload stored as Buffer in STRICT BLOB column (better-sqlite3 maps JS string
    // to TEXT; BLOB requires Buffer)
    const payloadBuf = Buffer.from(JSON.stringify(frame.payload), 'utf8');

    if ('to' in frame) {
      // Inbox-full back-pressure applies to DIRECT sends only. Topic broadcasts are
      // always accepted — blocking a fan-out for one slow subscriber would freeze the
      // topic for every other subscriber. Slow topic subscribers get a `gap` op on
      // replay instead (see handleReplay).
      //
      // The depth check and INSERT run inside one transaction. better-sqlite3 is
      // synchronous and SQLite is single-writer, so no concurrent write can slip
      // between the check and the insert. The transaction guards against future
      // async changes being added to this path.
      let inboxFull = false;
      let inboxDepth = 0;
      let cursor = 0;

      this.db.transaction(() => {
        // Use bus_agent_cursors (not bus_subscriptions) — step 8 guarantees
        // bus_agent_cursors.last_acked_cursor ≥ max of all active connection
        // cursors. Using bus_subscriptions as a fallback would mask bugs in that
        // invariant; querying bus_agent_cursors alone is the correct choice.
        const depthRow = this.db
          .prepare(
            `SELECT COUNT(*) AS depth
             FROM bus_messages
             WHERE to_agent = ?
               AND id > COALESCE(
                 (SELECT last_acked_cursor FROM bus_agent_cursors WHERE agent_id = ?),
                 0
               )`,
          )
          .get(frame.to, frame.to) as { depth: number };

        if (depthRow.depth >= this.inboxLimit) {
          inboxFull = true;
          inboxDepth = depthRow.depth;
          return; // nothing written — transaction commits as a no-op
        }

        const insertResult = this.db
          .prepare(
            `INSERT INTO bus_messages
               (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            fromAgent,
            frame.to,
            frame.type,
            payloadBuf,
            frame.idempotency_key ?? null,
            frame.correlation_id ?? null,
            now,
          );
        cursor = Number(insertResult.lastInsertRowid);
      })();

      if (inboxFull) {
        // inbox_full does NOT close the connection — the sender can retry after backoff.
        // Contrast: unauthorized / malformed_frame / token_revoked all close the connection.
        // Closing here would force a re-hello + token re-auth on every burst, which is
        // exactly the wrong behavior for a transient back-pressure signal.
        sendFrame(ws, {
          op: 'error',
          code: 'inbox_full',
          message: 'recipient inbox at limit',
          agent_id: frame.to, // RECIPIENT (not sender) per RFC 0002 §Observability
          current_depth: inboxDepth,
          limit: this.inboxLimit,
        });
        this.metrics.recordInboxFull();
        log('warn', 'inbox_full', {
          sender: fromAgent,
          recipient: frame.to,
          current_depth: inboxDepth,
          limit: this.inboxLimit,
        });
        return;
      }

      this.metrics.recordMessage();
      log('info', 'send', { from: fromAgent, to: frame.to, topic: null, cursor });

      // Fan out to all active connections for the recipient
      // Offline recipient: no rows in connectionsById; message waits for step 7 replay
      const connRows = this.db
        .prepare('SELECT connection_id FROM bus_subscriptions WHERE agent_id = ?')
        .all(frame.to) as ConnIdRow[];

      for (const { connection_id } of connRows) {
        const recipientWs = this.connectionsById.get(connection_id);
        if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) continue;
        try {
          sendFrame(recipientWs, {
            op: 'message',
            cursor,
            from: fromAgent,
            type: frame.type,
            topic: null,
            // payload is decoded from storage to round-trip correctly
            payload: frame.payload,
            idempotency_key: frame.idempotency_key ?? null,
            correlation_id: frame.correlation_id ?? null,
            created_at: now,
          });
        } catch {
          // Socket closed mid-fanout; log and continue to remaining recipients
          log('warn', 'fanout_failed', { connection_id, reason: 'socket closed mid-send' });
        }
      }
    } else {
      // Topic send: to_agent NULL, topic name set
      const insertResult = this.db
        .prepare(
          `INSERT INTO bus_messages
             (from_agent, to_agent, topic, type, payload, idempotency_key, correlation_id, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fromAgent,
          frame.topic,
          frame.type,
          payloadBuf,
          frame.idempotency_key ?? null,
          frame.correlation_id ?? null,
          now,
        );

      const cursor = Number(insertResult.lastInsertRowid);
      this.metrics.recordMessage();
      log('info', 'send', { from: fromAgent, to: null, topic: frame.topic, cursor });

      // Resolve all agents subscribed to this topic, then fan out to their active connections.
      // No self-suppression: if the sender is subscribed, they receive too.
      const subscribedAgents = this.db
        .prepare('SELECT DISTINCT agent_id FROM bus_topics WHERE topic = ?')
        .all(frame.topic) as TopicAgentRow[];

      for (const { agent_id } of subscribedAgents) {
        const connIds = this.connectionsByAgent.get(agent_id);
        if (!connIds) continue;
        for (const connId of connIds) {
          const recipientWs = this.connectionsById.get(connId);
          if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) continue;
          try {
            sendFrame(recipientWs, {
              op: 'message',
              cursor,
              from: fromAgent,
              type: frame.type,
              topic: frame.topic,
              payload: frame.payload,
              idempotency_key: frame.idempotency_key ?? null,
              correlation_id: frame.correlation_id ?? null,
              created_at: now,
            });
          } catch {
            log('warn', 'fanout_failed', { connection_id: connId, reason: 'socket closed mid-send' });
          }
        }
      }
    }
  }

  // Fire-and-forget: persist agent→topic rows so subscriptions survive reconnects.
  // No ack or response frame sent back — subscribe is write-only at the wire level.
  private handleSubscribe(topics: string[], agentId: string): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO bus_topics (agent_id, topic) VALUES (?, ?)',
    );
    for (const topic of topics) {
      insert.run(agentId, topic);
    }
  }

  // Replay missed messages for a reconnecting agent.
  // Delivers messages in cursor order up to a cap (1000 messages OR 5 min span),
  // then emits a `gap` op if the window was truncated.
  // Called synchronously from handleHello BEFORE registry insertion — see inline
  // comment in handleHello for the FIFO-safety argument.
  private handleReplay(
    ws: WebSocket,
    agentId: string,
    fromCursor: number,
    currentCursor: number,
    connectionId: string,
  ): void {
    try {
      const iter = this.db
        .prepare(
          `SELECT id, from_agent, to_agent, topic, type, payload,
                  idempotency_key, correlation_id, created_at
           FROM bus_messages
           WHERE id > ? AND id <= ?
             AND (to_agent = ?
                  OR (topic IS NOT NULL
                      AND topic IN (SELECT topic FROM bus_topics WHERE agent_id = ?)))
           ORDER BY id ASC`,
        )
        .iterate(fromCursor, currentCursor, agentId, agentId) as IterableIterator<MsgRow>;

      let count = 0;
      let firstCreatedAt: number | null = null;
      let capped = false;

      for (const row of iter) {
        // Time cap: check BEFORE sending — if this row's timestamp would exceed the 5-min
        // window, stop here so the overflow row is not delivered.
        if (firstCreatedAt !== null && row.created_at - firstCreatedAt > MAX_REPLAY_SPAN_MS) {
          capped = true;
          break; // iterator.return() called by for...of on break — cursor closed cleanly
        }

        sendFrame(ws, {
          op: 'message',
          cursor: row.id,
          from: row.from_agent,
          type: row.type,
          topic: row.topic ?? null,
          payload: JSON.parse((row.payload as Buffer).toString('utf8')),
          idempotency_key: row.idempotency_key ?? null,
          correlation_id: row.correlation_id ?? null,
          created_at: row.created_at,
        });

        if (firstCreatedAt === null) firstCreatedAt = row.created_at;
        count += 1;

        // Count cap: fires AFTER sending row N so exactly MAX_REPLAY_COUNT frames are delivered.
        if (count >= MAX_REPLAY_COUNT) {
          capped = true;
          break;
        }
      }

      if (capped) {
        sendFrame(ws, { op: 'gap', from: fromCursor, to: currentCursor, reason: 'replay_cap' });
        this.metrics.recordGap();
        log('info', 'replay_gap', {
          agent_id: agentId,
          connection_id: connectionId,
          from: fromCursor,
          to: currentCursor,
        });
      }
    } catch (err) {
      log('error', 'replay_failed', {
        agent_id: agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendFrame(ws, { op: 'error', code: 'internal_error', message: 'replay failed' });
      ws.close();
    }
  }

  private handleAck(connectionId: string, ackCursor: number): void {
    const subRow = this.db
      .prepare('SELECT agent_id, last_acked_cursor FROM bus_subscriptions WHERE connection_id = ?')
      .get(connectionId) as SubRow | undefined;
    if (!subRow) return;

    const current = subRow.last_acked_cursor;

    // Monotonic guard: acks must advance the cursor
    if (ackCursor <= current) {
      log('warn', 'ack_stale', {
        connection_id: connectionId,
        ack_cursor: ackCursor,
        last_acked: current,
      });
      return;
    }

    // Past-head guard: ack cannot skip messages that don't exist yet
    // (RFC 0002 §Failure modes: "Client acks cursor > current → Broker ignores; logs warning")
    const headRow = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) AS head FROM bus_messages')
      .get() as HeadRow;
    if (ackCursor > headRow.head) {
      log('warn', 'ack_ahead_of_head', {
        connection_id: connectionId,
        ack_cursor: ackCursor,
        head: headRow.head,
      });
      return;
    }

    const now = Date.now();

    this.db
      .prepare(
        'UPDATE bus_subscriptions SET last_acked_cursor = ?, last_seen_at = ? WHERE connection_id = ?',
      )
      .run(ackCursor, now, connectionId);

    // Persist the cursor to bus_agent_cursors so the retention cleanup can determine
    // fully-acked state even after this connection closes (bus_subscriptions rows are
    // deleted on close).  MAX guard makes the upsert monotonic across connections.
    this.db
      .prepare(
        `INSERT INTO bus_agent_cursors (agent_id, last_acked_cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE
           SET last_acked_cursor = MAX(bus_agent_cursors.last_acked_cursor, excluded.last_acked_cursor),
               updated_at        = excluded.updated_at`,
      )
      .run(subRow.agent_id, ackCursor, now);

    log('info', 'ack', { agent_id: subRow.agent_id, cursor: ackCursor });
  }

  start(port = 8787, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off('error', reject);

        this.ready = true;

        // Wire retention cleanup. 'forever' → no timer at all (simpler than schedule-but-no-op;
        // MVP has no live config reload so the safety argument doesn't apply).
        if (this.retentionDays !== 'forever') {
          runRetentionCleanup(this.db, this.retentionDays); // immediate first run on start
          this.cleanupTimer = setInterval(
            () => runRetentionCleanup(this.db, this.retentionDays as number),
            this.cleanupIntervalMs,
          );
          this.cleanupTimer.unref(); // never prevent process exit
        }

        // Metrics tick: advances EWMA every 5 s.
        this.metricsTimer = setInterval(() => this.metrics.tick(), 5_000);
        this.metricsTimer.unref();

        const addr = this.httpServer.address() as { address: string; port: number };
        log('info', 'broker_start', { host: addr.address, port: addr.port });

        resolve();
      });
    });
  }

  close(): Promise<void> {
    this.ready = false;
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    log('info', 'broker_stop', {});
    return new Promise((resolve, reject) => {
      // Terminate all active connections so httpServer.close() can drain
      for (const client of this.wss.clients) {
        client.terminate();
      }
      this.wss.close((wsErr) => {
        if (wsErr) { reject(wsErr); return; }
        this.httpServer.close((httpErr) => {
          if (httpErr) reject(httpErr);
          else resolve();
        });
      });
    });
  }

  address(): { port: number; host: string } | null {
    const addr = this.httpServer.address();
    if (!addr || typeof addr === 'string') return null;
    return { port: addr.port, host: addr.address };
  }
}
