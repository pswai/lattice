import type { DbAdapter } from '../../db/adapter.js';
import type { z } from 'zod';

export type ToolTier = 'automation' | 'persist' | 'coordinate' | 'observe';

/** Per-request context injected into every MCP tool handler. */
export interface ToolContext {
  db: DbAdapter;
  workspaceId: string;
  agentId: string;
}

/** Declarative definition of an MCP tool — schema, tier, and handler. */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  tier: ToolTier;
  write?: boolean;
  autoRegister?: boolean;
  secretScan?: string[];
  handler: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>;
}
