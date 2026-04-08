import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { arrayParam } from './helpers.js';
import { saveContext, getContext } from '../../models/context.js';
import type { SaveContextInput, GetContextInput } from '../../models/types.js';

export const contextTools: ToolDefinition[] = [
  {
    name: 'save_context',
    description: 'Persist a learning or context entry to the shared team knowledge base. Pre-write secret scanning blocks entries containing API keys.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      key: z.string().min(1).max(255).describe('Unique identifier for this context entry'),
      value: z.string().min(1).max(100_000).describe('The context content to save'),
      tags: arrayParam(z.array(z.string().max(50)).max(20)).optional().default([]).describe('Tags for categorization and filtering'),
    },
    tier: 'persist',
    write: true,
    autoRegister: true,
    secretScan: ['key', 'value'],
    handler: async (ctx, params) => {
      return saveContext(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as SaveContextInput);
    },
  },
  {
    name: 'get_context',
    description: 'Search the shared team knowledge base using full-text search and optional tag filtering.',
    schema: {
      query: z.string().min(1).describe('Full-text search query'),
      tags: arrayParam(z.array(z.string())).optional().default([]).describe('Optional tag filter (OR matching)'),
      limit: z.number().optional().describe('Max results (default 20, max 100)'),
    },
    tier: 'persist',
    handler: async (ctx, params) => {
      return getContext(ctx.db, ctx.workspaceId, params as unknown as GetContextInput);
    },
  },
];
