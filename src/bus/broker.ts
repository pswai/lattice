import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { DB } from './db.js';
import { hashToken } from './tokens.js';

const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

// ── Frame schemas ─────────────────────────────────────────────────────────────

const HelloSchema = z.object({
  op: z.literal('hello'),
  agent_id: z.string().min(1),
  token: z.string().min(1),
  protocol_version: z.number().int().positive(),
  last_acked_cursor: z.number().int().min(0).optional(),
  replay: z.boolean().optional(),
});

// .strict() rejects unknown fields so extra keys (including topic) fail validation
const SendSchema = z
  .object({
    op: z.literal('send'),
    to: z.string().min(1),
    type: z.enum(['direct', 'broadcast', 'event']),
    payload: z.unknown(),
    idempotency_key: z.string().optional(),
    correlation_id: z.string().optional(),
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
type CursorRow = { max_id: number | null };
type SubRow = { last_acked_cursor: number };
type HeadRow = { head: number };
type ConnIdRow = { connection_id: string };

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

export class BrokerServer {
  private readonly db: DB;
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;

  // In-memory connection registries — populated on hello, cleaned up on close
  private readonly connectionsById = new Map<string, WebSocket>();
  private readonly connectionsByAgent = new Map<string, Set<string>>();

  constructor(db: DB) {
    this.db = db;
    this.httpServer = createServer();
    // TLS is operator-terminated via reverse proxy; the broker serves plain HTTP/WS.
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 1_048_576, // 1 MB hard cap per RFC 0002 §Delivery semantics
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

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
        // Remove subscription row; safe even if row was never inserted
        this.db
          .prepare('DELETE FROM bus_subscriptions WHERE connection_id = ?')
          .run(connectionId);
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

    // Add to in-memory registries
    this.connectionsById.set(connectionId, ws);
    if (!this.connectionsByAgent.has(hello.agent_id)) {
      this.connectionsByAgent.set(hello.agent_id, new Set());
    }
    this.connectionsByAgent.get(hello.agent_id)!.add(connectionId);

    // Current cursor (used by replay in step 7)
    const cursorRow = this.db
      .prepare('SELECT MAX(id) AS max_id FROM bus_messages')
      .get() as CursorRow;
    const currentCursor = cursorRow.max_id ?? 0;

    // Welcome — replay handling deferred to step 7
    sendFrame(ws, {
      op: 'welcome',
      agent_id: hello.agent_id,
      current_cursor: currentCursor,
      replaying: false, // replay: step 7
      protocol_version: 1,
    });

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
      // topic sends deferred to step 5; check before full validation for a specific error
      if ('topic' in (parsed as Record<string, unknown>)) {
        errorAndClose(
          ws,
          'malformed_frame',
          "topic sends not yet implemented; use 'to' for direct sends",
        );
        return;
      }
      const result = SendSchema.safeParse(parsed);
      if (!result.success) {
        errorAndClose(ws, 'malformed_frame', 'frame failed validation');
        return;
      }
      this.handleSend(result.data, agentId);
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

  private handleSend(frame: z.infer<typeof SendSchema>, fromAgent: string): void {
    // Frame size capped at 1 MB by ws maxPayload (decoder-level).
    // message_too_large error code is reserved for protocol completeness but never
    // emitted here — the ws library closes the socket with 1009 before this handler
    // is reached for oversized frames.

    const now = Date.now();
    // payload stored as Buffer in STRICT BLOB column (better-sqlite3 maps JS string
    // to TEXT; BLOB requires Buffer)
    const payloadBuf = Buffer.from(JSON.stringify(frame.payload), 'utf8');

    const insertResult = this.db
      .prepare(
        `INSERT INTO bus_messages
           (from_agent, to_agent, type, payload, idempotency_key, correlation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

    const cursor = Number(insertResult.lastInsertRowid);

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
          // payload is decoded from storage to round-trip correctly
          payload: frame.payload,
          idempotency_key: frame.idempotency_key ?? null,
          correlation_id: frame.correlation_id ?? null,
          created_at: now,
        });
      } catch {
        // Socket closed mid-fanout; log and continue to remaining recipients
        process.stderr.write(
          `warn: fanout to connection ${connection_id} failed (socket closed mid-send)\n`,
        );
      }
    }
  }

  private handleAck(connectionId: string, ackCursor: number): void {
    const subRow = this.db
      .prepare('SELECT last_acked_cursor FROM bus_subscriptions WHERE connection_id = ?')
      .get(connectionId) as SubRow | undefined;
    if (!subRow) return;

    const current = subRow.last_acked_cursor;

    // Monotonic guard: acks must advance the cursor
    if (ackCursor <= current) {
      process.stderr.write(
        `warn: ack cursor ${ackCursor} ≤ last_acked ${current} for ${connectionId}; ignored\n`,
      );
      return;
    }

    // Past-head guard: ack cannot skip messages that don't exist yet
    // (RFC 0002 §Failure modes: "Client acks cursor > current → Broker ignores; logs warning")
    const headRow = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) AS head FROM bus_messages')
      .get() as HeadRow;
    if (ackCursor > headRow.head) {
      process.stderr.write(
        `warn: ack cursor ${ackCursor} > head ${headRow.head} for ${connectionId}; ignored\n`,
      );
      return;
    }

    this.db
      .prepare(
        'UPDATE bus_subscriptions SET last_acked_cursor = ?, last_seen_at = ? WHERE connection_id = ?',
      )
      .run(ackCursor, Date.now(), connectionId);
  }

  start(port = 8787, host = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
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
