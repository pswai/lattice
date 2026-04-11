import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { DB } from './db.js';
import { hashToken } from './tokens.js';

const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

const HelloSchema = z.object({
  op: z.literal('hello'),
  agent_id: z.string().min(1),
  token: z.string().min(1),
  protocol_version: z.number().int().positive(),
  last_acked_cursor: z.number().int().min(0).optional(),
  replay: z.boolean().optional(),
});

type TokenRow = { agent_id: string; revoked_at: number | null };
type CursorRow = { max_id: number | null };

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function sendFrame(ws: WebSocket, frame: object): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function errorAndClose(ws: WebSocket, code: string, message: string): void {
  sendFrame(ws, { op: 'error', code, message });
  ws.close();
}

export class BrokerServer {
  private readonly db: DB;
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;

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

    ws.on('error', () => {
      // Suppress socket-level errors; the close handler performs cleanup
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // Step 3 only handles hello; further ops (send/ack/subscribe) added in later steps
      if (connectionId !== null) return;

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

      // Schema validation
      const result = HelloSchema.safeParse(parsed);
      if (!result.success) {
        errorAndClose(ws, 'malformed_frame', 'frame failed validation');
        return;
      }

      const hello = result.data;

      // Protocol version check
      if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(hello.protocol_version)) {
        errorAndClose(
          ws,
          'unsupported_protocol_version',
          `protocol version ${hello.protocol_version} not supported`,
        );
        return;
      }

      // Token lookup and verification
      const tokenRow = this.db
        .prepare('SELECT agent_id, revoked_at FROM bus_tokens WHERE token_hash = ?')
        .get(hashToken(hello.token)) as TokenRow | undefined;

      if (!tokenRow) {
        errorAndClose(ws, 'unauthorized', 'bearer token invalid or revoked');
        return;
      }

      if (tokenRow.revoked_at !== null) {
        errorAndClose(ws, 'token_revoked', 'token has been revoked');
        return;
      }

      // Agent identity check — token's agent_id must match hello.agent_id
      if (tokenRow.agent_id !== hello.agent_id) {
        errorAndClose(ws, 'unauthorized', 'bearer token invalid or revoked');
        return;
      }

      // Register subscription
      connectionId = randomUUID();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO bus_subscriptions
             (agent_id, connection_id, last_acked_cursor, connected_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(hello.agent_id, connectionId, hello.last_acked_cursor ?? 0, now, now);

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
    });

    ws.on('close', () => {
      // No-op if hello never completed; DELETE on missing row is safe
      if (connectionId !== null) {
        this.db
          .prepare('DELETE FROM bus_subscriptions WHERE connection_id = ?')
          .run(connectionId);
      }
    });
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
