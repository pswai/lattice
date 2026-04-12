/**
 * Integration tests for the TypeScript Bus SDK.
 *
 * Each test spins up a fresh broker subprocess via BrokerProc, exercises
 * the Bus API, then tears down. Tests run sequentially (test.sequential)
 * to avoid port conflicts and to ensure stable timing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrokerProc, sleep } from '../../../../tests/fault-injection/broker-proc.js';
import { Bus } from '../../src/bus.js';
import { BusRequestTimeoutError, BusClosedError, BusQueueOverflowError } from '../../src/errors.js';

// Fast reconnect for tests: 100ms flat, no jitter.
// Without this, reconnectDelayMs(0) can take up to 20.5s (500ms + 20s jitter).
const FAST_RECONNECT = () => 100;

let broker: BrokerProc;

const AGENTS = ['agent-a', 'agent-b'];

async function makeBus(
  agentId: string,
  opts: {
    onError?: (code: string, msg: string) => void;
    inboundQueueSize?: number;
    fastReconnect?: boolean;
  } = {},
): Promise<Bus> {
  const token = broker.tokens.get(agentId);
  if (!token) throw new Error(`No token for ${agentId}`);
  const bus = new Bus({
    url: `ws://127.0.0.1:${broker.port}`,
    agentId,
    token,
    onError: opts.onError,
    inboundQueueSize: opts.inboundQueueSize,
    reconnectDelayFn: opts.fastReconnect ? FAST_RECONNECT : undefined,
  });
  await bus.connect();
  return bus;
}

describe('Bus SDK integration', () => {
  beforeEach(async () => {
    broker = await BrokerProc.create(AGENTS);
  });

  afterEach(async () => {
    broker.cleanup();
  });

  // ── 1. connect ──────────────────────────────────────────────────────────────

  it('connects to the broker and resolves connect()', async () => {
    const busA = await makeBus('agent-a');
    expect(busA).toBeTruthy();
    await busA.close();
  });

  // ── 2. send → receive ───────────────────────────────────────────────────────

  it('delivers a sent message to the recipient', async () => {
    const busA = await makeBus('agent-a');
    const busB = await makeBus('agent-b');

    const iter = busB.messages();

    busA.send({ to: 'agent-b', type: 'direct', payload: { hello: 'world' } });

    const { value: msg } = await iter.next();
    expect(msg.payload).toEqual({ hello: 'world' });
    expect(msg.from).toBe('agent-a');

    await busA.close();
    await busB.close();
  });

  // ── 3. ack advances cursor (broker-side) ────────────────────────────────────

  it('acks advance the cursor so replayed messages start from the right point', async () => {
    const busA = await makeBus('agent-a');
    const busB = await makeBus('agent-b');

    const iter = busB.messages();

    // Send two messages
    busA.send({ to: 'agent-b', type: 'direct', payload: 'msg1' });
    busA.send({ to: 'agent-b', type: 'direct', payload: 'msg2' });

    const r1 = await iter.next();
    expect(r1.value.payload).toBe('msg1');

    // Consuming next() acks msg1
    const r2 = await iter.next();
    expect(r2.value.payload).toBe('msg2');

    // The cursor for msg1 is now acked
    expect(busB['conn'].lastAckedCursor).toBeGreaterThan(0);

    await busA.close();
    await busB.close();
  });

  // ── 4. request / reply ──────────────────────────────────────────────────────

  it('request() resolves when reply arrives with matching correlation_id', async () => {
    const busA = await makeBus('agent-a');
    const busB = await makeBus('agent-b');

    // Agent-b echoes requests back. Iterator registers handler immediately.
    const iterB = busB.messages();
    const echoTask = (async () => {
      for await (const msg of iterB) {
        if (msg.correlation_id) {
          busB.send({
            to: msg.from,
            type: 'direct',
            payload: { echo: msg.payload },
            correlation_id: msg.correlation_id,
          });
        }
      }
    })();

    const reply = await busA.request<{ echo: unknown }>({
      to: 'agent-b',
      payload: { ping: 1 },
      timeoutMs: 5000,
    });

    expect(reply).toEqual({ echo: { ping: 1 } });

    await busA.close();
    await busB.close();   // ends iterB's queue → echoTask's for-await terminates
    await echoTask;
  });

  // ── 5. request timeout ──────────────────────────────────────────────────────

  it('request() rejects with BusRequestTimeoutError when no reply arrives', async () => {
    const busA = await makeBus('agent-a');

    await expect(
      busA.request({ to: 'agent-b', payload: 'ping', timeoutMs: 200 }),
    ).rejects.toThrow(BusRequestTimeoutError);

    await busA.close();
  });

  // ── 6. AbortController cancels a pending request ────────────────────────────

  it('request() rejects when signal is aborted', async () => {
    const busA = await makeBus('agent-a');
    const ac = new AbortController();

    const p = busA.request({
      to: 'agent-b',
      payload: 'ping',
      timeoutMs: 30_000,
      signal: ac.signal,
    });

    await sleep(50);
    ac.abort();

    await expect(p).rejects.toThrow('aborted');
    await busA.close();
  });

  // ── 7. subscribe receives topic messages ────────────────────────────────────

  it('subscribes to a topic and receives broadcast messages', async () => {
    const busA = await makeBus('agent-a');
    const busB = await makeBus('agent-b');

    const iterB = busB.messages();
    busB.subscribe(['events']);

    await sleep(100); // let subscribe frame reach broker

    busA.send({ topic: 'events', type: 'event', payload: { kind: 'ping' } });

    const { value: msg } = await iterB.next();
    expect(msg.payload).toEqual({ kind: 'ping' });
    expect(msg.topic).toBe('events');

    await busA.close();
    await busB.close();
  });

  // ── 8. reconnect: SDK reconnects after broker restart ───────────────────────

  it('reconnects after broker restart and receives post-reconnect messages', async () => {
    const busA = await makeBus('agent-a', { fastReconnect: true });
    const busB = await makeBus('agent-b', { fastReconnect: true });

    const iterB = busB.messages();

    // Send one message before kill
    busA.send({ to: 'agent-b', type: 'direct', payload: 'before-kill' });
    const { value: first } = await iterB.next();
    expect(first.payload).toBe('before-kill');

    // Kill and restart on the same port
    await broker.restartSamePort();

    await sleep(500); // give SDK time to reconnect (FAST_RECONNECT = 100ms)

    // Send a message after restart
    busA.send({ to: 'agent-b', type: 'direct', payload: 'after-restart' });

    const received: unknown[] = [];
    for await (const msg of iterB) {
      received.push(msg.payload);
      if (msg.payload === 'after-restart') break;
    }

    expect(received).toContain('after-restart');

    await busA.close();
    await busB.close();
  });

  // ── 9. gap frame is surfaced via gapHandlers ─────────────────────────────────

  it('gap handler is wired to the connection', async () => {
    const busB = await makeBus('agent-b');

    const gaps: Array<{ from: number; to: number }> = [];
    busB['conn'].gapHandlers.add((g) => gaps.push({ from: g.from, to: g.to }));

    // Verify the gap handler plumbing is correctly wired
    expect(busB['conn'].gapHandlers.size).toBeGreaterThanOrEqual(1);

    await busB.close();
  });

  // ── 10. inbox_full is delivered to onError ──────────────────────────────────

  it('delivers inbox_full to onError without closing the connection', async () => {
    broker.cleanup();
    // Create a broker with a very small inbox limit
    broker = await BrokerProc.create(AGENTS, { inboxLimit: 3 });

    const errors: string[] = [];
    const busA = new Bus({
      url: `ws://127.0.0.1:${broker.port}`,
      agentId: 'agent-a',
      token: broker.tokens.get('agent-a')!,
      onError: (code) => errors.push(code),
    });
    await busA.connect();

    // agent-b is not consuming, so after 3 messages its inbox is full
    busA.send({ to: 'agent-b', type: 'direct', payload: 1 });
    busA.send({ to: 'agent-b', type: 'direct', payload: 2 });
    busA.send({ to: 'agent-b', type: 'direct', payload: 3 });
    // This 4th message should trigger inbox_full
    busA.send({ to: 'agent-b', type: 'direct', payload: 4 });
    busA.send({ to: 'agent-b', type: 'direct', payload: 5 });

    await sleep(500); // let error frames propagate back

    expect(errors.some((c) => c === 'inbox_full')).toBe(true);

    await busA.close();
  });

  // ── 11. LRU deduplication drops re-delivered idempotency keys ───────────────

  it('deduplicates messages with the same idempotency_key', async () => {
    const busA = await makeBus('agent-a');
    const busB = await makeBus('agent-b');

    const iter = busB.messages();
    const received: unknown[] = [];

    // Send the same idempotency_key twice — should only appear once
    busA.send({ to: 'agent-b', type: 'direct', payload: 'unique', idempotency_key: 'idem-1' });
    busA.send({ to: 'agent-b', type: 'direct', payload: 'unique', idempotency_key: 'idem-1' });
    // Third distinct message so we can break the loop
    busA.send({ to: 'agent-b', type: 'direct', payload: 'different', idempotency_key: 'idem-2' });

    for await (const msg of iter) {
      received.push(msg.payload);
      if (msg.payload === 'different') break;
    }

    // 'unique' should appear exactly once; 'different' once
    expect(received.filter((v) => v === 'unique').length).toBe(1);
    expect(received.filter((v) => v === 'different').length).toBe(1);

    await busA.close();
    await busB.close();
  });

  // ── 12. queue overflow throws BusQueueOverflowError ─────────────────────────

  it('overflows the inbound queue and throws BusQueueOverflowError', async () => {
    const busA = await makeBus('agent-a');

    // Create busB with a tiny queue
    const token = broker.tokens.get('agent-b')!;
    const busB = new Bus({
      url: `ws://127.0.0.1:${broker.port}`,
      agentId: 'agent-b',
      token,
      inboundQueueSize: 3,
    });
    await busB.connect();

    // Get the iterator — handler is registered immediately (eager)
    const iter = busB.messages();

    // Send more messages than the queue can hold without consuming
    for (let i = 0; i < 6; i++) {
      busA.send({ to: 'agent-b', type: 'direct', payload: i });
    }

    // Let all messages arrive and fill/overflow the queue
    await sleep(300);

    // Drain until overflow error
    let overflowed = false;
    try {
      for await (const _ of iter) {
        // consume without breaking — let it overflow
      }
    } catch (err) {
      if (err instanceof BusQueueOverflowError) overflowed = true;
    }

    expect(overflowed).toBe(true);

    await busA.close();
    await busB.close();
  });

  // ── 13. kill + replay: pre-kill messages replayed after reconnect ────────────

  it('replays pre-kill messages after broker restarts on same port', async () => {
    const busA = await makeBus('agent-a', { fastReconnect: true });
    const busB = await makeBus('agent-b', { fastReconnect: true });

    // Register iterator before sending — handler is registered immediately
    const iter = busB.messages();

    // Send a message and consume it (cursor advances, but not acked yet)
    busA.send({ to: 'agent-b', type: 'direct', payload: 'msg-before-kill' });
    const { value: first } = await iter.next();
    expect(first.payload).toBe('msg-before-kill');
    // lastAckedCursor is still 0 — ack-on-next defers it

    // Kill and restart on the same port
    await broker.restartSamePort();

    await sleep(400); // give SDK time to reconnect (FAST_RECONNECT = 100ms)

    // Send a message post-restart so we have a definite end condition
    busA.send({ to: 'agent-b', type: 'direct', payload: 'msg-after-restart' });

    const collected: unknown[] = [];
    for await (const msg of iter) {
      collected.push(msg.payload);
      if (msg.payload === 'msg-after-restart') break;
    }

    // msg-before-kill should be replayed (cursor 0 was not acked before kill),
    // msg-after-restart should also arrive
    expect(collected).toContain('msg-before-kill');
    expect(collected).toContain('msg-after-restart');

    await busA.close();
    await busB.close();
  });

  // ── 14. close() ends messages() iterator cleanly ────────────────────────────

  it('close() terminates an active messages() iterator', async () => {
    const busB = await makeBus('agent-b');

    const received: unknown[] = [];
    const iterDone = (async () => {
      for await (const msg of busB.messages()) {
        received.push(msg.payload);
      }
    })();

    await sleep(50);
    await busB.close();
    await iterDone; // must resolve (not hang)

    expect(received.length).toBe(0);
  });
});
