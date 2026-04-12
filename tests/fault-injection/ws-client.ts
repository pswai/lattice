/**
 * TestClient — minimal WebSocket client for fault-injection tests.
 *
 * Tracks:
 *   accepted   — correlation_ids of sends that received no error response
 *   rejected   — correlation_ids of sends that received an error frame
 *   received   — all message frames received across all sessions
 *   sessions   — per-session cursor sequences (for FIFO checks)
 *   gaps       — all gap frames received
 *   reconnectMs — wall-clock time of last reconnect attempt
 *
 * "Accepted" = the broker returned no error within 80ms of sending.
 * Because we send sequentially and the broker processes sends synchronously
 * (better-sqlite3), 80ms is sufficient to catch inbox_full / malformed_frame.
 */

import WebSocket from 'ws';
import type { RawData } from 'ws';

export interface RxMsg {
  cursor: number;
  correlationId: string | null;
  from: string;
  payload: unknown;
}

export interface GapFrame {
  from: number;
  to: number;
  reason: string;
}

export class TestClient {
  readonly received: RxMsg[] = [];
  readonly accepted = new Set<string>();
  readonly rejected = new Set<string>();
  readonly gaps: GapFrame[] = [];
  /** Per-session cursor sequences: sessions[0] = cursors from first connect, etc. */
  readonly sessions: number[][] = [];

  reconnectMs = 0;

  private ws: WebSocket | null = null;
  private agentId = '';
  private token = '';
  private currentSession: number[] = [];
  /**
   * Single pending error callback. We send sequentially (one in-flight send at a time)
   * so a single slot suffices. If a post-welcome error arrives and no send is pending,
   * the error is logged to stderr and ignored.
   */
  private pendingErrorCb: ((code: string) => void) | null = null;

  async connect(
    port: number,
    agentId: string,
    token: string,
    opts: { lastCursor?: number; replay?: boolean } = {},
  ): Promise<void> {
    this.agentId = agentId;
    this.token = token;
    this.currentSession = [];
    this.sessions.push(this.currentSession);
    await this._open(port, opts);
  }

  async reconnect(
    port: number,
    opts: { lastCursor?: number; replay?: boolean } = {},
  ): Promise<void> {
    this._closeWs();
    const t0 = Date.now();
    this.currentSession = [];
    this.sessions.push(this.currentSession);
    await this._open(port, opts);
    this.reconnectMs = Date.now() - t0;
  }

  private _closeWs(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private _open(
    port: number,
    opts: { lastCursor?: number; replay?: boolean },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let welcomed = false;
      const deadline = setTimeout(
        () => { if (!welcomed) reject(new Error('connect timeout (5s)')); },
        5000,
      );

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws = ws;

      ws.once('open', () => {
        ws.send(
          JSON.stringify({
            op: 'hello',
            agent_id: this.agentId,
            token: this.token,
            protocol_version: 1,
            last_acked_cursor: opts.lastCursor ?? 0,
            replay: opts.replay ?? false,
          }),
        );
      });

      ws.on('message', (data: RawData) => {
        let frame: Record<string, unknown>;
        try {
          const str =
            Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Array.isArray(data)
                ? Buffer.concat(data as Buffer[]).toString('utf8')
                : String(data);
          frame = JSON.parse(str) as Record<string, unknown>;
        } catch {
          return;
        }

        if (frame['op'] === 'welcome') {
          if (!welcomed) {
            welcomed = true;
            clearTimeout(deadline);
            resolve();
          }
          return;
        }

        if (frame['op'] === 'message') {
          const msg: RxMsg = {
            cursor: frame['cursor'] as number,
            correlationId: (frame['correlation_id'] as string | null) ?? null,
            from: frame['from'] as string,
            payload: frame['payload'],
          };
          this.received.push(msg);
          this.currentSession.push(msg.cursor);
          return;
        }

        if (frame['op'] === 'gap') {
          this.gaps.push({
            from: frame['from'] as number,
            to: frame['to'] as number,
            reason: frame['reason'] as string,
          });
          return;
        }

        if (frame['op'] === 'error') {
          const code = frame['code'] as string;
          if (!welcomed) {
            clearTimeout(deadline);
            reject(new Error(`pre-welcome error: ${code}`));
            return;
          }
          // Post-welcome error: deliver to pending send callback (if any)
          if (this.pendingErrorCb) {
            const cb = this.pendingErrorCb;
            this.pendingErrorCb = null;
            cb(code);
          }
          return;
        }
      });

      ws.on('error', (err) => {
        if (!welcomed) {
          clearTimeout(deadline);
          reject(err);
        }
        // Post-welcome errors: socket will close next; let close handler clean up
      });

      ws.on('close', () => {
        if (!welcomed) {
          clearTimeout(deadline);
          reject(new Error('connection closed before welcome'));
        }
        // Post-welcome close: test will explicitly reconnect when needed
      });
    });
  }

  /**
   * Send a direct message. Awaits up to 80ms for an error frame.
   * Returns the error code if rejected, or null if accepted.
   */
  async send(to: string, payload: unknown, correlationId: string): Promise<string | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.agentId}: not connected`);
    }

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingErrorCb = null;
        this.accepted.add(correlationId);
        resolve(null);
      }, 80);

      this.pendingErrorCb = (code: string) => {
        clearTimeout(timer);
        this.pendingErrorCb = null;
        this.rejected.add(correlationId);
        resolve(code);
      };

      this.ws!.send(
        JSON.stringify({
          op: 'send',
          to,
          type: 'direct',
          payload,
          correlation_id: correlationId,
        }),
      );
    });
  }

  /** Send an ack frame for the given cursor. */
  ack(cursor: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'ack', cursor }));
    }
  }

  /** Send an arbitrary raw frame — for fault injection (e.g. corrupt ack). */
  sendRaw(frame: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  /** Close the connection. */
  close(): void {
    this._closeWs();
  }

  /**
   * Wait until no new messages arrive for `quietMs` ms.
   * Resolves when the receiver goes quiet (drain complete or socket dead).
   */
  drain(quietMs = 500): Promise<void> {
    return new Promise((resolve) => {
      let prev = this.received.length;
      const tick = (): void => {
        if (this.received.length === prev) {
          resolve();
        } else {
          prev = this.received.length;
          setTimeout(tick, quietMs);
        }
      };
      setTimeout(tick, quietMs);
    });
  }
}
