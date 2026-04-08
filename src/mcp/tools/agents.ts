import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { arrayParam } from './helpers.js';
import { registerAgent, heartbeat, listAgents } from '../../models/agent.js';
import type { RegisterAgentInput, ListAgentsInput, AgentStatus } from '../../models/agent.js';

export const agentTools: ToolDefinition[] = [
  {
    name: 'register_agent',
    description: 'Register this agent in the team registry with its capabilities. Enables other agents to discover what you can do.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      capabilities: arrayParam(z.array(z.string().max(100)).max(50)).optional().default([]).describe('List of capabilities (e.g. "python", "code-review", "data-analysis")'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Agent status (default: online)'),
      metadata: z.record(z.unknown()).optional().refine(
        (v) => v === undefined || JSON.stringify(v).length <= 10_240,
        { message: 'metadata must be under 10 KB when serialized' },
      ).describe('Optional metadata about this agent'),
    },
    tier: 'coordinate',
    write: true,
    handler: async (ctx, params) => {
      return registerAgent(ctx.db, ctx.workspaceId, params as unknown as RegisterAgentInput);
    },
  },
  {
    name: 'list_agents',
    description: 'Discover agents registered in your team. Filter by capability or status to find the right collaborator.',
    schema: {
      capability: z.string().optional().describe('Filter by a specific capability'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Filter by status'),
    },
    tier: 'coordinate',
    handler: async (ctx, params) => {
      return listAgents(ctx.db, ctx.workspaceId, params as unknown as ListAgentsInput);
    },
  },
  {
    name: 'heartbeat',
    description: 'Send a heartbeat to keep your agent status as online. Agents that stop sending heartbeats are marked offline.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Optionally update your status'),
    },
    tier: 'coordinate',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return heartbeat(ctx.db, ctx.workspaceId, params.agent_id as string, params.status as AgentStatus | undefined);
    },
  },
];
