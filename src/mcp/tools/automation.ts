import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { arrayParam } from './helpers.js';
import { definePlaybook, listPlaybooks, runPlaybook } from '../../models/playbook.js';
import type { DefinePlaybookInput } from '../../models/playbook.js';
import { defineSchedule, listSchedules, deleteSchedule } from '../../models/schedule.js';
import type { DefineScheduleInput } from '../../models/schedule.js';
import { listWorkflowRuns, getWorkflowRun, cancelWorkflowRun, type WorkflowRunStatus } from '../../models/workflow.js';
import type { ListWorkflowRunsInput } from '../../models/workflow.js';
import {
  defineInboundEndpoint,
  listInboundEndpoints,
  deleteInboundEndpoint,
} from '../../models/inbound.js';
import type { DefineInboundEndpointInput } from '../../models/inbound.js';

export const automationTools: ToolDefinition[] = [
  // ─── Playbooks ────────────────────────────────────────────────
  {
    name: 'define_playbook',
    description: 'Define (or update) a reusable playbook: a named bundle of task templates that can be instantiated as real tasks via run_playbook.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(100).describe('Playbook name (unique per team)'),
      description: z.string().min(1).max(10_000).describe('What this playbook accomplishes'),
      tasks: arrayParam(z.array(z.object({
        description: z.string().min(1).max(10_000),
        role: z.string().max(100).optional(),
        depends_on_index: arrayParam(z.array(z.number().int().nonnegative())).optional().default([]),
      }))).describe('Ordered task templates. depends_on_index references earlier templates by position.'),
      required_vars: arrayParam(z.array(z.string().min(1).max(100))).optional().describe('Variable names that must be provided when running this playbook via {{vars.KEY}} substitution.'),
    },
    tier: 'automation',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return definePlaybook(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as DefinePlaybookInput);
    },
  },
  {
    name: 'list_playbooks',
    description: 'List all playbooks defined for your team.',
    schema: {},
    tier: 'automation',
    handler: async (ctx) => {
      return listPlaybooks(ctx.db, ctx.workspaceId);
    },
  },
  {
    name: 'run_playbook',
    description: 'Instantiate a playbook: creates real tasks from the templates and wires up depends_on_index into task dependencies. Returns the created task IDs.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(100).describe('Playbook name to run'),
      vars: z.record(z.string().max(10_000)).optional().describe('Template variables substituted into task descriptions — replaces {{vars.KEY}} with the value'),
    },
    tier: 'automation',
    write: true,
    autoRegister: true,
    secretScan: ['vars'],
    handler: async (ctx, params) => {
      return runPlaybook(ctx.db, ctx.workspaceId, ctx.agentId, params.name as string, params.vars as Record<string, string> | undefined);
    },
  },

  // ─── Schedules ────────────────────────────────────────────────
  {
    name: 'define_schedule',
    description: 'Define (or update) a recurring schedule that runs a playbook on a cron expression. Supported patterns: "*/N * * * *" (every N minutes), "0 */N * * *" (every N hours), "0 N * * *" (daily at hour N), "0 H * * D" (weekly on day D at hour H).',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      playbook_name: z.string().min(1).max(100).describe('Name of an existing playbook'),
      cron_expression: z.string().min(1).max(100).describe('Cron expression (supported subset, UTC): "*/N * * * *" every N min (e.g. "*/15 * * * *"), "0 */N * * *" every N hours (e.g. "0 */6 * * *"), "0 N * * *" daily at N:00 UTC (e.g. "0 9 * * *"), "0 H * * D" weekly on day D at H:00 UTC (Sun=0, e.g. "0 14 * * 1" Mon 14:00).'),
      enabled: z.boolean().optional().describe('Whether the schedule is active (default true)'),
    },
    tier: 'automation',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return defineSchedule(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as DefineScheduleInput);
    },
  },
  {
    name: 'list_schedules',
    description: 'List all schedules defined for your team.',
    schema: {},
    tier: 'automation',
    handler: async (ctx) => {
      return listSchedules(ctx.db, ctx.workspaceId);
    },
  },
  {
    name: 'delete_schedule',
    description: 'Delete a schedule by ID.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      id: z.number().int().positive().describe('Schedule ID to delete'),
    },
    tier: 'automation',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return deleteSchedule(ctx.db, ctx.workspaceId, params.id as number);
    },
  },

  // ─── Workflow Runs ────────────────────────────────────────────
  {
    name: 'list_workflow_runs',
    description: 'List playbook workflow executions for your team, optionally filtered by status (running/completed/failed).',
    schema: {
      status: z.enum(['running', 'completed', 'failed']).optional().describe('Filter by run status'),
      limit: z.number().int().positive().max(200).optional().describe('Max results (default 50, max 200)'),
    },
    tier: 'automation',
    handler: async (ctx, params) => {
      return listWorkflowRuns(ctx.db, ctx.workspaceId, params as unknown as ListWorkflowRunsInput);
    },
  },
  {
    name: 'get_workflow_run',
    description: 'Get full details of a single workflow run, including the current status of each task it created.',
    schema: {
      id: z.number().int().positive().describe('Workflow run ID'),
    },
    tier: 'automation',
    handler: async (ctx, params) => {
      return getWorkflowRun(ctx.db, ctx.workspaceId, params.id as number);
    },
  },

  {
    name: 'cancel_workflow_run',
    description: 'Cancel a running workflow. Abandons all non-terminal tasks and marks the run as failed.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      workflow_run_id: z.number().int().positive().describe('Workflow run ID to cancel'),
    },
    tier: 'automation',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return cancelWorkflowRun(ctx.db, ctx.workspaceId, ctx.agentId, params.workflow_run_id as number);
    },
  },

  // ─── Inbound Endpoints ────────────────────────────────────────
  {
    name: 'define_inbound_endpoint',
    description: 'Create an inbound webhook endpoint that lets external systems trigger Lattice actions (create_task, broadcast_event, save_context, run_playbook). Returns the endpoint_key — use it as the path segment in POST /api/v1/inbound/:endpoint_key.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(200).describe('Human-readable name for this endpoint'),
      action_type: z
        .enum(['create_task', 'broadcast_event', 'save_context', 'run_playbook'])
        .describe('What action to take when this endpoint receives a payload'),
      action_config: z
        .record(z.unknown())
        .optional()
        .describe('Per-action config: e.g. description_template, event_type, tags, key'),
      hmac_secret: z
        .string()
        .min(8)
        .max(200)
        .optional()
        .describe('Optional HMAC-SHA256 secret — if set, requests must send X-Lattice-Signature: sha256=<hex>'),
    },
    tier: 'automation',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return defineInboundEndpoint(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as DefineInboundEndpointInput);
    },
  },
  {
    name: 'list_inbound_endpoints',
    description: 'List all inbound webhook endpoints defined for your team.',
    schema: {},
    tier: 'automation',
    handler: async (ctx) => {
      return listInboundEndpoints(ctx.db, ctx.workspaceId);
    },
  },
  {
    name: 'delete_inbound_endpoint',
    description: 'Delete an inbound webhook endpoint by ID.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      endpoint_id: z.number().describe('Endpoint ID to delete'),
    },
    tier: 'automation',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return deleteInboundEndpoint(ctx.db, ctx.workspaceId, params.endpoint_id as number);
    },
  },
];
