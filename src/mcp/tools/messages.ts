import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { arrayParam } from './helpers.js';
import { sendMessage, getMessages, searchMessages, waitForMessage, getThread } from '../../models/message.js';
import type { SendMessageInput, GetMessagesInput, WaitForMessageInput } from '../../models/types.js';

export const messageTools: ToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a message to a specific agent.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (the sender)'),
      to: z.string().min(1).max(100).describe('Recipient agent ID'),
      message: z.string().min(1).max(10_000).describe('Message text'),
      tags: arrayParam(z.array(z.string().max(50)).max(20)).optional().default([]).describe('Tags for categorization'),
      reply_to: z.number().int().positive().optional().describe('Message ID this is replying to (creates a thread)'),
    },
    tier: 'coordinate',
    write: true,
    autoRegister: true,
    secretScan: ['message'],
    handler: async (ctx, params) => {
      return sendMessage(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as SendMessageInput);
    },
  },
  {
    name: 'get_messages',
    description: 'Get messages sent to you.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (the recipient)'),
      since_id: z.number().optional().describe('Return messages after this ID'),
      limit: z.number().optional().describe('Max messages to return (default 50, max 200)'),
    },
    tier: 'coordinate',
    handler: async (ctx, params) => {
      return getMessages(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as GetMessagesInput);
    },
  },
  {
    name: 'wait_for_message',
    description: 'Long-poll: block until a direct message arrives for you after since_id, or until timeout. Returns immediately if messages already exist. Use this to idle efficiently until another agent contacts you.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (the recipient waiting for messages)'),
      since_id: z.number().int().nonnegative().describe('Wait for messages with id > since_id'),
      timeout_sec: z.number().int().nonnegative().max(60).optional().describe('Max seconds to wait (default 30, max 60)'),
    },
    tier: 'coordinate',
    handler: async (ctx, params) => {
      return waitForMessage(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as WaitForMessageInput);
    },
  },
  {
    name: 'search_messages',
    description: 'Search your message history (sent and received). Filter by text content and/or conversation partner.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      query: z.string().max(200).optional().describe('Text to search for in message content'),
      with_agent: z.string().max(100).optional().describe('Filter to messages exchanged with this agent'),
      since_id: z.number().int().nonnegative().optional().describe('Return messages after this ID'),
      limit: z.number().optional().describe('Max messages to return (default 50, max 200)'),
    },
    tier: 'coordinate',
    handler: async (ctx, params) => {
      return searchMessages(ctx.db, ctx.workspaceId, ctx.agentId, {
        query: params.query as string | undefined,
        with_agent: params.with_agent as string | undefined,
        since_id: params.since_id as number | undefined,
        limit: params.limit as number | undefined,
      });
    },
  },
  {
    name: 'get_thread',
    description: 'Get all messages in a thread (the original message plus all replies).',
    schema: {
      message_id: z.number().int().positive().describe('ID of any message in the thread'),
    },
    tier: 'coordinate',
    handler: async (ctx, params) => {
      return getThread(ctx.db, ctx.workspaceId, params.message_id as number);
    },
  },
];
