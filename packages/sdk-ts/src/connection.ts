/**
 * Connection — manages a single WebSocket connection to the broker with
 * automatic reconnect (exponential backoff + full jitter) and pending-send buffering.
 *
 * Lifecycle:
 *   new Connection(...)   → idle
 *   await conn.start()    → connected (first handshake complete)
 *   conn.send(frame)      → queued if not connected, sent immediately if connected
 *   conn.ack(cursor)      → updates lastAckedCursor; sends ack frame if connected
 *   await conn.close()    → stops reconnect loop, terminates WS
 */

import WebSocket from 'ws';
import type { RawData } from 'ws';
import { reconnectDelayMs } from './backoff.js';
import type {
  HelloFrame,
  MessageFrame,
  GapFrame,
  InboundFrame,
  OutboundFrame,
} from './protocol.js';

const TERMINAL_CODES = new Set([
  'unauthorized',
  'token_revoked',
  'unsupported_protocol_version',
]);

// Pending-send queue cap. When disconnected and this many frames are buffered,
// the oldest frame is dropped and a warning is emitted before enqueueing the new one.
const PENDING_CAP = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

export type MessageHandler = (msg: MessageFrame) => void;
export type GapHandler = (gap: GapFrame) => void;

export class Connection {
  /** Cursor of the last acked message. Updated by ack(). */
  lastAckedCursor = 0;

  private ws: WebSocket | null = null;
  private _closed = false;
  private terminalCode: string | null = null;
  private reconnectAttempt = 0;

  // Frames buffered while the connection is down (JSON strings for efficiency)
  private pendingSends: string[] = [];

  // Topic subscriptions to re-send on every reconnect
  private subscribedTopics: string[] = [];

  readonly messageHandlers = new Set<MessageHandler>();
  readonly gapHandlers = new Set<GapHandler>();

  // Promise machinery for start() to block until first connection
  private firstConnectResolve: (() => void) | null = null;
  private firstConnectReject: ((err: Error) => void) | null = null;
  private firstConnected = false;

  private readonly reconnectDelayFn: (attempt: number) => number;

