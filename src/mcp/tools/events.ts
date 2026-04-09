import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { arrayParam } from './helpers.js';
import { broadcastEvent, getUpdates, waitForEvent, computeRecommendedContext } from '../../models/event.js';
import type { BroadcastInput, WaitForEventInput } from '../../models/types.js';

export const eventTools: ToolDefinition[] = [
  {
    name: 'broadcast',
    description: 'Push an event to the team messaging bus. Other agents receive it on their next poll.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      event_type: z.enum(['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE']).describe('Type of event'),
      message: z.string().min(1).max(10_000).describe('Event message content'),
      tags: arrayParam(z.array(z.string().max(50)).max(20)).optional().default([]).describe('Tags for topic-based filtering'),
    },
    tier: 'coordinate',
    write: true,
    autoRegister: true,
    secretScan: ['message'],
    handler: async (ctx, params) => {
      return broadcastEvent(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as BroadcastInput);
    },
  },
  {
    name: 'get_updates',
    description: 'Poll for events since your last check. Use the returned cursor as since_id on your next call.',
    schema: {
      since_id: z.number().optional().describe('Return events after this ID'),
      since_timestamp: z.string().optional().describe('Fallback: ISO 8601 timestamp'),
      topics: arrayParam(z.array(z.string())).optional().default([]).describe('Optional topic filter'),
      limit: z.number().optional().describe('Max events to return (default 50, max 200)'),
      include_context: z.boolean().optional().describe('Include recommended_context (default true)'),
    },
    tier: 'coordinate',
    handler: async (ctx, params) => {
      return getUpdates(ctx.db, ctx.workspaceId, { ...params, agent_id: ctx.agentId });
    },
  },
  {
    name: 'wait_for_event',
    description: 'Long-poll: block until a matching event arrives after since_id, or until timeout. Returns immediately if matching events already exist.',
    schema: {
      since_id: z.number().int().nonnegative().describe('Wait for events with id > since_id'),
      topics: arrayParam(z.array(z.string())).optional().default([]).describe('Optional topic/tag filter (OR matching)'),
      event_type: z.enum(['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE']).optional().describe('Optional event type filter'),
      timeout_sec: z.number().int().nonnegative().max(60).optional().describe('Max seconds to wait (default 30, max 60)'),
    },
    tier: 'coordinate',
    handler: async (ctx, params) => {
      return waitForEvent(ctx.db, ctx.workspaceId, params as unknown as WaitForEventInput);
    },
  },
  {
    name: 'get_recommended_context',
    description: 'Get context entries relevant to your current work. Analyzes your recent events and claimed tasks to surface the most useful knowledge from the team. Use this to orient yourself at the start of work.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
    },
    tier: 'coordinate',
    autoRegister: true,
    handler: async (ctx) => {
      const entries = await computeRecommendedContext(ctx.db, ctx.workspaceId, ctx.agentId);
      return { recommended_context: entries };
    },
  },
];
