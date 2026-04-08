import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { arrayParam } from './helpers.js';
import { createTask, updateTask, listTasks, getTask, getTaskGraph } from '../../models/task.js';
import type { ListTasksInput, GetTaskGraphInput } from '../../models/task.js';
import type { CreateTaskInput, UpdateTaskInput } from '../../models/types.js';

export const taskTools: ToolDefinition[] = [
  {
    name: 'create_task',
    description: 'Create a work item visible to all agents. Defaults to auto-claiming for the creator.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      description: z.string().min(1).max(10_000).describe('What needs to be done'),
      status: z.enum(['open', 'claimed']).optional().describe('Initial status (default: claimed)'),
      depends_on: arrayParam(z.array(z.number()).max(100)).optional().default([]).describe('Task IDs that must complete before this task can be claimed'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Priority: P0 (highest) through P3 (lowest). Default P2.'),
      assigned_to: z.string().max(100).optional().describe('Agent ID this task is assigned to'),
    },
    tier: 'persist',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return createTask(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as CreateTaskInput);
    },
  },
  {
    name: 'update_task',
    description: 'Update a task status. Uses optimistic locking — include the current version number.',
    schema: {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      task_id: z.number().describe('Task ID to update'),
      status: z.enum(['claimed', 'completed', 'escalated', 'abandoned']).describe('New status'),
      result: z.string().optional().describe('Completion result or escalation reason'),
      version: z.number().int().nonnegative().describe('Current version for optimistic locking'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Update priority'),
      assigned_to: z.string().max(100).nullable().optional().describe('Reassign to agent, or null to unassign'),
    },
    tier: 'persist',
    write: true,
    autoRegister: true,
    handler: async (ctx, params) => {
      return updateTask(ctx.db, ctx.workspaceId, ctx.agentId, params as unknown as UpdateTaskInput);
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks visible to the team. Use claimable=true to find work ready to claim (open/abandoned with no unfinished dependencies).',
    schema: {
      status: z.enum(['open', 'claimed', 'completed', 'escalated', 'abandoned']).optional().describe('Filter by task status (ignored when claimable=true)'),
      claimed_by: z.string().optional().describe('Filter by claiming agent ID'),
      assigned_to: z.string().optional().describe('Filter by assigned agent ID'),
      created_by: z.string().optional().describe('Filter by creating agent ID'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Filter by priority level'),
      claimable: z.boolean().optional().describe('When true, return only tasks that are open/abandoned AND have no unfinished dependencies — ready to claim'),
      description_contains: z.string().max(200).optional().describe('Filter tasks whose description contains this substring'),
      limit: z.number().optional().describe('Max results (default 50, max 200)'),
    },
    tier: 'persist',
    handler: async (ctx, params) => {
      return listTasks(ctx.db, ctx.workspaceId, params as unknown as ListTasksInput);
    },
  },
  {
    name: 'get_task',
    description: 'Get a single task by ID with full details.',
    schema: {
      task_id: z.number().describe('Task ID to retrieve'),
    },
    tier: 'persist',
    handler: async (ctx, params) => {
      return getTask(ctx.db, ctx.workspaceId, params.task_id as number);
    },
  },
  {
    name: 'get_task_graph',
    description: 'Get tasks + dependencies as a DAG suitable for visualization. Returns nodes and edges.',
    schema: {
      status: z.string().optional().describe('CSV of statuses to include (e.g. "open,claimed")'),
      workflow_run_id: z.number().optional().describe('Filter to only tasks in this workflow run'),
      limit: z.number().optional().describe('Max nodes (default 100, max 500)'),
    },
    tier: 'persist',
    handler: async (ctx, params) => {
      return getTaskGraph(ctx.db, ctx.workspaceId, params as unknown as GetTaskGraphInput);
    },
  },
];
