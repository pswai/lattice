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

if (!LATTICE_URL || !LATTICE_AGENT_ID || !LATTICE_TOKEN) {
  process.stderr.write(
    'error: LATTICE_URL, LATTICE_AGENT_ID, and LATTICE_TOKEN environment variables are required\n',
  );
  process.exit(1);
}

// In-memory queue populated by the SDK's messages() iterator.
// lattice_wait reads from this queue — sub-millisecond when non-empty.
const messageQueue: MessageFrame[] = [];
let pendingWaiter: ((msg: MessageFrame | null) => void) | null = null;

function enqueueMessage(msg: MessageFrame) {
  if (pendingWaiter) {
    const resolve = pendingWaiter;
    pendingWaiter = null;
    resolve(msg);
  } else {
    messageQueue.push(msg);
  }
}

function waitForMessage(timeoutMs: number): Promise<MessageFrame | null> {
  const queued = messageQueue.shift();
  if (queued) return Promise.resolve(queued);
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingWaiter = null;
      resolve(null);
    }, timeoutMs);
    pendingWaiter = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
  });
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
  { name: 'lattice-shim-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

mcpServer.registerTool(
  'lattice_wait',
  {
    description:
      'Wait for the next Lattice message. Returns immediately if the local queue is non-empty; otherwise blocks up to timeout_ms. Every response includes pending_messages count.',
    inputSchema: {
      timeout_ms: z.number().int().min(0).max(30000).default(5000)
        .describe('Max ms to wait for a message (0 = poll, max 30000)'),
      correlation_id: z.string().optional()
        .describe('If set, filter for a message with this correlation_id'),
    },
  },
  async ({ timeout_ms, correlation_id }) => {
    let msg: MessageFrame | null = null;
    if (correlation_id) {
      // Check queue for a matching correlation_id
      const idx = messageQueue.findIndex((m) => m.correlation_id === correlation_id);
      if (idx >= 0) {
        msg = messageQueue.splice(idx, 1)[0]!;
      } else {
        // Wait for a matching message
        msg = await waitForCorrelatedMessage(correlation_id, timeout_ms);
      }
    } else {
      msg = await waitForMessage(timeout_ms);
    }

    const pending = messageQueue.length;
    if (!msg) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ message: null, pending_messages: pending }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            message: {
              cursor: msg.cursor,
              from: msg.from,
              type: msg.type,
              topic: msg.topic,
              payload: msg.payload,
              idempotency_key: msg.idempotency_key,
              correlation_id: msg.correlation_id,
              created_at: msg.created_at,
            },
            pending_messages: pending,
          }),
        },
      ],
    };
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
      idempotency_key: z.string().optional().describe('Idempotency key'),
      correlation_id: z.string().optional().describe('Correlation ID'),
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
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, pending_messages: messageQueue.length }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              pending_messages: messageQueue.length,
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
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, topics, pending_messages: messageQueue.length }),
          },
        ],
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

async function waitForCorrelatedMessage(
  correlationId: string,
  timeoutMs: number,
): Promise<MessageFrame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idx = messageQueue.findIndex((m) => m.correlation_id === correlationId);
    if (idx >= 0) return messageQueue.splice(idx, 1)[0]!;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Wait for any message, check if it matches
    const msg = await waitForMessage(Math.min(remaining, 200));
    if (msg) {
      if (msg.correlation_id === correlationId) return msg;
      messageQueue.push(msg);
    }
  }
  return null;
}

async function startMessageLoop() {
  for await (const msg of bus.messages()) {
    enqueueMessage(msg);
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

  const transport = new StdioServerTransport();
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
