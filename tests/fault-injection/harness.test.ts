/**
 * Fault-injection harness — Phase D merge gate.
 *
 * Runs N seeded iterations. Each iteration:
 *   1. Starts a fresh broker subprocess on a temp DB
 *   2. Connects a sender and receiver
 *   3. Sends 5 pre-fault direct messages
 *   4. Injects one randomly selected fault
 *   5. Recovers (reconnect/restart as needed)
 *   6. Sends 5 post-fault messages
 *   7. Drains the receiver
 *   8. Checks invariants (at-least-once, FIFO, reconnect-bounded, gap-bounded)
 *   9. Cleans up
 *
 * Environment:
 *   FAULT_ITERATIONS — number of iterations (default: 100)
 *   FAULT_SEED       — hex seed for Mulberry32 PRNG (default: deadbeef)
 *
 * Reproduce a failing run:
 *   FAULT_SEED=<failing-seed> FAULT_ITERATIONS=1 npm run test:fault
 *
 * Note on idempotency: the broker is at-least-once. Duplicate delivery is expected
 * and valid after ack-loss / reconnect / replay (RFC 0002 §Delivery guarantees).
 * Receivers deduplicate on idempotency_key at the application layer. The harness
 * does NOT assert count=1 per correlation_id — only count≥1.
 *
 * Note on REORDER_MESSAGES: the fault reorders the CLIENT-side send order (B before A)
 * but the broker assigns cursors in arrival order and delivers in cursor order. The FIFO
 * invariant checks cursor ordering within each session, not original send intent.
 *
 * Note on disk exhaustion: skipped — cannot be simulated portably without OS-level
 * controls (e.g. tmpfs quotas require root on Linux, macOS has no portable equivalent).
 */

import { describe, test, afterAll } from 'vitest';
import { BrokerProc, sleep } from './broker-proc.js';
import { TestClient } from './ws-client.js';
import { FaultType, applyFault, mulberry32, pickFault } from './faults.js';
import { checkAllInvariants } from './invariants.js';

const ITERATIONS = Number(process.env['FAULT_ITERATIONS'] ?? '100');
const SEED_HEX = process.env['FAULT_SEED'] ?? 'deadbeef';
const SEED = parseInt(SEED_HEX, 16);

// Track brokers for emergency cleanup in afterAll
const activeBrokers: BrokerProc[] = [];

afterAll(async () => {
  for (const b of activeBrokers) {
    b.cleanup();
  }
  activeBrokers.length = 0;
});

