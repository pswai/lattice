/**
 * Fault types and injection logic for the fault-injection harness.
 *
 * 6 fault types (disk exhaustion is skipped — cannot be simulated portably
 * without OS-level control; e.g. tmpfs quotas require root on Linux):
 *
 *   NONE              — baseline, no fault injected
 *   KILL_AND_RECONNECT — SIGKILL broker mid-run, restart on same DB, clients reconnect
 *   SENDER_DISCONNECT  — close sender WS, reconnect without replay
 *   CORRUPT_ACK        — receiver sends ack with cursor=-1 (schema invalid), broker closes it
 *   DUPLICATE_MSG      — send the same correlation_id twice; both stored (at-least-once)
 *   DELAY_MESSAGE      — delay one send by 50–250ms (tests no timer-based drops)
 *   REORDER_MESSAGES   — release two buffered sends in reverse order (B before A)
 */

import { BrokerProc } from './broker-proc.js';
import { TestClient } from './ws-client.js';

export enum FaultType {
  NONE = 'NONE',
  KILL_AND_RECONNECT = 'KILL_AND_RECONNECT',
  SENDER_DISCONNECT = 'SENDER_DISCONNECT',
  CORRUPT_ACK = 'CORRUPT_ACK',
  DUPLICATE_MSG = 'DUPLICATE_MSG',
  DELAY_MESSAGE = 'DELAY_MESSAGE',
  REORDER_MESSAGES = 'REORDER_MESSAGES',
}

export const ALL_FAULTS: FaultType[] = [
  FaultType.NONE,
  FaultType.KILL_AND_RECONNECT,
  FaultType.SENDER_DISCONNECT,
  FaultType.CORRUPT_ACK,
  FaultType.DUPLICATE_MSG,
  FaultType.DELAY_MESSAGE,
  FaultType.REORDER_MESSAGES,
];

export interface FaultResult {
  /** Broker was killed and restarted; callers must reconnect clients to the new port. */
  brokerRestarted: boolean;
  /**
   * correlation_ids present in bus_messages immediately after kill.
   * null means "no kill happened" — use sender.accepted for no-loss check.
   */
  committedBeforeKill: string[] | null;
  /** Sender WS was closed; caller must reconnect before post-fault sends. */
  senderReconnectNeeded: boolean;
  /** Receiver WS was closed; caller must reconnect (with replay) before waiting for messages. */
  receiverReconnectNeeded: boolean;
  /** ms to sleep before starting post-fault sends (DELAY_MESSAGE). */
  delayMs: number;
  /** If true, post-fault sends should be issued in B-A-C-D-E order (REORDER_MESSAGES). */
  reorderPosts: boolean;
  /** Extra correlation_id to expect in receiver.received (DUPLICATE_MSG second send). */
  extraExpectedCorrId: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Apply the fault between pre-fault and post-fault sends.
 * Modifies broker/sender/receiver state in place.
 * Returns instructions for the harness on what recovery is needed.
 */
export async function applyFault(
  fault: FaultType,
  broker: BrokerProc,
  sender: TestClient,
  receiver: TestClient,
  prng: () => number,
  iterNum: number,
): Promise<FaultResult> {
  const result: FaultResult = {
    brokerRestarted: false,
    committedBeforeKill: null,
    senderReconnectNeeded: false,
    receiverReconnectNeeded: false,
    delayMs: 0,
    reorderPosts: false,
    extraExpectedCorrId: null,
  };

  switch (fault) {
    case FaultType.NONE:
      // No fault — baseline path
      break;

    case FaultType.KILL_AND_RECONNECT: {
      // 1. Close WS connections first so they don't get stuck in half-open state
      sender.close();
      receiver.close();
      await sleep(30);

      // 2. SIGKILL the broker — no clean shutdown
      await broker.kill();

      // 3. Read DB directly to find which messages were committed before the kill.
      //    SQLite WAL is safe to read after the writer is dead.
      const db = broker.openDb();
      try {
        const rows = db
          .prepare(
            `SELECT correlation_id FROM bus_messages
             WHERE to_agent = 'receiver' AND correlation_id IS NOT NULL
             ORDER BY id`,
          )
          .all() as { correlation_id: string }[];
        result.committedBeforeKill = rows.map((r) => r.correlation_id);
      } finally {
        db.close();
      }

      // 4. Restart broker on same DB (new port)
      await broker.restart();

      result.brokerRestarted = true;
      result.senderReconnectNeeded = true;
      result.receiverReconnectNeeded = true;
      break;
    }

    case FaultType.SENDER_DISCONNECT: {
      // Close the sender WS mid-run; receiver is unaffected
      sender.close();
      await sleep(50);
      result.senderReconnectNeeded = true;
      break;
    }

    case FaultType.CORRUPT_ACK: {
      // Send an ack with cursor=-1 (fails AckSchema min(0) validation).
      // Broker will respond with malformed_frame and close the receiver connection.
      receiver.sendRaw({ op: 'ack', cursor: -1 });
      // Give broker time to process and close the connection
      await sleep(100);
      result.receiverReconnectNeeded = true;
      break;
    }

    case FaultType.DUPLICATE_MSG: {
      // Send a message with a duplicate correlation_id (same as the first pre-fault msg).
      // Broker does NOT dedup — both rows are written to bus_messages.
      // At-least-once semantics: receiver receives both (which is fine per RFC 0002).
      const dupCorrId = `pre-${iterNum}-0`;
      await sender.send('receiver', { seq: -1, phase: 'dup', note: 'duplicate send' }, dupCorrId);
      // The duplicate is "extra" — it doesn't need to be in accepted (it uses an existing corrId)
      // but it WILL be received. We record it so invariants can account for it.
      result.extraExpectedCorrId = dupCorrId;
      break;
    }

    case FaultType.DELAY_MESSAGE: {
      // Insert a 50–250ms delay before post-fault sends.
      // Tests that the broker doesn't drop frames due to client-side timing gaps.
      result.delayMs = 50 + Math.floor(prng() * 200);
      break;
    }

    case FaultType.REORDER_MESSAGES: {
      // Post-fault sends will be issued in B-A-C-D-E order instead of A-B-C-D-E.
      // The broker inserts in arrival order, assigns cursors in that order.
      // The receiver sees messages in cursor order (FIFO per broker commit order).
      // Invariant: cursors in received are non-decreasing within each session.
      result.reorderPosts = true;
      break;
    }
  }

  return result;
}

/**
 * Mulberry32 PRNG — 32-bit seed, produces floats in [0, 1).
 * Reproducible: same seed → same sequence, enabling re-run with FAULT_SEED=xxx.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Select a fault type from ALL_FAULTS using the PRNG. */
export function pickFault(prng: () => number): FaultType {
  return ALL_FAULTS[Math.floor(prng() * ALL_FAULTS.length)]!;
}
