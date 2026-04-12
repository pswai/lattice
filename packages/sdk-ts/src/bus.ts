/**
 * Bus — high-level API for the Lattice message bus.
 *
 * const bus = new Bus({ url, agentId, token });
 * await bus.connect();
 *
 * bus.send({ to: 'agent-b', type: 'direct', payload: { ... } });
 *
 * for await (const msg of bus.messages()) {
 *   await processMessage(msg);
 * }
 *
 * const reply = await bus.request({ to: 'agent-b', payload: { ... }, timeoutMs: 5000 });
 *
 * await bus.close();
 */

import { randomUUID } from 'node:crypto';
import { Connection } from './connection.js';
import { AsyncQueue } from './queue.js';
import { LruCache } from './lru.js';
import { reconnectDelayMs } from './backoff.js';
import { BusClosedError, BusRequestTimeoutError, BusReplayGapError } from './errors.js';
import type { MessageFrame, GapFrame, SendFrame } from './protocol.js';

export type { MessageFrame, GapFrame } from './protocol.js';

export interface BusOptions {
  /** WebSocket URL of the broker, e.g. "ws://127.0.0.1:8787" */
  url: string;
  /** Agent identity registered in the broker */
  agentId: string;
  /** Bearer token for this agent */
  token: string;
  /**
   * Called when the broker returns an unrecoverable or unexpected error frame.
   * Includes: inbox_full (transient), malformed_frame, internal_error, terminal errors.
   */
  onError?: (code: string, message: string) => void;
  /**
   * Max number of inbound messages to buffer before the messages() queue
   * overflows. Default: 1000.
   */
  inboundQueueSize?: number;
  /**
   * Number of idempotency_key values remembered for deduplication.
   * Default: 1000.
   */
  dedupeSize?: number;
  /**
   * Override the reconnect delay function (ms to wait before attempt N).
   * Primarily for tests. Defaults to exponential backoff with full jitter.
   */
  reconnectDelayFn?: (attempt: number) => number;
}

export interface SendOptions {
  to?: string;
  topic?: string;
  type?: 'direct' | 'broadcast' | 'event';
  payload: unknown;
  idempotency_key?: string;
  correlation_id?: string;
}

export interface RequestOptions {
  to: string;
  payload: unknown;
  type?: 'direct' | 'broadcast' | 'event';
  /** Milliseconds before the request times out. Default: 30000 */
  timeoutMs?: number;
  /** AbortSignal to cancel the pending request */
  signal?: AbortSignal;
}

export class Bus {
  private readonly conn: Connection;
  private readonly seen: LruCache<string>;
  private readonly inboundQueueSize: number;
  _closed = false; // package-internal visibility for tests

  // Only one messages() iterator at a time
  private activeIterator = false;

  // Reference to the active messages() queue so close() can end it
  private activeQueue: AsyncQueue<MessageFrame> | null = null;

  // Pending requests indexed by correlation_id
  private readonly pendingRequests = new Map<
    string,
    { resolve: (msg: MessageFrame) => void; reject: (err: Error) => void }
  >();

  constructor(options: BusOptions) {
    const onError = options.onError ?? (() => {});
    this.inboundQueueSize = options.inboundQueueSize ?? 1000;
    this.seen = new LruCache<string>(options.dedupeSize ?? 1000);

    this.conn = new Connection(
      options.url,
      options.agentId,
      options.token,
      onError,
      options.reconnectDelayFn,
    );

    // Wire request reply handler — always active, not tied to messages() iterator
    this.conn.messageHandlers.add((msg) => this._handleRequestReply(msg));

    // Wire gap handler for requests
    this.conn.gapHandlers.add((gap) => this._handleGapForRequests(gap));
  }

  /**
   * Connect to the broker. Resolves when the first handshake completes.
   * Reconnects automatically in the background after this returns.
   */
  async connect(): Promise<void> {
    if (this._closed) throw new BusClosedError();
    await this.conn.start();
  }

  /**
   * Fire-and-forget send. Errors (inbox_full, etc.) are delivered via onError.
   * Buffers up to 100 frames if currently disconnected.
   */
  send(options: SendOptions): void {
    if (this._closed) return;
    const frame: SendFrame = {
      op: 'send',
      type: options.type ?? 'direct',
      payload: options.payload,
    };
    if (options.to !== undefined) frame.to = options.to;
    if (options.topic !== undefined) frame.topic = options.topic;
    if (options.idempotency_key !== undefined) frame.idempotency_key = options.idempotency_key;
    if (options.correlation_id !== undefined) frame.correlation_id = options.correlation_id;
    this.conn.send(frame);
  }

  /**
   * Subscribe this agent to one or more topics.
   * Subscriptions are re-sent on every reconnect.
   */
  subscribe(topics: string[]): void {
    if (this._closed) return;
    this.conn.addTopics(topics);
  }

