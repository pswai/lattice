import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { saveContext, getContext } from '../models/context.js';
import { broadcastEvent, getUpdates, waitForEvent } from '../models/event.js';
import { createTask, updateTask, listTasks, getTask, getTaskGraph } from '../models/task.js';
import { registerAgent, heartbeat, listAgents, autoRegisterAgent } from '../models/agent.js';
import { sendMessage, getMessages } from '../models/message.js';
import { definePlaybook, listPlaybooks, runPlaybook } from '../models/playbook.js';
import { defineSchedule, listSchedules, deleteSchedule } from '../models/schedule.js';
import { listWorkflowRuns, getWorkflowRun, type WorkflowRunStatus } from '../models/workflow.js';
import { getTeamAnalytics, parseSinceDuration } from '../models/analytics.js';
import { saveArtifact, getArtifact, listArtifacts } from '../models/artifact.js';
import { defineProfile, listProfiles, getProfile, deleteProfile } from '../models/profile.js';
import {
  defineInboundEndpoint,
  listInboundEndpoints,
  deleteInboundEndpoint,
  type InboundActionType,
} from '../models/inbound.js';
import { exportTeamData } from '../models/export.js';
import { scanForSecrets } from '../services/secret-scanner.js';
import { AppError, SecretDetectedError } from '../errors.js';
import { getMcpAuth } from './auth-context.js';

function errorResult(err: AppError) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
    isError: true,
  };
}

