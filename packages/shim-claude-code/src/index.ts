#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { Bus } from '../../sdk-ts/dist/index.js';
import type { MessageFrame } from '../../sdk-ts/dist/index.js';

const LATTICE_URL = process.env.LATTICE_URL;
const LATTICE_AGENT_ID = process.env.LATTICE_AGENT_ID;
const LATTICE_TOKEN = process.env.LATTICE_TOKEN;
const LATTICE_TOPICS = process.env.LATTICE_TOPICS;
const LATTICE_CHANNEL_SOURCE = process.env.LATTICE_CHANNEL_SOURCE ?? 'lattice';

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

const mcpServer = new McpServer(
  { name: 'lattice-shim-claude-code', version: '0.2.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
  },
);

mcpServer.registerTool(
  'lattice_send_message',
  {
    description: 'Send a message to another agent or topic via the Lattice bus',
    inputSchema: {
      to: z.string().optional().describe('Recipient agent ID (for direct messages)'),
      topic: z.string().optional().describe('Topic name (for broadcast messages)'),
      type: z.enum(['direct', 'broadcast', 'event']).describe('Message type'),
      payload: z.any().describe('Message payload (any JSON value)'),
      idempotency_key: z.string().optional().describe('Idempotency key for receiver-side dedup'),
      correlation_id: z.string().optional().describe('Correlation ID for request/reply'),
    },
  },
  async ({ to, topic, type, payload, idempotency_key, correlation_id }) => {
    try {
      bus.send({
        to: to ?? undefined,
        topic: topic ?? undefined,
        type: type as 'direct' | 'broadcast' | 'event',
        payload,
        idempotency_key: idempotency_key ?? undefined,
        correlation_id: correlation_id ?? undefined,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }
  },
);

mcpServer.registerTool(
  'lattice_subscribe',
  {
    description: 'Subscribe to one or more topics on the Lattice bus',
    inputSchema: {
      topics: z.array(z.string()).min(1).describe('Topic names to subscribe to'),
    },
  },
  async ({ topics }) => {
    try {
      bus.subscribe(topics);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, topics }) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }
  },
);

let transport: StdioServerTransport;

function buildChannelNotification(msg: MessageFrame) {
  return {
    jsonrpc: '2.0' as const,
    method: 'notifications/claude/channel',
    params: {
      source: LATTICE_CHANNEL_SOURCE,
      from: msg.from,
      type: msg.type,
      topic: msg.topic,
      payload: msg.payload,
      cursor: msg.cursor,
      idempotency_key: msg.idempotency_key,
      correlation_id: msg.correlation_id,
      created_at: msg.created_at,
    },
  };
}

async function startMessageLoop() {
  for await (const msg of bus.messages()) {
    try {
      await transport.send(buildChannelNotification(msg));
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

  transport = new StdioServerTransport();
  await mcpServer.connect(transport);

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
