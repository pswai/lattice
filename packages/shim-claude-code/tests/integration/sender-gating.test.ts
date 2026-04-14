import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import {
  collectChannelNotifications,
  connectSenderBus,
  findAllLogLines,
  findLogLine,
  SHIM_PATH,
  startBroker,
  startShim,
  waitFor,
  type Broker,
} from './harness.js';
import type { Bus } from '../../../sdk-ts/dist/index.js';

describe('sender identity gating (RFC 0004 §1)', () => {
  let broker: Broker;
  let agentAToken: string;
  let agentBToken: string;
  let busA: Bus;
  let busB: Bus;
  let freshCounter = 0;

  // Each test gets its own shim agent identity so retained messages from
  // previous tests don't replay into a fresh shim session.
  const freshShimAgent = async (): Promise<{ agentId: string; token: string }> => {
    const agentId = `shim-agent-${++freshCounter}`;
    const token = await broker.mintToken(agentId);
    return { agentId, token };
  };

  beforeAll(async () => {
    broker = await startBroker();
    [agentAToken, agentBToken] = await Promise.all([
      broker.mintToken('agent-a'),
      broker.mintToken('agent-b'),
    ]);
    [busA, busB] = await Promise.all([
      connectSenderBus(broker, 'agent-a', agentAToken),
      connectSenderBus(broker, 'agent-b', agentBToken),
    ]);
  }, 15000);

  afterAll(async () => {
    try { await busA?.close(); } catch { /* */ }
    try { await busB?.close(); } catch { /* */ }
    await broker?.stop();
  });

  // §2.2 — workspace-trust default surfaces every sender.
  test('workspace-trust (default): all senders surface', async () => {
    const { agentId, token } = await freshShimAgent();
    const shim = await startShim({ broker, agentId, token });
    try {
      const notifications = collectChannelNotifications(shim);
      busA.send({ to: agentId, type: 'direct', payload: { n: 1 } });
      busB.send({ to: agentId, type: 'direct', payload: { n: 2 } });
      await waitFor(() => notifications.length >= 2, 3000);
      const senders = notifications.map((n) => n.meta.from).sort();
      expect(senders).toEqual(['agent-a', 'agent-b']);
      expect(findLogLine(shim.stderr, 'channel_sender_blocked')).toBeUndefined();
    } finally {
      await shim.close();
    }
  });

  // §2.3 — allowlist blocks non-listed senders but acks them.
  test('allowlist: only listed sender surfaces; blocked sender logged', async () => {
    const { agentId, token } = await freshShimAgent();
    const shim = await startShim({
      broker,
      agentId,
      token,
      extraEnv: {
        LATTICE_CHANNEL_SENDER_POLICY: 'allowlist',
        LATTICE_CHANNEL_SENDER_ALLOWLIST: 'agent-a',
      },
    });
    try {
      const notifications = collectChannelNotifications(shim);
      busA.send({ to: agentId, type: 'direct', payload: { from: 'a' } });
      busB.send({ to: agentId, type: 'direct', payload: { from: 'b' } });

      // Wait until we see the blocked log (proves B was delivered and dropped).
      await waitFor(() => findLogLine(shim.stderr, 'channel_sender_blocked') !== undefined, 3000);
      // Give the allowed message a moment to surface as well.
      await waitFor(() => notifications.length >= 1, 3000);
      // A short grace period to catch any late (unwanted) notifications from B.
      await new Promise((r) => setTimeout(r, 200));

      expect(notifications.map((n) => n.meta.from)).toEqual(['agent-a']);
      const blocked = findAllLogLines(shim.stderr, 'channel_sender_blocked');
      expect(blocked.length).toBe(1);
      expect(blocked[0]!.from).toBe('agent-b');
      expect(blocked[0]!.reason).toBe('not_in_allowlist');
    } finally {
      await shim.close();
    }
  });

  // §2.12 — blocked messages are still acked so retention advances.
  // Proof is indirect: after the first shim blocks A and emits B, a second
  // shim reconnecting as the same agent (no denylist) must see no replay of
  // A. If A were un-acked, the broker would replay it on the fresh hello.
  test('blocked message still acked: reconnect sees no replay', async () => {
    const { agentId, token } = await freshShimAgent();
    const shim1 = await startShim({
      broker,
      agentId,
      token,
      extraEnv: {
        LATTICE_CHANNEL_SENDER_POLICY: 'denylist',
        LATTICE_CHANNEL_SENDER_DENYLIST: 'agent-a',
      },
    });
    try {
      const n1 = collectChannelNotifications(shim1);
      busA.send({ to: agentId, type: 'direct', payload: { from: 'a' } });
      busB.send({ to: agentId, type: 'direct', payload: { from: 'b' } });
      // Wait for both the block (A) and the emission (B) to settle. The ack
      // of A fires on the next iterator pull, which is the one that fetches B.
      await waitFor(() => n1.length >= 1, 3000);
      await waitFor(() => findLogLine(shim1.stderr, 'channel_sender_blocked') !== undefined, 3000);
      // Grace period so ack of B is flushed to the broker before we tear down.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await shim1.close();
    }

    // Reconnect as the same agent with no policy. If either A or B were
    // un-acked, the broker would replay them here.
    const shim2 = await startShim({ broker, agentId, token });
    try {
      const n2 = collectChannelNotifications(shim2);
      // Send a fresh message to wake the loop; we expect only this one.
      busA.send({ to: agentId, type: 'direct', payload: { fresh: true } });
      await waitFor(() => n2.length >= 1, 3000);
      await new Promise((r) => setTimeout(r, 200));
      const senders = n2.map((n) => n.meta.from);
      const freshCount = n2.filter((n) => {
        try { return JSON.parse(n.content).fresh === true; } catch { return false; }
      }).length;
      expect(freshCount).toBe(1);
      // No historical A or B beyond the fresh one.
      expect(n2.length).toBe(1);
      expect(senders).toEqual(['agent-a']);
    } finally {
      await shim2.close();
    }
  });

  // §2.4 — invalid policy string fails closed at startup.
  test('invalid policy fails closed: shim exits non-zero', async () => {
    const { agentId, token } = await freshShimAgent();
    const proc = spawn('node', [SHIM_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LATTICE_URL: `ws://127.0.0.1:${broker.port}`,
        LATTICE_AGENT_ID: agentId,
        LATTICE_TOKEN: token,
        LATTICE_CHANNEL_SENDER_POLICY: 'typo',
      },
    });
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    const code = await new Promise<number>((res) => {
      proc.on('close', (c) => res(c ?? -1));
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/LATTICE_CHANNEL_SENDER_POLICY/);
  });
});

