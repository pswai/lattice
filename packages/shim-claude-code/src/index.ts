#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Bus } from '../../sdk-ts/dist/index.js';
import { buildChannelMeta } from './channel-meta.js';
import { loadGatingConfig, shouldEmit, type GatingConfig } from './sender-policy.js';
import { log } from '../../../dist/bus/logger.js';

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
try {
  gatingConfig = loadGatingConfig(process.env);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
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
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    // Added to Claude's system prompt so it knows how to handle Lattice events.
    instructions:
      'Messages from other Lattice agents arrive as <channel source="lattice" from="..." type="..." ...>. ' +
      'Use the lattice_send_message tool to reply. Pass the "from" attribute as the "to" argument. ' +
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
    const { to, topic, type, payload, idempotency_key, correlation_id } = args as Record<
      string,
      unknown
    >;
    try {
      bus.send({
        to: (to as string) ?? undefined,
        topic: (topic as string) ?? undefined,
        type: (type as 'direct' | 'broadcast' | 'event') ?? 'direct',
        payload,
        idempotency_key: (idempotency_key as string) ?? undefined,
        correlation_id: (correlation_id as string) ?? undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
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

  if (name === 'lattice_subscribe') {
    const { topics } = args as { topics: string[] };
    try {
      bus.subscribe(topics);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, topics }) }] };
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

  throw new Error(`unknown tool: ${name}`);
});

// --- Channel notification: push Lattice messages into Claude's context ------

async function startMessageLoop() {
  for await (const msg of bus.messages()) {
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
    } catch (err) {
      log('error', 'channel_notification_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  if (LATTICE_TOPICS) {
    const topics = LATTICE_TOPICS.split(',').map((t) => t.trim()).filter(Boolean);
    if (topics.length > 0) bus.subscribe(topics);
  }

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
