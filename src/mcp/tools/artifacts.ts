import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { saveArtifact, getArtifact, listArtifacts } from '../../models/artifact.js';
import type { SaveArtifactInput, ListArtifactsInput } from '../../models/types.js';

export const artifactTools: ToolDefinition[] = [
  {
    name: 'save_artifact',
    description: 'Save a typed artifact (HTML, JSON, markdown, code, etc.) to team storage. Separate from context — artifacts are for structured file outputs, not learnings. Max 1 MB.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      key: z.string().min(1).max(255).describe('Unique artifact key (per team)'),
      content_type: z.enum([
        'text/plain', 'text/markdown', 'text/html', 'application/json',
        'text/x-typescript', 'text/x-javascript', 'text/x-python', 'text/css',
      ]).describe('MIME content type'),
      content: z.string().min(1).max(1_048_576).describe('Artifact content (max 1 MB)'),
      metadata: z.record(z.unknown()).optional().describe('Optional structured metadata'),
    },
    tier: 'persist',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return saveArtifact(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as SaveArtifactInput);
    },
  },
  {
    name: 'get_artifact',
    description: 'Retrieve a single artifact by key, including full content.',
    schema: {
      key: z.string().min(1).max(255).describe('Artifact key'),
    },
    tier: 'persist',
    handler: async (ctx, params) => {
      return getArtifact(ctx.db, ctx.workspaceId, params.key as string);
    },
  },
  {
    name: 'list_artifacts',
    description: 'List artifacts in team storage (metadata only — no content). Filter by content_type.',
    schema: {
      content_type: z.enum([
        'text/plain', 'text/markdown', 'text/html', 'application/json',
        'text/x-typescript', 'text/x-javascript', 'text/x-python', 'text/css',
      ]).optional().describe('Optional content_type filter'),
      limit: z.number().optional().describe('Max results (default 50, max 200)'),
    },
    tier: 'persist',
    handler: async (ctx, params) => {
      return listArtifacts(ctx.db, ctx.workspaceId, params as unknown as ListArtifactsInput);
    },
  },
];
