import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  callToolJson,
  connectAgentWithInbox,
  startBroker,
  startShim,
  waitFor,
  type AgentWithInbox,
  type Broker,
  type ShimHandle,
} from './harness.js';

describe('Claude Code channel shim', () => {
  let broker: Broker;
  let shim: ShimHandle;
  let sender: AgentWithInbox;

  beforeAll(async () => {
    broker = await startBroker();
    const [shimToken, senderToken] = await Promise.all([
      broker.mintToken('shim-agent'),
      broker.mintToken('sender-agent'),
    ]);
    shim = await startShim({ broker, agentId: 'shim-agent', token: shimToken });
    sender = await connectAgentWithInbox(broker, 'sender-agent', senderToken);
  }, 15000);

  afterAll(async () => {
    try { await shim?.close(); } catch { /* */ }
    await sender?.close();
    await broker?.stop();
  });

  test('MCP initialize returns experimental claude/channel capability', () => {
    const caps = shim.client.getServerCapabilities();
    expect(caps?.experimental).toHaveProperty('claude/channel');
    expect(shim.client.getServerVersion()?.name).toBe('lattice');
  });

  test('lists lattice tools', async () => {
    const result = await shim.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toContain('lattice_send_message');
    expect(names).toContain('lattice_reply');
    expect(names).toContain('lattice_subscribe');
  });

  test('lattice_send_message tool sends a message through the broker', async () => {
    const before = sender.inbox.length;
    const { parsed } = await callToolJson(shim, 'lattice_send_message', {
      to: 'sender-agent',
      type: 'direct',
      payload: { hello: 'from shim' },
    });
    expect(parsed).toEqual({ ok: true });
    await waitFor(() => sender.inbox.length > before, 3000);
    expect(sender.inbox[sender.inbox.length - 1]!.payload).toEqual({ hello: 'from shim' });
  });

  test('lattice_subscribe tool subscribes to a topic', async () => {
    const { parsed } = await callToolJson(shim, 'lattice_subscribe', {
      topics: ['test-topic'],
    });
    expect(parsed).toMatchObject({ ok: true, topics: ['test-topic'] });
  });

  test('shim emits channel notification when a Lattice message arrives', async () => {
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no channel notification in 5s')), 5000);
      shim.client.fallbackNotificationHandler = async (n: any) => {
        if (n.method === 'notifications/claude/channel') {
          clearTimeout(timeout);
          resolve(n.params as Record<string, unknown>);
        }
      };
    });

    sender.bus.send({ to: 'shim-agent', type: 'direct', payload: { ping: true, ts: Date.now() } });

    const notification = await received;
    // Official channel format: { content: string, meta: Record<string, string> }.
    // `source` is auto-set by the MCP server from the server name; not in params.
    expect(notification).toHaveProperty('content');
    expect(notification).toHaveProperty('meta');
    const meta = notification.meta as Record<string, string>;
    expect(meta.from).toBe('sender-agent');
    expect(meta.type).toBe('direct');
    expect(JSON.parse(notification.content as string)).toMatchObject({ ping: true });
  }, 10000);
});