describe('fault-injection harness', () => {
  test(
    `${ITERATIONS} iterations (seed=0x${SEED_HEX})`,
    { timeout: 600_000 },
    async () => {
      const prng = mulberry32(SEED);
      const faultCounts = new Map<FaultType, number>();

      for (let i = 0; i < ITERATIONS; i++) {
        const fault = pickFault(prng);
        faultCounts.set(fault, (faultCounts.get(fault) ?? 0) + 1);

        const context = `iter=${i} fault=${fault} seed=0x${SEED_HEX}`;

        let broker: BrokerProc | null = null;
        try {
          broker = await BrokerProc.create(['sender', 'receiver']);
          activeBrokers.push(broker);

          await runIteration(broker, fault, i, context, prng);

          activeBrokers.splice(activeBrokers.indexOf(broker), 1);
          broker.cleanup();
          broker = null;
        } catch (err) {
          // Add iteration context to the error message
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Fault-injection FAILED at ${context}\n\n${msg}`);
        } finally {
          if (broker) {
            activeBrokers.splice(activeBrokers.indexOf(broker), 1);
            broker.cleanup();
          }
        }
      }

      // Log fault distribution for diagnostics
      const dist = [...faultCounts.entries()]
        .map(([f, n]) => `${f}=${n}`)
        .join(', ');
      process.stderr.write(
        `[fault-harness] ${ITERATIONS} iterations green. Distribution: ${dist}\n`,
      );
    },
  );
});

async function runIteration(
  broker: BrokerProc,
  fault: FaultType,
  iterNum: number,
  context: string,
  prng: () => number,
): Promise<void> {
  const senderToken = broker.tokens.get('sender')!;
  const receiverToken = broker.tokens.get('receiver')!;

  const sender = new TestClient();
  const receiver = new TestClient();

  // Connect both clients
  await sender.connect(broker.port, 'sender', senderToken);
  await receiver.connect(broker.port, 'receiver', receiverToken);

  // ── Pre-fault sends ───────────────────────────────────────────────────────
  for (let j = 0; j < 5; j++) {
    const corrId = `pre-${iterNum}-${j}`;
    await sender.send('receiver', { iter: iterNum, seq: j, phase: 'pre' }, corrId);
  }
  // Give live fanout a tick to reach receiver before injecting fault
  await sleep(20);

  // ── Inject fault ──────────────────────────────────────────────────────────
  const faultResult = await applyFault(fault, broker, sender, receiver, prng, iterNum);

  // ── Recovery ──────────────────────────────────────────────────────────────
  let hadReconnect = false;

  if (faultResult.brokerRestarted) {
    // Reconnect receiver FIRST (with replay from cursor=0) to set the replay window
    // before any post-fault sends arrive
    await receiver.reconnect(broker.port, { replay: true, lastCursor: 0 });
    await sender.reconnect(broker.port);
    hadReconnect = true;
  } else if (faultResult.senderReconnectNeeded && faultResult.receiverReconnectNeeded) {
    await receiver.reconnect(broker.port, { replay: true, lastCursor: 0 });
    await sender.reconnect(broker.port);
    hadReconnect = true;
  } else if (faultResult.receiverReconnectNeeded) {
    await receiver.reconnect(broker.port, { replay: true, lastCursor: 0 });
    hadReconnect = true;
  } else if (faultResult.senderReconnectNeeded) {
    await sender.reconnect(broker.port);
    hadReconnect = true;
  }

  // ── Optional pre-send delay (DELAY_MESSAGE fault) ─────────────────────────
  if (faultResult.delayMs > 0) {
    await sleep(faultResult.delayMs);
  }

  // ── Post-fault sends ──────────────────────────────────────────────────────
  // For REORDER_MESSAGES: swap first two sends (B before A)
  const postOrder = faultResult.reorderPosts ? [1, 0, 2, 3, 4] : [0, 1, 2, 3, 4];
  for (const j of postOrder) {
    const corrId = `post-${iterNum}-${j}`;
    await sender.send('receiver', { iter: iterNum, seq: j, phase: 'post' }, corrId);
  }

  // ── Wait for delivery ─────────────────────────────────────────────────────
  await receiver.drain(500);

  // ── Build expected set for at-least-once check ────────────────────────────
  // For KILL_AND_RECONNECT: we can only assert messages that were committed to DB
  // before the kill. Post-fault messages are always in sender.accepted.
  const expectedAccepted = new Set<string>(sender.accepted);

  if (faultResult.committedBeforeKill !== null) {
    // Only pre-fault messages that were actually written to DB must be delivered
    // (some may have been lost if SIGKILL hit during transaction — though
    // better-sqlite3 is synchronous so this is very unlikely)
    for (const corrId of faultResult.committedBeforeKill) {
      expectedAccepted.add(corrId);
    }
    // Remove pre-fault correlation_ids that were NOT committed
    for (let j = 0; j < 5; j++) {
      const preCorrId = `pre-${iterNum}-${j}`;
      if (!faultResult.committedBeforeKill.includes(preCorrId)) {
        expectedAccepted.delete(preCorrId);
      }
    }
  }

  // ── Check invariants ──────────────────────────────────────────────────────
  checkAllInvariants({
    accepted: expectedAccepted,
    received: receiver.received,
    sessions: receiver.sessions,
    gaps: receiver.gaps,
    reconnectMs: receiver.reconnectMs,
    hadReconnect,
    context,
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  sender.close();
  receiver.close();
  await sleep(30); // let close frames propagate
}
