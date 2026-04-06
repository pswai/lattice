import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DbAdapter } from '../db/adapter.js';
import { z } from 'zod';
import { saveContext, getContext } from '../models/context.js';
import { broadcastEvent, getUpdates, waitForEvent } from '../models/event.js';
import { createTask, updateTask, listTasks, getTask, getTaskGraph } from '../models/task.js';
import { registerAgent, heartbeat, listAgents, autoRegisterAgent } from '../models/agent.js';
import { sendMessage, getMessages } from '../models/message.js';
import { definePlaybook, listPlaybooks, runPlaybook } from '../models/playbook.js';
import { defineSchedule, listSchedules, deleteSchedule } from '../models/schedule.js';
import { listWorkflowRuns, getWorkflowRun, type WorkflowRunStatus } from '../models/workflow.js';
import { getWorkspaceAnalytics, parseSinceDuration } from '../models/analytics.js';
import { saveArtifact, getArtifact, listArtifacts } from '../models/artifact.js';
import { defineProfile, listProfiles, getProfile, deleteProfile } from '../models/profile.js';
import {
  defineInboundEndpoint,
  listInboundEndpoints,
  deleteInboundEndpoint,
  type InboundActionType,
} from '../models/inbound.js';
import { exportWorkspaceData } from '../models/export.js';
import { scanForSecrets } from '../services/secret-scanner.js';
import { AppError, SecretDetectedError } from '../errors.js';
import { getMcpAuth } from './auth-context.js';
import { writeAudit } from '../models/audit.js';
import { incrementUsage } from '../models/usage.js';
import { getLogger } from '../logger.js';

/**
 * Wrap an array schema so that MCP clients which stringify array arguments
 * (a known JSON-RPC transport quirk) still pass validation. Empty string
 * coerces to [], and JSON strings are parsed before validation runs.
 */
function arrayParam<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      if (v === '') return [];
      try { return JSON.parse(v); } catch { return v; /* let zod reject */ }
    },
    schema,
  );
}

function errorResult(err: AppError) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
    isError: true,
  };
}

