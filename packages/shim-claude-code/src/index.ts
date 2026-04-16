#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Bus, log } from '../../sdk-ts/dist/index.js';
import { buildChannelMeta } from './channel-meta.js';
import {
  createPermissionMap,
  isVerdictPayload,
  loadPermissionConfig,
  PERMISSION_KIND,
  PERMISSION_METHOD,
  PermissionRequestNotificationSchema,
  resolveVerdict,
  type PermissionConfig,
  type VerdictPayload,
} from './permission-relay.js';
import { buildReply, createInboundCache } from './reply.js';
import { loadGatingConfig, parseList, shouldEmit, type GatingConfig } from './sender-policy.js';
import { randomUUID } from 'node:crypto';

const LATTICE_URL = process.env.LATTICE_URL;
const LATTICE_AGENT_ID = process.env.LATTICE_AGENT_ID;
const LATTICE_TOKEN = process.env.LATTICE_TOKEN;
const LATTICE_TOPICS = process.env.LATTICE_TOPICS;

if (!LATTICE_URL || !LATTICE_AGENT_ID || !LATTICE_TOKEN) {
  process.stderr.write(
    'error: LATTICE_URL, LATTICE_AGENT_ID, and LATTICE_TOKEN environment variables are required\n',
  );
  process.exit(1);
}

let gatingConfig: GatingConfig;
let permissionConfig: PermissionConfig;
try {
  gatingConfig = loadGatingConfig(process.env);
  permissionConfig = loadPermissionConfig(process.env);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const inboundCache = createInboundCache();
const permissionMap = createPermissionMap();

// Wrap tool handler bodies so the try/catch + JSON envelope is defined once.
// Thunk returns the raw payload; errors become `{ok:false, error}` with isError.
type ToolPayload = Record<string, unknown>;
async function toolResult(
  fn: () => ToolPayload | Promise<ToolPayload>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const payload = await fn();
    const isError = payload.ok === false;
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      ...(isError ? { isError: true } : {}),
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        },
      ],
      isError: true,
    };
  }
}

const bus = new Bus({
  url: LATTICE_URL,
  agentId: LATTICE_AGENT_ID,
  token: LATTICE_TOKEN,
  onError: (code, message) => {
    log('warn', 'bus_error', { code, message });
  },
});

// Use raw Server (not McpServer) to match the official channel protocol exactly.
// The channel docs use Server + setRequestHandler for tools, and mcp.notification()
// for channel events — that's what Claude Code's notification handler expects.
const mcp = new Server(
  { name: 'lattice', version: '0.2.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        // Declare permission capability only when relay is on with an
        // approver — otherwise CC's terminal dialog remains the sole path.
        ...(permissionConfig.enabled ? { 'claude/channel/permission': {} } : {}),
      },
      tools: {},
    },
    // Added to Claude's system prompt so it knows how to handle Lattice events.
    instructions:
      'Messages from other Lattice agents arrive as <channel source="lattice" from="..." type="..." cursor="..." ...>. ' +
      'To reply, prefer lattice_reply with to_message_id set to the cursor; it targets the original sender and preserves correlation_id. ' +
      'Use lattice_send_message for fresh sends (no prior inbound) or broadcasts. ' +
      'Topic broadcasts include a "topic" attribute; direct messages do not.',
  },
);

// --- Tools: let Claude send messages and subscribe to topics ----------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'lattice_send_message',
      description: 'Send a message to another agent or topic via the Lattice bus',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: { type: 'string', description: 'Recipient agent ID (for direct messages)' },
          topic: { type: 'string', description: 'Topic name (for broadcast messages)' },
          type: {
            type: 'string',
            enum: ['direct', 'broadcast', 'event'],
            description: 'Message type',
          },
          payload: { description: 'Message payload (any JSON value)' },
          idempotency_key: { type: 'string', description: 'Idempotency key for receiver-side dedup' },
          correlation_id: { type: 'string', description: 'Correlation ID for request/reply' },
        },
        required: ['type', 'payload'],
      },
    },
    {
      name: 'lattice_reply',
      description:
        'Reply to an inbound Lattice message. Pass the cursor shown in the <channel> tag as to_message_id; the shim resolves the recipient and correlation_id automatically.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to_message_id: {
            type: 'integer',
            description: 'The cursor of the inbound message being replied to',
          },
          payload: { description: 'Reply payload (any JSON value)' },
        },
        required: ['to_message_id', 'payload'],
      },
    },
    {
      name: 'lattice_subscribe',
      description: 'Subscribe to one or more Lattice topics',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topics: {
            type: 'array',
            items: { type: 'string' },
            description: 'Topic names to subscribe to',
          },
        },
        required: ['topics'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'lattice_send_message') {
    return toolResult(() => {
      const { to, topic, type, payload, idempotency_key, correlation_id } = args as Record<
        string,
        unknown
      >;
      bus.send({
        to: (to as string) ?? undefined,
        topic: (topic as string) ?? undefined,
        type: (type as 'direct' | 'broadcast' | 'event') ?? 'direct',
        payload,
        idempotency_key: (idempotency_key as string) ?? undefined,
        correlation_id: (correlation_id as string) ?? undefined,
      });
      return { ok: true };
    });
  }

  if (name === 'lattice_reply') {
    return toolResult(() => {
      const { to_message_id, payload } = args as Record<string, unknown>;
      if (typeof to_message_id !== 'number' || !Number.isInteger(to_message_id)) {
        return { ok: false, error: 'to_message_id must be an integer' };
      }
      const built = buildReply(inboundCache, to_message_id, payload);
      if (!built.ok) {
        return {
          ok: false,
          error: built.error,
          to_message_id: built.to_message_id,
          hint: 'Inbound not in cache (evicted or never seen). Fall back to lattice_send_message with an explicit correlation_id.',
        };
      }
      bus.send(built.args);
      // RFC §2: "zero UUID transcription" — don't echo correlation_id back to
      // the model so it can't be tempted to copy it into a follow-up send.
      return { ok: true };
    });
  }

  if (name === 'lattice_subscribe') {
    return toolResult(() => {
      const { topics } = args as { topics: string[] };
      bus.subscribe(topics);
      return { ok: true, topics };
    });
  }

  throw new Error(`unknown tool: ${name}`);
});

