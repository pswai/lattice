/**
 * Invariant checks for the fault-injection harness.
 *
 * The broker guarantees at-least-once delivery with per-recipient FIFO on cursor.
 * It does NOT guarantee exactly-once — duplicates are expected and valid after
 * ack-lost-in-flight / reconnect / replay (RFC 0002 §Delivery guarantees).
 *
 * Invariants checked after each iteration:
 *
 * 1. AT_LEAST_ONCE — every accepted correlation_id appears in receiver.received
 *    at least once. count > 1 is OK (duplicate delivery). count = 0 is a violation.
 *
 * 2. FIFO_PER_SESSION — within each connected session (between connect and
 *    reconnect), the sequence of received cursors is strictly non-decreasing.
 *    This matches the broker's guarantee: messages are delivered in cursor order.
 *
 * 3. RECONNECT_BOUNDED — a reconnect must complete within 5 seconds.
 *
 * 4. GAP_BOUNDED — any gap frame's span (to - from) must be ≤ 1000 (MAX_REPLAY_COUNT).
 */

import type { RxMsg, GapFrame } from './ws-client.js';

const MAX_RECONNECT_MS = 5000;
const MAX_REPLAY_COUNT = 1000;

export function assertAtLeastOnce(
  accepted: Set<string>,
  received: RxMsg[],
  context: string,
): void {
  if (accepted.size === 0) return;

  // Build a map of correlation_id → count from received messages
  const receivedCounts = new Map<string, number>();
  for (const msg of received) {
    if (msg.correlationId === null) continue;
    receivedCounts.set(msg.correlationId, (receivedCounts.get(msg.correlationId) ?? 0) + 1);
  }

  const missing: string[] = [];
  for (const corrId of accepted) {
    const count = receivedCounts.get(corrId) ?? 0;
    if (count === 0) missing.push(corrId);
  }

  if (missing.length > 0) {
    throw new Error(
      `[${context}] AT_LEAST_ONCE violated: ${missing.length} accepted message(s) never received.\n` +
        `  Missing correlation_ids: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}\n` +
        `  accepted.size=${accepted.size}, received.length=${received.length}`,
    );
  }
}

export function assertFifoPerSession(sessions: number[][], context: string): void {
  for (let si = 0; si < sessions.length; si++) {
    const cursors = sessions[si]!;
    for (let i = 1; i < cursors.length; i++) {
      if (cursors[i]! < cursors[i - 1]!) {
        throw new Error(
          `[${context}] FIFO_PER_SESSION violated in session ${si}:\n` +
            `  cursor[${i - 1}]=${cursors[i - 1]} > cursor[${i}]=${cursors[i]}\n` +
            `  session cursors: ${cursors.slice(Math.max(0, i - 3), i + 3).join(', ')}`,
        );
      }
    }
  }
}

export function assertReconnectBounded(reconnectMs: number, context: string): void {
  if (reconnectMs > MAX_RECONNECT_MS) {
    throw new Error(
      `[${context}] RECONNECT_BOUNDED violated: reconnect took ${reconnectMs}ms (limit: ${MAX_RECONNECT_MS}ms)`,
    );
  }
}

export function assertGapBounded(gaps: GapFrame[], context: string): void {
  for (const gap of gaps) {
    const span = gap.to - gap.from;
    if (span > MAX_REPLAY_COUNT) {
      throw new Error(
        `[${context}] GAP_BOUNDED violated: gap span ${span} exceeds MAX_REPLAY_COUNT ${MAX_REPLAY_COUNT}\n` +
          `  gap: from=${gap.from}, to=${gap.to}, reason=${gap.reason}`,
      );
    }
  }
}

/** Run all four invariants. Throws on the first violation. */
export function checkAllInvariants(opts: {
  accepted: Set<string>;
  received: RxMsg[];
  sessions: number[][];
  gaps: GapFrame[];
  reconnectMs: number;
  hadReconnect: boolean;
  context: string;
}): void {
  assertAtLeastOnce(opts.accepted, opts.received, opts.context);
  assertFifoPerSession(opts.sessions, opts.context);
  if (opts.hadReconnect) {
    assertReconnectBounded(opts.reconnectMs, opts.context);
  }
  assertGapBounded(opts.gaps, opts.context);
}