export function createMcpServer(db: Database.Database): McpServer {
  const server = new McpServer({
    name: 'agenthub',
    version: '0.1.0',
  });

  // ─── save_context ─────────────────────────────────────────────────
  server.tool(
    'save_context',
    'Persist a learning or context entry to the shared team knowledge base. Pre-write secret scanning blocks entries containing API keys.',
    {
      agent_id: z.string().min(1).max(100).describe('Your agent identity (e.g. "researcher", "backend-eng")'),
      key: z.string().min(1).max(255).describe('Unique identifier for this context entry'),
      value: z.string().min(1).max(100_000).describe('The context content to save'),
      tags: z.array(z.string().max(50)).max(20).describe('Tags for categorization and filtering'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        // Secret scan on key and value
        for (const field of [params.key, params.value]) {
          const scan = scanForSecrets(field);
          if (!scan.clean) {
            return errorResult(new SecretDetectedError(scan.matches[0].pattern, scan.matches[0].preview));
          }
        }

        // saveContext handles both DB write and auto-broadcast of LEARNING event
        const result = saveContext(db, teamId, agentId, params);
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
      tags: z.array(z.string()).optional().describe('Optional tag filter (OR matching)'),
      limit: z.number().optional().describe('Max results (default 20, max 100)'),
    },
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        // Validation (query or tags required) is enforced in the model layer
        const result = getContext(db, teamId, params);
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
      tags: z.array(z.string().max(50)).max(20).describe('Tags for topic-based filtering'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const scan = scanForSecrets(params.message);
        if (!scan.clean) {
          return errorResult(new SecretDetectedError(scan.matches[0].pattern, scan.matches[0].preview));
        }

        const result = broadcastEvent(db, teamId, agentId, params);
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
      topics: z.array(z.string()).optional().describe('Optional topic filter'),
      limit: z.number().optional().describe('Max events to return (default 50, max 200)'),
      include_context: z.boolean().optional().describe('Include recommended_context (default true)'),
    },
    (params) => {
      const { teamId, agentId } = getMcpAuth();

      try {
        const result = getUpdates(db, teamId, { ...params, agent_id: agentId });
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
      topics: z.array(z.string()).optional().describe('Optional topic/tag filter (OR matching)'),
      event_type: z.enum(['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE']).optional().describe('Optional event type filter'),
      timeout_sec: z.number().int().nonnegative().max(60).optional().describe('Max seconds to wait (default 30, max 60)'),
    },
    async (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = await waitForEvent(db, teamId, params);
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
      depends_on: z.array(z.number()).optional().describe('Task IDs that must complete before this task can be claimed'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Priority: P0 (highest) through P3 (lowest). Default P2.'),
      assigned_to: z.string().max(100).optional().describe('Agent ID this task is assigned to'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = createTask(db, teamId, agentId, params);
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
      version: z.number().describe('Current version for optimistic locking'),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('Update priority'),
      assigned_to: z.string().max(100).nullable().optional().describe('Reassign to agent, or null to unassign'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = updateTask(db, teamId, agentId, params);
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = listTasks(db, teamId, params);
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const task = getTask(db, teamId, params.task_id);
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = getTaskGraph(db, teamId, params);
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
      capabilities: z.array(z.string().max(100)).max(50).describe('List of capabilities (e.g. "python", "code-review", "data-analysis")'),
      status: z.enum(['online', 'offline', 'busy']).optional().describe('Agent status (default: online)'),
      metadata: z.record(z.unknown()).optional().describe('Optional metadata about this agent'),
    },
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = registerAgent(db, teamId, params);
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = listAgents(db, teamId, params);
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
    (params) => {
      const { teamId } = getMcpAuth();

      autoRegisterAgent(db, teamId, params.agent_id);

      try {
        const result = heartbeat(db, teamId, params.agent_id, params.status);
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
      tags: z.array(z.string().max(50)).max(20).describe('Tags for categorization'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = sendMessage(db, teamId, agentId, {
          to: params.to,
          message: params.message,
          tags: params.tags,
        });
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
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;

      try {
        const result = getMessages(db, teamId, agentId, {
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
      tasks: z.array(z.object({
        description: z.string().min(1).max(10_000),
        role: z.string().max(100).optional(),
        depends_on_index: z.array(z.number().int().nonnegative()).optional(),
      })).describe('Ordered task templates. depends_on_index references earlier templates by position.'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = definePlaybook(db, teamId, agentId, {
          name: params.name,
          description: params.description,
          tasks: params.tasks,
        });
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
    () => {
      const { teamId } = getMcpAuth();

      try {
        const result = listPlaybooks(db, teamId);
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
      vars: z.record(z.string()).optional().describe('Template variables substituted into task descriptions — replaces {{vars.KEY}} with the value'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = runPlaybook(db, teamId, agentId, params.name, params.vars);
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
      cron_expression: z.string().min(1).max(100).describe('Cron expression (supported subset)'),
      enabled: z.boolean().optional().describe('Whether the schedule is active (default true)'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = defineSchedule(db, teamId, agentId, {
          playbook_name: params.playbook_name,
          cron_expression: params.cron_expression,
          enabled: params.enabled,
        });
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
    () => {
      const { teamId } = getMcpAuth();
      try {
        const result = listSchedules(db, teamId);
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
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);
      try {
        const result = deleteSchedule(db, teamId, params.id);
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = listWorkflowRuns(db, teamId, {
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = getWorkflowRun(db, teamId, params.id);
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
      content: z.string().min(1).describe('Artifact content (max 1 MB)'),
      metadata: z.record(z.unknown()).optional().describe('Optional structured metadata'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = saveArtifact(db, teamId, agentId, {
          key: params.key,
          content_type: params.content_type,
          content: params.content,
          metadata: params.metadata,
        });
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = getArtifact(db, teamId, params.key);
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = listArtifacts(db, teamId, {
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const sinceIso = parseSinceDuration(params.since);
        const result = getTeamAnalytics(db, teamId, sinceIso);
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
      default_capabilities: z.array(z.string().max(100)).max(50).optional().describe('Default capability tags for agents adopting this profile'),
      default_tags: z.array(z.string().max(50)).max(20).optional().describe('Default tags for events/messages from this role'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = defineProfile(db, teamId, agentId, {
          name: params.name,
          description: params.description,
          system_prompt: params.system_prompt,
          default_capabilities: params.default_capabilities,
          default_tags: params.default_tags,
        });
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
    () => {
      const { teamId } = getMcpAuth();

      try {
        const result = listProfiles(db, teamId);
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
    (params) => {
      const { teamId } = getMcpAuth();

      try {
        const result = getProfile(db, teamId, params.name);
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
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = deleteProfile(db, teamId, params.name);
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
    'Create an inbound webhook endpoint that lets external systems trigger AgentHub actions (create_task, broadcast_event, save_context, run_playbook). Returns the endpoint_key — use it as the path segment in POST /api/v1/inbound/:endpoint_key.',
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
        .describe('Optional HMAC-SHA256 secret — if set, requests must send X-AgentHub-Signature: sha256=<hex>'),
    },
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);

      try {
        const result = defineInboundEndpoint(db, teamId, agentId, {
          name: params.name,
          action_type: params.action_type as InboundActionType,
          action_config: params.action_config,
          hmac_secret: params.hmac_secret,
        });
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
    () => {
      const { teamId } = getMcpAuth();
      try {
        const result = listInboundEndpoints(db, teamId);
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
    (params) => {
      const { teamId, agentId: headerAgentId } = getMcpAuth();
      const agentId = params.agent_id || headerAgentId;
      autoRegisterAgent(db, teamId, agentId);
      try {
        const result = deleteInboundEndpoint(db, teamId, params.endpoint_id);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  // ─── export_team_data ─────────────────────────────────────────────
  server.tool(
    'export_team_data',
    'Export a team snapshot for backup/portability. Returns all team data (context, events, tasks, agents, messages, artifacts metadata, playbooks, workflow runs, profiles, schedules, endpoints, webhooks). Secrets are redacted and artifact content is not included.',
    {},
    () => {
      const { teamId } = getMcpAuth();
      try {
        const result = exportTeamData(db, teamId);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    },
  );

  return server;
}