export function createMcpServer(db: DbAdapter): McpServer {
  const server = new McpServer({
    name: 'lattice',
    version: '0.1.0',
  });

  // ─── Audit wrapper for mutating MCP tools ─────────────────────────
  const TOOL_AUDIT_MAP: Record<string, { resource: string; verb: string }> = {
    save_context: { resource: 'context', verb: 'create' },
    broadcast: { resource: 'event', verb: 'create' },
    create_task: { resource: 'task', verb: 'create' },
    update_task: { resource: 'task', verb: 'update' },
    register_agent: { resource: 'agent', verb: 'create' },
    send_message: { resource: 'message', verb: 'create' },
    define_playbook: { resource: 'playbook', verb: 'create' },
    run_playbook: { resource: 'workflow_run', verb: 'create' },
    define_schedule: { resource: 'schedule', verb: 'create' },
    delete_schedule: { resource: 'schedule', verb: 'delete' },
    save_artifact: { resource: 'artifact', verb: 'create' },
    define_profile: { resource: 'profile', verb: 'create' },
    delete_profile: { resource: 'profile', verb: 'delete' },
    define_inbound_endpoint: { resource: 'inbound_endpoint', verb: 'create' },
    delete_inbound_endpoint: { resource: 'inbound_endpoint', verb: 'delete' },
  };

  /**
   * Register a tool that also writes an audit log entry on success.
   * Signature mirrors server.tool() — drop-in replacement for mutating tools.
   */
  /**
   * Fire-and-forget audit log entry for a successful MCP tool call.
   * Never throws — audit failures are logged but do not break the request.
   */
  async function mcpAudit(toolName: string, actorOverride?: string): Promise<void> {
    try {
      const auth = getMcpAuth();
      const mapping = TOOL_AUDIT_MAP[toolName];
      const action = mapping ? `${mapping.resource}.${mapping.verb}` : toolName;
      await Promise.all([
        writeAudit(db, {
          workspaceId: auth.workspaceId,
          actor: actorOverride || auth.agentId,
          action,
          resourceType: mapping?.resource ?? null,
          resourceId: null,
          metadata: { source: 'mcp', tool: toolName },
          ip: auth.ip ?? null,
          requestId: auth.requestId ?? null,
        }),
        incrementUsage(db, auth.workspaceId, { apiCall: 1 }),
      ]);
    } catch (err) {
      try {
        getLogger().error('mcp_audit_write_failed', {
          component: 'audit',
          tool: toolName,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch { /* swallow logger failures */ }
    }
  }

  // ─── save_context ─────────────────────────────────────────────────
  server.tool(
    'save_context',
    'Persist a learning or context entry to the shared team knowledge base. Pre-write secret scanning blocks entries containing API keys.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      key: z.string().min(1).max(255).describe('Unique identifier for this context entry'),
      value: z.string().min(1).max(100_000).describe('The context content to save'),
      tags: arrayParam(z.array(z.string().max(50)).max(20)).optional().default([]).describe('Tags for categorization and filtering'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        // Secret scan on key and value
        for (const field of [params.key, params.value]) {
          const scan = scanForSecrets(field);
          if (!scan.clean) {
            return errorResult(new SecretDetectedError(scan.matches[0].pattern, scan.matches[0].preview));
          }
        }

        // saveContext handles both DB write and auto-broadcast of LEARNING event
        const result = await saveContext(db, workspaceId, agentId, params);
        await mcpAudit('save_context', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_context ──────────────────────────────────────────────────
  server.tool(
    'get_context',
    'Search the shared team knowledge base using full-text search and optional tag filtering.',
    {
      query: z.string().describe('Full-text search query'),
      tags: arrayParam(z.array(z.string())).optional().default([]).describe('Optional tag filter (OR matching)'),
      limit: z.number().optional().describe('Max results (default 20, max 100)'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        // Validation (query or tags required) is enforced in the model layer
        const result = await getContext(db, workspaceId, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── broadcast ────────────────────────────────────────────────────
  server.tool(
    'broadcast',
    'Push an event to the team messaging bus. Other agents receive it on their next poll.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      event_type: z.enum(['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE']).describe('Type of event'),
      message: z.string().min(1).max(10_000).describe('Event message content'),
      tags: arrayParam(z.array(z.string().max(50)).max(20)).optional().default([]).describe('Tags for topic-based filtering'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const scan = scanForSecrets(params.message);
        if (!scan.clean) {
          return errorResult(new SecretDetectedError(scan.matches[0].pattern, scan.matches[0].preview));
        }

        const result = await broadcastEvent(db, workspaceId, agentId, params);
        await mcpAudit('broadcast', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_updates ──────────────────────────────────────────────────
  server.tool(
    'get_updates',
    'Poll for events since your last check. Use the returned cursor as since_id on your next call.',
    {
      since_id: z.number().optional().describe('Return events after this ID'),
      since_timestamp: z.string().optional().describe('Fallback: ISO 8601 timestamp'),
      topics: arrayParam(z.array(z.string())).optional().default([]).describe('Optional topic filter'),
      limit: z.number().optional().describe('Max events to return (default 50, max 200)'),
      include_context: z.boolean().optional().describe('Include recommended_context (default true)'),
    },
    async (params) => {
      const { workspaceId, agentId } = getMcpAuth();

      try {
        const result = await getUpdates(db, workspaceId, { ...params, agent_id: agentId });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── wait_for_event ───────────────────────────────────────────────
  server.tool(
    'wait_for_event',
    'Long-poll: block until a matching event arrives after since_id, or until timeout. Returns immediately if matching events already exist.',
    {
      since_id: z.number().int().nonnegative().describe('Wait for events with id > since_id'),
      topics: arrayParam(z.array(z.string())).optional().default([]).describe('Optional topic/tag filter (OR matching)'),
      event_type: z.enum(['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE']).optional().describe('Optional event type filter'),
      timeout_sec: z.number().int().nonnegative().max(60).optional().describe('Max seconds to wait (default 30, max 60)'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await waitForEvent(db, workspaceId, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── create_task ──────────────────────────────────────────────────
  server.tool(
    'create_task',
    'Create a work item visible to all agents. Defaults to auto-claiming for the creator.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      description: z.string().min(1).max(10_000).describe('What needs to be done'),
      status: z.enum(['open', 'claimed']).optional().describe('Initial status (default: claimed)'),
      depends_on: arrayParam(z.array(z.number()).max(100)).optional().default([]).describe('Task IDs that must complete before this task can be claimed'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Priority: P0 (highest) through P3 (lowest). Default P2.'),
      assigned_to: z.string().max(100).optional().describe('Agent ID this task is assigned to'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await createTask(db, workspaceId, agentId, params);
        await mcpAudit('create_task', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── update_task ──────────────────────────────────────────────────
  server.tool(
    'update_task',
    'Update a task status. Uses optimistic locking — include the current version number.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      task_id: z.number().describe('Task ID to update'),
      status: z.enum(['claimed', 'completed', 'escalated', 'abandoned']).describe('New status'),
      result: z.string().optional().describe('Completion result or escalation reason'),
      version: z.number().int().nonnegative().describe('Current version for optimistic locking'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Update priority'),
      assigned_to: z.string().max(100).nullable().optional().describe('Reassign to agent, or null to unassign'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await updateTask(db, workspaceId, agentId, params);
        await mcpAudit('update_task', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── list_tasks ───────────────────────────────────────────────────
  server.tool(
    'list_tasks',
    'List tasks visible to the team, optionally filtered by status or claimed_by.',
    {
      status: z.enum(['open', 'claimed', 'completed', 'escalated', 'abandoned']).optional().describe('Filter by task status'),
      claimed_by: z.string().optional().describe('Filter by claiming agent ID'),
      assigned_to: z.string().optional().describe('Filter by assigned agent ID'),
      limit: z.number().optional().describe('Max results (default 50, max 200)'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await listTasks(db, workspaceId, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_task ────────────────────────────────────────────────────
  server.tool(
    'get_task',
    'Get a single task by ID with full details.',
    {
      task_id: z.number().describe('Task ID to retrieve'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const task = await getTask(db, workspaceId, params.task_id);
        return { content: [{ type: 'text', text: JSON.stringify(task) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_task_graph ───────────────────────────────────────────────
  server.tool(
    'get_task_graph',
    'Get tasks + dependencies as a DAG suitable for visualization. Returns nodes and edges.',
    {
      status: z.string().optional().describe('CSV of statuses to include (e.g. "open,claimed")'),
      workflow_run_id: z.number().optional().describe('Filter to only tasks in this workflow run'),
      limit: z.number().optional().describe('Max nodes (default 100, max 500)'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await getTaskGraph(db, workspaceId, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── register_agent ────────────────────────────────────────────────
  server.tool(
    'register_agent',
    'Register this agent in the team registry with its capabilities. Enables other agents to discover what you can do.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      capabilities: arrayParam(z.array(z.string().max(100)).max(50)).optional().default([]).describe('List of capabilities (e.g. "python", "code-review", "data-analysis")'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Agent status (default: online)'),
      metadata: z.record(z.unknown()).optional().refine(
        (v) => v === undefined || JSON.stringify(v).length <= 10_240,
        { message: 'metadata must be under 10 KB when serialized' },
      ).describe('Optional metadata about this agent'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await registerAgent(db, workspaceId, params);
        await mcpAudit('register_agent', params.agent_id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── list_agents ──────────────────────────────────────────────────
  server.tool(
    'list_agents',
    'Discover agents registered in your team. Filter by capability or status to find the right collaborator.',
    {
      capability: z.string().optional().describe('Filter by a specific capability'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Filter by status'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await listAgents(db, workspaceId, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── heartbeat ────────────────────────────────────────────────────
  server.tool(
    'heartbeat',
    'Send a heartbeat to keep your agent status as online. Agents that stop sending heartbeats are marked offline.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Optionally update your status'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      await autoRegisterAgent(db, workspaceId, params.agent_id);

      try {
        const result = await heartbeat(db, workspaceId, params.agent_id, params.status);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── send_message ──────────────────────────────────────────────────
  server.tool(
    'send_message',
    'Send a message to a specific agent.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (the sender)'),
      to: z.string().min(1).max(100).describe('Recipient agent ID'),
      message: z.string().min(1).max(10_000).describe('Message text'),
      tags: arrayParam(z.array(z.string().max(50)).max(20)).optional().default([]).describe('Tags for categorization'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await sendMessage(db, workspaceId, agentId, {
          to: params.to,
          message: params.message,
          tags: params.tags,
        });
        await mcpAudit('send_message', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_messages ─────────────────────────────────────────────────
  server.tool(
    'get_messages',
    'Get messages sent to you.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (the recipient)'),
      since_id: z.number().optional().describe('Return messages after this ID'),
      limit: z.number().optional().describe('Max messages to return (default 50, max 200)'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;

      try {
        const result = await getMessages(db, workspaceId, agentId, {
          since_id: params.since_id,
          limit: params.limit,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── define_playbook ──────────────────────────────────────────────
  server.tool(
    'define_playbook',
    'Define (or update) a reusable playbook: a named bundle of task templates that can be instantiated as real tasks via run_playbook.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(100).describe('Playbook name (unique per team)'),
      description: z.string().min(1).max(10_000).describe('What this playbook accomplishes'),
      tasks: arrayParam(z.array(z.object({
        description: z.string().min(1).max(10_000),
        role: z.string().max(100).optional(),
        depends_on_index: arrayParam(z.array(z.number().int().nonnegative())).optional().default([]),
      }))).describe('Ordered task templates. depends_on_index references earlier templates by position.'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await definePlaybook(db, workspaceId, agentId, {
          name: params.name,
          description: params.description,
          tasks: params.tasks,
        });
        await mcpAudit('define_playbook', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── list_playbooks ───────────────────────────────────────────────
  server.tool(
    'list_playbooks',
    'List all playbooks defined for your team.',
    {},
    async () => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await listPlaybooks(db, workspaceId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── run_playbook ─────────────────────────────────────────────────
  server.tool(
    'run_playbook',
    'Instantiate a playbook: creates real tasks from the templates and wires up depends_on_index into task dependencies. Returns the created task IDs.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(100).describe('Playbook name to run'),
      vars: z.record(z.string().max(10_000)).optional().describe('Template variables substituted into task descriptions — replaces {{vars.KEY}} with the value'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await runPlaybook(db, workspaceId, agentId, params.name, params.vars);
        await mcpAudit('run_playbook', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── define_schedule ──────────────────────────────────────────────
  server.tool(
    'define_schedule',
    'Define (or update) a recurring schedule that runs a playbook on a cron expression. Supported patterns: "*/N * * * *" (every N minutes), "0 */N * * *" (every N hours), "0 N * * *" (daily at hour N), "0 H * * D" (weekly on day D at hour H).',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      playbook_name: z.string().min(1).max(100).describe('Name of an existing playbook'),
      cron_expression: z.string().min(1).max(100).describe('Cron expression (supported subset, UTC): "*/N * * * *" every N min (e.g. "*/15 * * * *"), "0 */N * * *" every N hours (e.g. "0 */6 * * *"), "0 N * * *" daily at N:00 UTC (e.g. "0 9 * * *"), "0 H * * D" weekly on day D at H:00 UTC (Sun=0, e.g. "0 14 * * 1" Mon 14:00).'),
      enabled: z.boolean().optional().describe('Whether the schedule is active (default true)'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await defineSchedule(db, workspaceId, agentId, {
          playbook_name: params.playbook_name,
          cron_expression: params.cron_expression,
          enabled: params.enabled,
        });
        await mcpAudit('define_schedule', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── list_schedules ───────────────────────────────────────────────
  server.tool(
    'list_schedules',
    'List all schedules defined for your team.',
    {},
    async () => {
      const { workspaceId } = getMcpAuth();
      try {
        const result = await listSchedules(db, workspaceId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── delete_schedule ──────────────────────────────────────────────
  server.tool(
    'delete_schedule',
    'Delete a schedule by ID.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      id: z.number().int().positive().describe('Schedule ID to delete'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);
      try {
        const result = await deleteSchedule(db, workspaceId, params.id);
        await mcpAudit('delete_schedule', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── list_workflow_runs ───────────────────────────────────────────
  server.tool(
    'list_workflow_runs',
    'List playbook workflow executions for your team, optionally filtered by status (running/completed/failed).',
    {
      status: z.enum(['running', 'completed', 'failed']).optional().describe('Filter by run status'),
      limit: z.number().int().positive().max(200).optional().describe('Max results (default 50, max 200)'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await listWorkflowRuns(db, workspaceId, {
          status: params.status as WorkflowRunStatus | undefined,
          limit: params.limit,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_workflow_run ─────────────────────────────────────────────
  server.tool(
    'get_workflow_run',
    'Get full details of a single workflow run, including the current status of each task it created.',
    {
      id: z.number().int().positive().describe('Workflow run ID'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await getWorkflowRun(db, workspaceId, params.id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── save_artifact ────────────────────────────────────────────────
  server.tool(
    'save_artifact',
    'Save a typed artifact (HTML, JSON, markdown, code, etc.) to team storage. Separate from context — artifacts are for structured file outputs, not learnings. Max 1 MB.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      key: z.string().min(1).max(255).describe('Unique artifact key (per team)'),
      content_type: z.enum([
        'text/plain', 'text/markdown', 'text/html', 'application/json',
        'text/x-typescript', 'text/x-javascript', 'text/x-python', 'text/css',
      ]).describe('MIME content type'),
      content: z.string().min(1).max(1_048_576).describe('Artifact content (max 1 MB)'),
      metadata: z.record(z.unknown()).optional().describe('Optional structured metadata'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await saveArtifact(db, workspaceId, agentId, {
          key: params.key,
          content_type: params.content_type,
          content: params.content,
          metadata: params.metadata,
        });
        await mcpAudit('save_artifact', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_artifact ─────────────────────────────────────────────────
  server.tool(
    'get_artifact',
    'Retrieve a single artifact by key, including full content.',
    {
      key: z.string().min(1).max(255).describe('Artifact key'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await getArtifact(db, workspaceId, params.key);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── list_artifacts ───────────────────────────────────────────────
  server.tool(
    'list_artifacts',
    'List artifacts in team storage (metadata only — no content). Filter by content_type.',
    {
      content_type: z.enum([
        'text/plain', 'text/markdown', 'text/html', 'application/json',
        'text/x-typescript', 'text/x-javascript', 'text/x-python', 'text/css',
      ]).optional().describe('Optional content_type filter'),
      limit: z.number().optional().describe('Max results (default 50, max 200)'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await listArtifacts(db, workspaceId, {
          content_type: params.content_type,
          limit: params.limit,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_analytics ────────────────────────────────────────────────
  server.tool(
    'get_analytics',
    'Get aggregated team analytics (tasks, events, agents, context, messages) in a single call. Filter by a duration like "24h", "7d", "30d".',
    {
      since: z.string().optional().describe('Duration window, e.g. "24h" (default), "7d", "30d"'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const sinceIso = parseSinceDuration(params.since);
        const result = await getWorkspaceAnalytics(db, workspaceId, sinceIso);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        if (err instanceof Error) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'VALIDATION_ERROR', message: err.message }) }], isError: true };
        }
        throw err;
      }
    },
  );

  // ─── define_profile ───────────────────────────────────────────────
  server.tool(
    'define_profile',
    'Define (or update) a reusable agent profile: a named role with a system prompt and default capabilities/tags. Profiles are centralized role definitions per team.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(100).describe('Profile name (unique per team)'),
      description: z.string().min(1).max(10_000).describe('Short description of this role'),
      system_prompt: z.string().min(1).max(100_000).describe('The system prompt defining this role'),
      default_capabilities: arrayParam(z.array(z.string().max(100)).max(50)).optional().default([]).describe('Default capability tags for agents adopting this profile'),
      default_tags: arrayParam(z.array(z.string().max(50)).max(20)).optional().default([]).describe('Default tags for events/messages from this role'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await defineProfile(db, workspaceId, agentId, {
          name: params.name,
          description: params.description,
          system_prompt: params.system_prompt,
          default_capabilities: params.default_capabilities,
          default_tags: params.default_tags,
        });
        await mcpAudit('define_profile', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── list_profiles ────────────────────────────────────────────────
  server.tool(
    'list_profiles',
    'List all agent profiles defined for your team.',
    {},
    async () => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await listProfiles(db, workspaceId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── get_profile ──────────────────────────────────────────────────
  server.tool(
    'get_profile',
    'Get a single agent profile by name, including its full system prompt.',
    {
      name: z.string().min(1).max(100).describe('Profile name'),
    },
    async (params) => {
      const { workspaceId } = getMcpAuth();

      try {
        const result = await getProfile(db, workspaceId, params.name);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── delete_profile ───────────────────────────────────────────────
  server.tool(
    'delete_profile',
    'Delete an agent profile by name.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      name: z.string().min(1).max(100).describe('Profile name to delete'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await deleteProfile(db, workspaceId, params.name);
        await mcpAudit('delete_profile', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── define_inbound_endpoint ──────────────────────────────────────
  server.tool(
    'define_inbound_endpoint',
    'Create an inbound webhook endpoint that lets external systems trigger Lattice actions (create_task, broadcast_event, save_context, run_playbook). Returns the endpoint_key — use it as the path segment in POST /api/v1/inbound/:endpoint_key.',
    {
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
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);

      try {
        const result = await defineInboundEndpoint(db, workspaceId, agentId, {
          name: params.name,
          action_type: params.action_type as InboundActionType,
          action_config: params.action_config,
          hmac_secret: params.hmac_secret,
        });
        await mcpAudit('define_inbound_endpoint', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── list_inbound_endpoints ───────────────────────────────────────
  server.tool(
    'list_inbound_endpoints',
    'List all inbound webhook endpoints defined for your team.',
    {},
    async () => {
      const { workspaceId } = getMcpAuth();
      try {
        const result = await listInboundEndpoints(db, workspaceId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── delete_inbound_endpoint ──────────────────────────────────────
  server.tool(
    'delete_inbound_endpoint',
    'Delete an inbound webhook endpoint by ID.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity'),
      endpoint_id: z.number().describe('Endpoint ID to delete'),
    },
    async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      await autoRegisterAgent(db, workspaceId, agentId);
      try {
        const result = await deleteInboundEndpoint(db, workspaceId, params.endpoint_id);
        await mcpAudit('delete_inbound_endpoint', agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── export_workspace_data ─────────────────────────────────────────────
  server.tool(
    'export_workspace_data',
    'Export a team snapshot for backup/portability. Returns all team data (context, events, tasks, agents, messages, artifacts metadata, playbooks, workflow runs, profiles, schedules, endpoints, webhooks). Secrets are redacted and artifact content is not included.',
    {},
    async () => {
      const { workspaceId } = getMcpAuth();
      try {
        const result = await exportWorkspaceData(db, workspaceId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  return server;
}