  /**
   * Returns an async iterator that yields inbound messages.
   *
   * Design notes:
   * - Handler is registered IMMEDIATELY (not lazily when first next() is called).
   *   This ensures no messages are missed between messages() and the first await.
   * - Acks the previous message when next() is called (ack-on-next pattern).
   * - Deduplicates on idempotency_key using an LRU cache.
   * - Only one iterator may be active at a time.
   * - Ends when bus.close() is called or the queue overflows.
   */
  messages(): AsyncIterableIterator<MessageFrame> {
    if (this._closed) throw new BusClosedError();
    if (this.activeIterator) {
      throw new Error('Only one messages() iterator may be active at a time');
    }

    this.activeIterator = true;
    const queue = new AsyncQueue<MessageFrame>(this.inboundQueueSize);
    this.activeQueue = queue;

    const conn = this.conn;
    const seen = this.seen;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const busRef = this;

    // Register handler immediately — before any await, before the caller's next tick
    const msgHandler = (msg: MessageFrame): void => {
      queue.push(msg);
    };
    conn.messageHandlers.add(msgHandler);

    let pendingAckCursor: number | null = null;
    let done = false;

    const cleanup = (): void => {
      if (done) return;
      done = true;
      if (pendingAckCursor !== null) {
        conn.ack(pendingAckCursor);
        pendingAckCursor = null;
      }
      conn.messageHandlers.delete(msgHandler);
      queue.end();
      if (busRef.activeQueue === queue) busRef.activeQueue = null;
      busRef.activeIterator = false;
    };

    const iter: AsyncIterableIterator<MessageFrame> = {
      [Symbol.asyncIterator](): AsyncIterableIterator<MessageFrame> {
        return iter;
      },

      async next(): Promise<IteratorResult<MessageFrame>> {
        if (done) return { done: true, value: undefined as never };

        // Ack-on-next: ack the previous message before fetching the next
        if (pendingAckCursor !== null) {
          conn.ack(pendingAckCursor);
          pendingAckCursor = null;
        }

        if (busRef._closed) {
          cleanup();
          return { done: true, value: undefined as never };
        }

        // Loop to skip deduped messages
        for (;;) {
          let result: IteratorResult<MessageFrame>;
          try {
            result = await queue.shift();
          } catch (err) {
            cleanup();
            throw err;
          }

          if (result.done) {
            cleanup();
            return { done: true, value: undefined as never };
          }

          const msg = result.value;
          pendingAckCursor = msg.cursor;

          // Idempotency dedup
          if (msg.idempotency_key !== null) {
            if (seen.has(msg.idempotency_key)) {
              // Deduped: ack it eagerly so cursor advances, then skip yielding
              conn.ack(msg.cursor);
              pendingAckCursor = null;
              continue;
            }
            seen.add(msg.idempotency_key);
          }

          return { done: false, value: msg };
        }
      },

      async return(): Promise<IteratorResult<MessageFrame>> {
        cleanup();
        return { done: true, value: undefined as never };
      },

      async throw(err?: Error): Promise<IteratorResult<MessageFrame>> {
        cleanup();
        if (err) throw err;
        return { done: true, value: undefined as never };
      },
    };

    return iter;
  }

  /**
   * Send a message and wait for a reply with a matching correlation_id.
   *
   * The reply is expected as an inbound message whose correlation_id matches
   * the one generated (or provided via options). Rejects on timeout or abort.
   */
  async request<T = unknown>(options: RequestOptions): Promise<T> {
    if (this._closed) throw new BusClosedError();

    const correlationId = randomUUID();
    const timeoutMs = options.timeoutMs ?? 60_000;

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(correlationId);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const timer = setTimeout(() => {
        done(() => reject(new BusRequestTimeoutError(correlationId, timeoutMs)));
      }, timeoutMs);

      const onAbort = (): void => {
        done(() => reject(new Error('request aborted')));
      };

      if (options.signal?.aborted) {
        clearTimeout(timer);
        reject(new Error('request aborted'));
        return;
      }

      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.pendingRequests.set(correlationId, {
        resolve: (msg) => done(() => resolve(msg.payload as T)),
        reject: (err) => done(() => reject(err)),
      });

      this.send({
        to: options.to,
        type: options.type ?? 'direct',
        payload: options.payload,
        correlation_id: correlationId,
      });
    });
  }

  private _handleRequestReply(msg: MessageFrame): void {
    if (msg.correlation_id === null) return;
    const pending = this.pendingRequests.get(msg.correlation_id);
    if (!pending) return;
    pending.resolve(msg);
  }

  private _handleGapForRequests(gap: GapFrame): void {
    if (this.pendingRequests.size === 0) return;
    const err = new BusReplayGapError(gap.from, gap.to);
    for (const { reject } of this.pendingRequests.values()) {
      reject(err);
    }
    this.pendingRequests.clear();
  }

  /**
   * Close the bus. Stops reconnects, terminates the WebSocket, ends the
   * messages() iterator if active.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    // End the active messages() iterator so any pending queue.shift() resolves
    if (this.activeQueue) {
      this.activeQueue.end();
      this.activeQueue = null;
    }

    await this.conn.close();

    // Reject any pending requests
    for (const { reject } of this.pendingRequests.values()) {
      reject(new BusClosedError());
    }
    this.pendingRequests.clear();
  }
}

// Re-export for convenience
export { reconnectDelayMs };
