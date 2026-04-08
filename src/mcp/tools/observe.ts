import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { arrayParam } from './helpers.js';
import { getWorkspaceAnalytics, parseSinceDuration } from '../../models/analytics.js';
import { defineProfile, listProfiles, getProfile, deleteProfile } from '../../models/profile.js';
import type { DefineProfileInput } from '../../models/profile.js';
import { exportWorkspaceData } from '../../models/export.js';
import { ValidationError } from '../../errors.js';

export const observeTools: ToolDefinition[] = [
  {
    name: 'get_analytics',
    description: 'Get aggregated team analytics (tasks, events, agents, context, messages) in a single call. Filter by a duration like "24h", "7d", "30d".',
    schema: {
      since: z.string().optional().describe('Duration window, e.g. "24h" (default), "7d", "30d"'),
    },
    tier: 'observe',
    handler: async (ctx, params) => {
      try {
        const sinceIso = parseSinceDuration(params.since as string | undefined);
        return await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);
      } catch (err) {
        if (err instanceof Error && err.constructor === Error) {
          throw new ValidationError(err.message);
        }
        throw err;
      }
    },
  },

  // ─── Profiles ─────────────────────────────────────────────────
  {
    name: 'define_profile',
    description: 'Define (or update) a reusable agent profile: a named role with a system prompt and default capabilities/tags. Profiles are centralized role definitions per team.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(100).describe('Profile name (unique per team)'),
      description: z.string().min(1).max(10_000).describe('Short description of this role'),
      system_prompt: z.string().min(1).max(100_000).describe('The system prompt defining this role'),
      default_capabilities: arrayParam(z.array(z.string().max(100)).max(50)).optional().default([]).describe('Default capability tags for agents adopting this profile'),
      default_tags: arrayParam(z.array(z.string().max(50)).max(20)).optional().default([]).describe('Default tags for events/messages from this role'),
    },
    tier: 'observe',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return defineProfile(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as DefineProfileInput);
    },
  },
  {
    name: 'list_profiles',
    description: 'List all agent profiles defined for your team.',
    schema: {},
    tier: 'observe',
    handler: async (ctx) => {
      return listProfiles(ctx.db, ctx.workspaceId);
    },
  },
  {
    name: 'get_profile',
    description: 'Get a single agent profile by name, including its full system prompt.',
    schema: {
      name: z.string().min(1).max(100).describe('Profile name'),
    },
    tier: 'observe',
    handler: async (ctx, params) => {
      return getProfile(ctx.db, ctx.workspaceId, params.name as string);
    },
  },
  {
    name: 'delete_profile',
    description: 'Delete an agent profile by name.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(100).describe('Profile name to delete'),
    },
    tier: 'observe',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return deleteProfile(ctx.db, ctx.workspaceId, params.name as string);
    },
  },

  // ─── Export ───────────────────────────────────────────────────
  {
    name: 'export_workspace_data',
    description: 'Export a team snapshot for backup/portability. Returns all team data (context, events, tasks, agents, messages, artifacts metadata, playbooks, workflow runs, profiles, schedules, endpoints, webhooks). Secrets are redacted and artifact content is not included.',
    schema: {},
    tier: 'observe',
    handler: async (ctx) => {
      return exportWorkspaceData(ctx.db, ctx.workspaceId);
    },
  },
];
