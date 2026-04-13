import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  callToolJson,
  collectChannelNotifications,
  connectAgentWithInbox,
  startBroker,
  startShim,
  waitFor,
  type AgentWithInbox,
  type Broker,
  type ShimHandle,
} from './harness.js';

describe('lattice_reply tool (RFC 0004 §2)', () => {
  let broker: Broker;
  let sender: AgentWithInbox;
  let shim: ShimHandle;
  let shimAgent: string;
  let notifications: ReturnType<typeof collectChannelNotifications>;

  beforeAll(async () => {
    broker = await startBroker();
    const senderToken = await broker.mintToken('agent-a');
    sender = await connectAgentWithInbox(broker, 'agent-a', senderToken);

    shimAgent = `shim-reply-${Date.now()}`;
    const shimToken = await broker.mintToken(shimAgent);
    shim = await startShim({ broker, agentId: shimAgent, token: shimToken });
    notifications = collectChannelNotifications(shim);
  }, 15000);

  afterAll(async () => {
    try { await shim?.close(); } catch { /* */ }
    await sender?.close();
    await broker?.stop();
  });

  test('§2.5: reply carries inbound.from as recipient and preserves correlation_id', async () => {
    const before = { inbox: sender.inbox.length, notif: notifications.length };
    sender.bus.send({
      to: shimAgent,
      type: 'direct',
      payload: { question: 'ping?' },
      correlation_id: 'c1',
    });
    await waitFor(() => notifications.length > before.notif, 3000);
    const latest = notifications[notifications.length - 1]!;
    expect(latest.meta.correlation_id).toBe('c1');
    const cursor = Number(latest.meta.cursor);

    const { parsed, isError } = await callToolJson(shim, 'lattice_reply', {
      to_message_id: cursor,
      payload: { answer: 'pong' },
    });
    expect(isError).toBe(false);
    expect(parsed).toEqual({ ok: true });

    await waitFor(() => sender.inbox.length > before.inbox, 3000);
    const reply = sender.inbox[sender.inbox.length - 1]!;
    expect(reply.from).toBe(shimAgent);
    expect(reply.correlation_id).toBe('c1');
    expect(reply.payload).toEqual({ answer: 'pong' });
  });

  test('unknown to_message_id returns structured error, not throws', async () => {
    const { parsed, isError } = await callToolJson<{
      ok: boolean;
      error: string;
      to_message_id: number;
    }>(shim, 'lattice_reply', { to_message_id: 99999, payload: { x: 1 } });
    expect(isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('unknown_message_id');
    expect(parsed.to_message_id).toBe(99999);
  });

  test('inbound without correlation_id: reply mints one', async () => {
    const before = { inbox: sender.inbox.length, notif: notifications.length };
    sender.bus.send({ to: shimAgent, type: 'direct', payload: { q: 1 } });
    await waitFor(() => notifications.length > before.notif, 3000);
    const latest = notifications[notifications.length - 1]!;
    expect(latest.meta.correlation_id).toBeUndefined();
    const cursor = Number(latest.meta.cursor);

    await callToolJson(shim, 'lattice_reply', { to_message_id: cursor, payload: { a: 1 } });
    await waitFor(() => sender.inbox.length > before.inbox, 3000);
    const reply = sender.inbox[sender.inbox.length - 1]!;
    expect(reply.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
