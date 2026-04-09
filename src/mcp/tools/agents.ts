import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { arrayParam } from './helpers.js';
import { registerAgent, heartbeat, listAgents } from '../../models/agent.js';
import type { RegisterAgentInput, ListAgentsInput, AgentStatus } from '../../models/agent.js';
import { sessionRegistry } from '../session-registry.js';
import { getMcpAuth } from '../auth-context.js';

export const agentTools: ToolDefinition[] = [
  {
    name: 'register_agent',
    description: 'Register this agent in the team registry with its capabilities. Enables other agents to discover what you can do. If agent_id is omitted, the server generates a unique ID — use the returned id for all subsequent calls.',
    schema: {
      agent_id: z.string().min(1).max(100).optional().describe('Your agent identity. If omitted, the server generates a unique ID for you.'),
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
      const agent = await registerAgent(ctx.db, ctx.workspaceId, params as unknown as RegisterAgentInput);

      // Remap the MCP session so push notifications route to this agent's new ID.
      // The session was initially created with the generic X-Agent-ID header value
      // (e.g. "lattice-core"); now bind it to the agent's actual registered ID.
      const auth = getMcpAuth();
      const sessionId = sessionRegistry.findSessionByAuth(auth.workspaceId, auth.agentId);
      if (sessionId) {
        sessionRegistry.remapAgent(sessionId, agent.id);
      }

      return agent;
    },
  },
  {
    name: 'list_agents',
    description: 'Discover agents registered in your team. Filter by capability or status to find the right collaborator.',
    schema: {
      capability: z.string().optional().describe('Filter by a specific capability'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Filter by status'),
      active_within_minutes: z.number().int().positive().optional().describe('Only agents with a heartbeat within the last N minutes'),
      metadata_contains: z.string().max(200).optional().describe('Filter agents whose metadata JSON contains this substring'),
    },
    tier: 'coordinate',
    handler: async (ctx, params) => {
      return listAgents(ctx.db, ctx.workspaceId, params as unknown as ListAgentsInput);
    },
  },
  {
    name: 'heartbeat',
    description: 'Send a heartbeat to keep your agent status as online. Agents that stop sending heartbeats are marked offline. Optionally merge-patch metadata.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Optionally update your status'),
      metadata: z.record(z.unknown()).optional().refine(
        (v) => v === undefined || JSON.stringify(v).length <= 10_240,
        { message: 'metadata must be under 10 KB when serialized' },
      ).describe('Merge-patch metadata (keys are merged with existing, set null to remove a key)'),
    },
    tier: 'coordinate',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return heartbeat(ctx.db, ctx.workspaceId, params.agent_id as string, params.status as AgentStatus | undefined, params.metadata as Record<string, unknown> | undefined);
    },
  },
];