  constructor(
    readonly url: string,
    private readonly agentId: string,
    private readonly token: string,
    private readonly onError: (code: string, message: string) => void,
    reconnectDelayFn?: (attempt: number) => number,
  ) {
    this.reconnectDelayFn = reconnectDelayFn ?? reconnectDelayMs;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  get isTerminal(): boolean {
    return this.terminalCode !== null;
  }

  /**
   * Start the background reconnect loop and resolve when the first handshake
   * completes. Rejects immediately if the broker returns a terminal error.
   */
  start(): Promise<void> {
    const p = new Promise<void>((resolve, reject) => {
      this.firstConnectResolve = resolve;
      this.firstConnectReject = reject;
    });
    void this._maintainLoop();
    return p;
  }

  private async _maintainLoop(): Promise<void> {
    while (!this._closed && this.terminalCode === null) {
      try {
        await this._openAndHandshake();

        // First connection succeeded
        if (!this.firstConnected) {
          this.firstConnected = true;
          this.firstConnectResolve?.();
          this.firstConnectResolve = null;
          this.firstConnectReject = null;
        }

        this.reconnectAttempt = 0;

        // Re-send topic subscriptions after reconnect (broker persists them but we
        // re-send to be safe on a fresh connection)
        if (this.subscribedTopics.length > 0) {
          this._sendImmediate({ op: 'subscribe', topics: this.subscribedTopics });
        }

        // Flush any frames that were buffered while disconnected
        this._flushPending();

        // Run until the socket closes (normal operation)
        await this._receiveLoop();
      } catch {
        // Connection failed or socket errored
      }

      this.ws = null;

      if (this._closed || this.terminalCode !== null) return;

      const delay = this.reconnectDelayFn(this.reconnectAttempt);
      this.reconnectAttempt++;
      await sleep(delay);
    }
  }

  /**
   * Open WebSocket, send hello, wait for welcome (or error).
   * Message and gap frames received during replay are dispatched immediately.
   */
  private _openAndHandshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const hello: HelloFrame = {
        op: 'hello',
        agent_id: this.agentId,
        token: this.token,
        protocol_version: 1,
        last_acked_cursor: this.lastAckedCursor,
        replay: true,
      };

      ws.once('open', () => {
        ws.send(JSON.stringify(hello));
      });

      let welcomed = false;

      const onMessage = (data: RawData): void => {
        let frame: InboundFrame;
        try {
          frame = JSON.parse(rawToString(data)) as InboundFrame;
        } catch {
          return;
        }

        if (frame.op === 'welcome') {
          welcomed = true;
          ws.off('message', onMessage);
          resolve();
          return;
        }

        if (frame.op === 'error') {
          ws.off('message', onMessage);
          if (TERMINAL_CODES.has(frame.code)) {
            this.terminalCode = frame.code;
            this.onError(frame.code, frame.message);
            if (!this.firstConnected) {
              this.firstConnectReject?.(new Error(`terminal broker error: ${frame.code}`));
              this.firstConnectResolve = null;
              this.firstConnectReject = null;
            }
          }
          reject(new Error(`broker error: ${frame.code}`));
          ws.close();
          return;
        }

        // During replay (before welcome), message/gap frames can arrive
        if (frame.op === 'message') {
          this._dispatch(frame);
        } else if (frame.op === 'gap') {
          this._dispatchGap(frame);
        }
      };

      ws.on('message', onMessage);

      ws.once('error', (err) => {
        if (!welcomed) {
          ws.off('message', onMessage);
          reject(err);
        }
      });

      ws.once('close', () => {
        if (!welcomed) {
          ws.off('message', onMessage);
          reject(new Error('connection closed before welcome'));
        }
      });
    });
  }

  /** Run until the WebSocket closes. Dispatches message and gap frames. */
  private _receiveLoop(): Promise<void> {
    const ws = this.ws;
    if (!ws) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const onMessage = (data: RawData): void => {
        let frame: InboundFrame;
        try {
          frame = JSON.parse(rawToString(data)) as InboundFrame;
        } catch {
          return;
        }

        if (frame.op === 'message') {
          this._dispatch(frame);
        } else if (frame.op === 'gap') {
          this._dispatchGap(frame);
        } else if (frame.op === 'error') {
          if (TERMINAL_CODES.has(frame.code)) {
            this.terminalCode = frame.code;
          }
          this.onError(frame.code, frame.message);
        }
      };

      ws.on('message', onMessage);

      const done = (): void => {
        ws.off('message', onMessage);
        resolve();
      };

      ws.once('close', done);
      ws.once('error', done);
    });
  }

  private _dispatch(msg: MessageFrame): void {
    for (const h of this.messageHandlers) h(msg);
  }

  private _dispatchGap(gap: GapFrame): void {
    for (const h of this.gapHandlers) h(gap);
  }

  private _sendImmediate(frame: OutboundFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Socket closed mid-send; reconnect loop will handle it
    }
  }

  private _flushPending(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const json of this.pendingSends.splice(0)) {
      try {
        ws.send(json);
      } catch {
        break;
      }
    }
  }

  /**
   * Send an outbound frame. If connected, sends immediately.
   * If disconnected, buffers up to PENDING_CAP frames (drops oldest on overflow).
   */
  send(frame: OutboundFrame): void {
    if (this._closed) return;

    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(frame));
        return;
      } catch {
        // Fall through to pending queue
      }
    }

    if (this.pendingSends.length >= PENDING_CAP) {
      // Drop oldest buffered send
      this.pendingSends.shift();
    }
    this.pendingSends.push(JSON.stringify(frame));
  }

  /**
   * Update the acknowledged cursor and send an ack frame to the broker.
   * The cursor is persisted in lastAckedCursor for use in the next hello.
   */
  ack(cursor: number): void {
    if (cursor <= this.lastAckedCursor) return;
    this.lastAckedCursor = cursor;
    this._sendImmediate({ op: 'ack', cursor });
  }

  /**
   * Register topic subscriptions to be (re-)sent on every connect.
   */
  addTopics(topics: string[]): void {
    for (const t of topics) {
      if (!this.subscribedTopics.includes(t)) {
        this.subscribedTopics.push(t);
      }
    }
    this._sendImmediate({ op: 'subscribe', topics });
  }

  async close(): Promise<void> {
    this._closed = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }
}
