import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import {
  connectAgentWithInbox,
  findAllLogLines,
  findLogLine,
  SHIM_PATH,
  startBroker,
  startShim,
  waitFor,
  type AgentWithInbox,
  type Broker,
  type ShimHandle,
} from './harness.js';
import {
  PERMISSION_KIND,
  PERMISSION_METHOD,
} from '../../src/permission-relay.js';

describe('permission relay (RFC 0004 §3)', () => {
  let broker: Broker;
  let approver: AgentWithInbox;

  beforeAll(async () => {
    broker = await startBroker();
    const approverToken = await broker.mintToken('agent-supervisor');
    approver = await connectAgentWithInbox(broker, 'agent-supervisor', approverToken);
  }, 15000);

  afterAll(async () => {
    await approver?.close();
    await broker?.stop();
  });

  // §2.6 — capability gating
  test('§2.6: capability not declared when relay unset', async () => {
    const shimAgent = `shim-perm-${Date.now()}-off`;
    const shimToken = await broker.mintToken(shimAgent);
    const shim = await startShim({ broker, agentId: shimAgent, token: shimToken });
    try {
      const caps = shim.client.getServerCapabilities();
      expect(caps?.experimental).toHaveProperty('claude/channel');
      expect(caps?.experimental).not.toHaveProperty('claude/channel/permission');
    } finally {
      await shim.close();
    }
  });

  test('§2.6: capability declared when relay on with approver', async () => {
    const shimAgent = `shim-perm-${Date.now()}-on`;
    const shimToken = await broker.mintToken(shimAgent);
    const shim = await startShim({
      broker,
      agentId: shimAgent,
      token: shimToken,
      extraEnv: {
        LATTICE_CHANNEL_PERMISSION_RELAY: 'on',
        LATTICE_CHANNEL_PERMISSION_APPROVER: 'agent-supervisor',
      },
    });
    try {
      const caps = shim.client.getServerCapabilities();
      expect(caps?.experimental).toHaveProperty('claude/channel/permission');
    } finally {
      await shim.close();
    }
  });

  test('§2.6: relay=on with no approver fails closed', async () => {
    const shimAgent = `shim-perm-${Date.now()}-noapp`;
    const shimToken = await broker.mintToken(shimAgent);
    const proc = spawn('node', [SHIM_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LATTICE_URL: `ws://127.0.0.1:${broker.port}`,
        LATTICE_AGENT_ID: shimAgent,
        LATTICE_TOKEN: shimToken,
        LATTICE_CHANNEL_PERMISSION_RELAY: 'on',
      },
    });
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    const code = await new Promise<number>((res) => proc.on('close', (c) => res(c ?? -1)));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/APPROVER/);
  });

  // §2.7 + §2.8 + §2.9 + §2.11 share a relay-on shim. Verdicts target distinct
  // request_ids so they don't collide.
  describe('with relay enabled', () => {
    let shim: ShimHandle;
    let shimAgent: string;
    let permNotifications: Array<{ request_id: string; behavior: string }>;

    beforeAll(async () => {
      shimAgent = `shim-perm-${Date.now()}-flow`;
      const shimToken = await broker.mintToken(shimAgent);
      shim = await startShim({
        broker,
        agentId: shimAgent,
        token: shimToken,
        extraEnv: {
          LATTICE_CHANNEL_PERMISSION_RELAY: 'on',
          LATTICE_CHANNEL_PERMISSION_APPROVER: 'agent-supervisor',
          LATTICE_CHANNEL_PERMISSION_TIMEOUT_MS: '500',
        },
      });
      permNotifications = [];
      shim.client.fallbackNotificationHandler = async (n: any) => {
        if (n.method === PERMISSION_METHOD.RESPONSE) {
          permNotifications.push(n.params);
        }
      };
    }, 15000);

    afterAll(async () => {
      try { await shim?.close(); } catch { /* */ }
    });

    test('§2.7: allow path emits behavior=allow', async () => {
      const before = approver.inbox.length;
      // Claude Code → shim: permission_request notification
      await shim.client.notification({
        method: PERMISSION_METHOD.REQUEST,
        params: { request_id: 'req-allow', tool_name: 'Bash', description: 'echo hi' },
      });
      // Shim → approver: bus message with kind=channel.permission_request
      await waitFor(() => approver.inbox.length > before, 3000);
      const forwarded = approver.inbox[approver.inbox.length - 1]!;
      const payload = forwarded.payload as Record<string, unknown>;
      expect(payload.kind).toBe(PERMISSION_KIND.REQUEST);
      expect(payload.request_id).toBe('req-allow');
      expect(payload.tool_name).toBe('Bash');
      expect(forwarded.correlation_id).not.toBeNull();

      // Approver → shim: verdict via direct send echoing correlation_id.
      approver.bus.send({
        to: shimAgent,
        type: 'direct',
        correlation_id: forwarded.correlation_id!,
        payload: { kind: PERMISSION_KIND.VERDICT, request_id: 'req-allow', verdict: 'allow' },
      });

      await waitFor(
        () => permNotifications.some((n) => n.request_id === 'req-allow'),
        3000,
      );
      const emitted = permNotifications.find((n) => n.request_id === 'req-allow')!;
      expect(emitted.behavior).toBe('allow');
      expect(findLogLine(shim.stderr, 'verdict_accepted')).toBeDefined();
    });

    test('§2.8: deny path emits behavior=deny', async () => {
      const before = approver.inbox.length;
      await shim.client.notification({
        method: PERMISSION_METHOD.REQUEST,
        params: { request_id: 'req-deny', tool_name: 'Bash' },
      });
      await waitFor(() => approver.inbox.length > before, 3000);
      const forwarded = approver.inbox[approver.inbox.length - 1]!;
      approver.bus.send({
        to: shimAgent,
        type: 'direct',
        correlation_id: forwarded.correlation_id!,
        payload: { kind: PERMISSION_KIND.VERDICT, request_id: 'req-deny', verdict: 'deny' },
      });
      await waitFor(
        () => permNotifications.some((n) => n.request_id === 'req-deny'),
        3000,
      );
      const emitted = permNotifications.find((n) => n.request_id === 'req-deny')!;
      expect(emitted.behavior).toBe('deny');
    });

    test('§2.9: unauthorized verdict dropped; legitimate one still resolves', async () => {
      // Mint a separate intruder agent.
      const intruderToken = await broker.mintToken('agent-intruder');
      const intruder = await connectAgentWithInbox(broker, 'agent-intruder', intruderToken);

      try {
        const before = approver.inbox.length;
        await shim.client.notification({
          method: PERMISSION_METHOD.REQUEST,
          params: { request_id: 'req-unauth', tool_name: 'Bash' },
        });
        await waitFor(() => approver.inbox.length > before, 3000);
        const forwarded = approver.inbox[approver.inbox.length - 1]!;

        // Intruder fires a forged verdict first.
        intruder.bus.send({
          to: shimAgent,
          type: 'direct',
          correlation_id: forwarded.correlation_id!,
          payload: { kind: PERMISSION_KIND.VERDICT, request_id: 'req-unauth', verdict: 'allow' },
        });
        await waitFor(
          () => findAllLogLines(shim.stderr, 'verdict_unauthorized')
            .some((l) => l.request_id === 'req-unauth'),
          3000,
        );
        // No notification emitted yet for this request_id.
        expect(permNotifications.some((n) => n.request_id === 'req-unauth')).toBe(false);

        // Real approver fires the verdict — should still resolve.
        approver.bus.send({
          to: shimAgent,
          type: 'direct',
          correlation_id: forwarded.correlation_id!,
          payload: { kind: PERMISSION_KIND.VERDICT, request_id: 'req-unauth', verdict: 'deny' },
        });
        await waitFor(
          () => permNotifications.some((n) => n.request_id === 'req-unauth'),
          3000,
        );
        const emitted = permNotifications.find((n) => n.request_id === 'req-unauth')!;
        expect(emitted.behavior).toBe('deny');
      } finally {
        await intruder.close();
      }
    });

    test('§2.11: timeout → no emission; late verdict logged', async () => {
      const before = { perm: permNotifications.length, approver: approver.inbox.length };
      await shim.client.notification({
        method: PERMISSION_METHOD.REQUEST,
        params: { request_id: 'req-timeout', tool_name: 'Bash' },
      });
      await waitFor(() => approver.inbox.length > before.approver, 3000);
      const forwarded = approver.inbox[approver.inbox.length - 1]!;

      // Wait past the 500ms timeout without sending any verdict.
      await new Promise((r) => setTimeout(r, 800));
      expect(permNotifications.some((n) => n.request_id === 'req-timeout')).toBe(false);

      // Late verdict arrives — should be dropped as late_verdict.
      approver.bus.send({
        to: shimAgent,
        type: 'direct',
        correlation_id: forwarded.correlation_id!,
        payload: { kind: PERMISSION_KIND.VERDICT, request_id: 'req-timeout', verdict: 'allow' },
      });
      await waitFor(
        () => findAllLogLines(shim.stderr, 'late_verdict')
          .some((l) => l.request_id === 'req-timeout'),
        3000,
      );
      expect(permNotifications.some((n) => n.request_id === 'req-timeout')).toBe(false);
    });
  });

  // §2.10 — replay equivalent: a verdict for an unknown correlation_id is
  // dropped. Concretely, a fresh shim that never saw the request will treat
  // a replayed historical verdict as late_verdict (in-memory map is empty).
  test('§2.10: historical verdict on reconnect does not emit permission notification', async () => {
    // First shim instance: register a request, get its correlation_id, leave
    // a verdict in the broker, then close the shim WITHOUT processing it.
    const shimAgent = `shim-perm-${Date.now()}-replay`;
    const shimToken = await broker.mintToken(shimAgent);
    let correlation_id: string;
    {
      const shim = await startShim({
        broker,
        agentId: shimAgent,
        token: shimToken,
        extraEnv: {
          LATTICE_CHANNEL_PERMISSION_RELAY: 'on',
          LATTICE_CHANNEL_PERMISSION_APPROVER: 'agent-supervisor',
          LATTICE_CHANNEL_PERMISSION_TIMEOUT_MS: '60000',
        },
      });
      try {
        const before = approver.inbox.length;
        await shim.client.notification({
          method: PERMISSION_METHOD.REQUEST,
          params: { request_id: 'req-replay', tool_name: 'Bash' },
        });
        await waitFor(() => approver.inbox.length > before, 3000);
        correlation_id = approver.inbox[approver.inbox.length - 1]!.correlation_id!;
      } finally {
        await shim.close();
      }
    }

    // Approver now fires the verdict — but the shim is gone. Broker retains it.
    approver.bus.send({
      to: shimAgent,
      type: 'direct',
      correlation_id: correlation_id!,
      payload: { kind: PERMISSION_KIND.VERDICT, request_id: 'req-replay', verdict: 'allow' },
    });
    // Give the broker time to durably persist the verdict before reconnect.
    // Under suite-level resource pressure, 200ms can be too tight.
    await new Promise((r) => setTimeout(r, 500));

    // Reconnect a fresh shim with relay on. The verdict will replay from the
    // broker, but the in-memory permission map is empty → late_verdict drop.
    const shim2 = await startShim({
      broker,
      agentId: shimAgent,
      token: shimToken,
      extraEnv: {
        LATTICE_CHANNEL_PERMISSION_RELAY: 'on',
        LATTICE_CHANNEL_PERMISSION_APPROVER: 'agent-supervisor',
      },
    });
    try {
      const perm: Array<{ request_id: string }> = [];
      shim2.client.fallbackNotificationHandler = async (n: any) => {
        if (n.method === PERMISSION_METHOD.RESPONSE) perm.push(n.params);
      };
      await waitFor(
        () => findAllLogLines(shim2.stderr, 'late_verdict')
          .some((l) => l.request_id === 'req-replay'),
        6000,
      );
      expect(perm.some((p) => p.request_id === 'req-replay')).toBe(false);
    } finally {
      await shim2.close();
    }
  });
});