// --- Permission relay: mid-task interrupt via approver agent ----------------

if (permissionConfig.enabled) {
  const cfg = permissionConfig; // narrow for closures
  mcp.setNotificationHandler(PermissionRequestNotificationSchema, async (notif) => {
    const { request_id, tool_name, description, input_preview } = notif.params;
    const correlation_id = randomUUID();
    const expires_at = Date.now() + cfg.timeoutMs;
    // The setTimeout bounds map memory if no verdict ever arrives. The
    // expires_at check inside resolveVerdict covers the tiny window where a
    // verdict squeaks in between scheduled fire and actual eviction.
    const timer = setTimeout(() => {
      permissionMap.delete(correlation_id);
    }, cfg.timeoutMs);
    timer.unref();
    permissionMap.set(correlation_id, { request_id, expires_at, timer });

    try {
      bus.send({
        to: cfg.approver,
        type: 'direct',
        correlation_id,
        payload: {
          kind: PERMISSION_KIND.REQUEST,
          request_id,
          tool_name,
          description,
          input_preview,
          reply_with: {
            tool: 'lattice_reply',
            payload: {
              kind: PERMISSION_KIND.VERDICT,
              request_id,
              verdict: 'allow | deny',
            },
          },
        },
      });
      log('info', 'permission_request_forwarded', {
        request_id,
        correlation_id,
        approver: cfg.approver,
        tool_name,
      });
    } catch (err) {
      log('error', 'permission_request_send_failed', {
        request_id,
        error: err instanceof Error ? err.message : String(err),
      });
      clearTimeout(timer);
      permissionMap.delete(correlation_id);
    }
  });
}

// --- Channel notification: push Lattice messages into Claude's context ------

async function startMessageLoop() {
  for await (const msg of bus.messages()) {
    if (permissionConfig.enabled && isVerdictPayload(msg.payload)) {
      await handleVerdict(msg.payload, msg.correlation_id, msg.from);
      continue;
    }
    const decision = shouldEmit(gatingConfig, msg.from);
    if (!decision.allow) {
      // Ack advances on the next iterator pull (SDK ack-on-next). A blocked
      // message that is the last before shutdown may not get acked; the broker
      // will replay it on reconnect and we will block it again — correct, just
      // redundant log.
      log('warn', 'channel_sender_blocked', {
        from: msg.from,
        reason: decision.reason,
        cursor: msg.cursor,
      });
      continue;
    }
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: typeof msg.payload === 'string'
            ? msg.payload
            : JSON.stringify(msg.payload),
          meta: buildChannelMeta(msg),
        },
      });
      // Record AFTER successful emit: if the notification threw, Claude never
      // saw the message, so offering a reply-by-cursor would be a lie.
      inboundCache.set(msg.cursor, {
        from: msg.from,
        correlation_id: msg.correlation_id,
      });
    } catch (err) {
      log('error', 'channel_notification_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function handleVerdict(
  payload: VerdictPayload,
  correlation_id: string | null,
  from: string,
): Promise<void> {
  // Type-narrowing guard so cfg.approver is non-optional; call site already
  // checks permissionConfig.enabled.
  if (!permissionConfig.enabled) return;
  const resolution = resolveVerdict(
    permissionMap,
    payload,
    correlation_id,
    from,
    permissionConfig.approver,
    Date.now(),
  );
  if (resolution.action === 'drop') {
    log('warn', resolution.outcome, {
      from,
      request_id: resolution.request_id,
      correlation_id,
    });
    return;
  }
  // Cancel the pending cleanup timer so the closure is released now rather
  // than at end-of-timeout.
  if (resolution.consumed.timer) clearTimeout(resolution.consumed.timer);
  try {
    await mcp.notification({
      method: PERMISSION_METHOD.RESPONSE,
      params: {
        request_id: resolution.consumed.request_id,
        behavior: resolution.behavior,
      },
    });
    log('info', resolution.outcome, {
      from,
      request_id: resolution.consumed.request_id,
      correlation_id,
      behavior: resolution.behavior,
    });
  } catch (err) {
    log('error', 'permission_verdict_emit_failed', {
      error: err instanceof Error ? err.message : String(err),
      request_id: resolution.consumed.request_id,
    });
  }
}

async function shutdown() {
  try {
    await bus.close();
  } catch {
    // best-effort
  }
  process.exit(0);
}

async function main() {
  await bus.connect();

  const topics = parseList(LATTICE_TOPICS);
  if (topics.length > 0) bus.subscribe(topics);

  await mcp.connect(new StdioServerTransport());

  startMessageLoop().catch((err) => {
    log('error', 'message_loop_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
