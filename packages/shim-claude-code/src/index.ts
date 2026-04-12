#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Bus } from '../../sdk-ts/dist/index.js';
import type { MessageFrame } from '../../sdk-ts/dist/index.js';

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

const bus = new Bus({
  url: LATTICE_URL,
  agentId: LATTICE_AGENT_ID,
  token: LATTICE_TOKEN,
  onError: (code, message) => {
    process.stderr.write(
      JSON.stringify({ t: Date.now(), level: 'warn', event: 'bus_error', code, message }) + '\n',
    );
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

function buildChannelMeta(msg: MessageFrame): Record<string, string> {
  const meta: Record<string, string> = {
    from: msg.from,
    type: msg.type,
    cursor: String(msg.cursor),
    created_at: String(msg.created_at),
  };
  if (msg.topic) meta.topic = msg.topic;
  if (msg.idempotency_key) meta.idempotency_key = msg.idempotency_key;
  if (msg.correlation_id) meta.correlation_id = msg.correlation_id;
  return meta;
}

async function startMessageLoop() {
  for await (const msg of bus.messages()) {
    try {
      // Official Claude Code channel notification format:
      // - content: string body of the <channel> tag
      // - meta: Record<string, string> attributes on the <channel> tag
      // - source is set automatically from the server name ("lattice")
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
      process.stderr.write(
        JSON.stringify({
          t: Date.now(),
          level: 'error',
          event: 'channel_notification_failed',
          error: err instanceof Error ? err.message : String(err),
        }) + '\n',
      );
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
    process.stderr.write(
      JSON.stringify({
        t: Date.now(),
        level: 'error',
        event: 'message_loop_failed',
        error: err instanceof Error ? err.message : String(err),
      }) + '\n',
    );
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
