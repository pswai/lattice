import type Database from 'better-sqlite3';
import type { ContextEntry, Event, Task, Message, EventType, TaskStatus, TaskPriority } from './types.js';
import type { Agent, AgentStatus } from './agent.js';
import type { Playbook, PlaybookTaskTemplate } from './playbook.js';
import type { WorkflowRun, WorkflowRunStatus } from './workflow.js';
import type { AgentProfile } from './profile.js';
import type { Schedule } from './schedule.js';

export const EXPORT_VERSION = '1';
export const EVENT_EXPORT_LIMIT = 1000;
export const REDACTED = '[REDACTED]';

export interface ExportedArtifact {
  id: number;
  key: string;
  content_type: string;
  size: number;
  created_by: string;
  created_at: string;
}

export interface ExportedInboundEndpoint {
  id: number;
  name: string;
  action_type: string;
  action_config: Record<string, unknown>;
  endpoint_key: string; // redacted
  hmac_secret: string | null; // redacted if present
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ExportedWebhook {
  id: string;
  url: string;
  secret: string; // redacted
  event_types: string[];
  active: boolean;
  failure_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ExportedTaskDependency {
  task_id: number;
  depends_on: number;
}

export interface ExportCounts {
  context_entries: number;
  events: number;
  tasks: number;
  task_dependencies: number;
  agents: number;
  messages: number;
  artifacts: number;
  playbooks: number;
  workflow_runs: number;
  agent_profiles: number;
  schedules: number;
  inbound_endpoints: number;
  webhooks: number;
}

export interface TeamDataExport {
  version: string;
  team_id: string;
  exported_at: string;
  counts: ExportCounts;
  context_entries: ContextEntry[];
  events: Event[];
  tasks: Task[];
  task_dependencies: ExportedTaskDependency[];
  agents: Agent[];
  messages: Message[];
  artifacts: ExportedArtifact[];
  playbooks: Playbook[];
  workflow_runs: WorkflowRun[];
  agent_profiles: AgentProfile[];
  schedules: Schedule[];
  inbound_endpoints: ExportedInboundEndpoint[];
  webhooks: ExportedWebhook[];
}

function exportContextEntries(db: Database.Database, teamId: string): ContextEntry[] {
  const rows = db.prepare(
    'SELECT * FROM context_entries WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: number;
    team_id: string;
    key: string;
    value: string;
    tags: string;
    created_by: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    key: row.key,
    value: row.value,
    tags: JSON.parse(row.tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

function exportEvents(db: Database.Database, teamId: string): Event[] {
  // Last N events (most recent); return in chronological order
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT * FROM events WHERE team_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `).all(teamId, EVENT_EXPORT_LIMIT) as Array<{
    id: number;
    team_id: string;
    event_type: string;
    message: string;
    tags: string;
    created_by: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    eventType: row.event_type as EventType,
    message: row.message,
    tags: JSON.parse(row.tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

function exportTasks(db: Database.Database, teamId: string): Task[] {
  const rows = db.prepare(
    'SELECT * FROM tasks WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: number;
    team_id: string;
    description: string;
    status: string;
    result: string | null;
    created_by: string;
    claimed_by: string | null;
    claimed_at: string | null;
    version: number;
    priority: string;
    assigned_to: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    description: row.description,
    status: row.status as TaskStatus,
    result: row.result,
    createdBy: row.created_by,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    version: row.version,
    priority: row.priority as TaskPriority,
    assignedTo: row.assigned_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function exportTaskDependencies(db: Database.Database, teamId: string): ExportedTaskDependency[] {
  const rows = db.prepare(`
    SELECT td.task_id, td.depends_on
    FROM task_dependencies td
    JOIN tasks t ON t.id = td.task_id
    WHERE t.team_id = ?
    ORDER BY td.task_id ASC, td.depends_on ASC
  `).all(teamId) as Array<{ task_id: number; depends_on: number }>;
  return rows.map((r) => ({ task_id: r.task_id, depends_on: r.depends_on }));
}

function exportAgents(db: Database.Database, teamId: string): Agent[] {
  const rows = db.prepare(
    'SELECT * FROM agents WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: string;
    team_id: string;
    capabilities: string;
    status: string;
    metadata: string;
    last_heartbeat: string;
    registered_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    capabilities: JSON.parse(row.capabilities) as string[],
    status: row.status as AgentStatus,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    lastHeartbeat: row.last_heartbeat,
    registeredAt: row.registered_at,
  }));
}

function exportMessages(db: Database.Database, teamId: string): Message[] {
  const rows = db.prepare(
    'SELECT * FROM messages WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: number;
    team_id: string;
    from_agent: string;
    to_agent: string;
    message: string;
    tags: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    message: row.message,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
  }));
}

function exportArtifacts(db: Database.Database, teamId: string): ExportedArtifact[] {
  const rows = db.prepare(`
    SELECT id, key, content_type, size, created_by, created_at
    FROM artifacts WHERE team_id = ? ORDER BY id ASC
  `).all(teamId) as Array<{
    id: number;
    key: string;
    content_type: string;
    size: number;
    created_by: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    content_type: row.content_type,
    size: row.size,
    created_by: row.created_by,
    created_at: row.created_at,
  }));
}

function exportPlaybooks(db: Database.Database, teamId: string): Playbook[] {
  const rows = db.prepare(
    'SELECT * FROM playbooks WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: number;
    team_id: string;
    name: string;
    description: string;
    tasks_json: string;
    created_by: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    tasks: JSON.parse(row.tasks_json) as PlaybookTaskTemplate[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

function exportWorkflowRuns(db: Database.Database, teamId: string): WorkflowRun[] {
  const rows = db.prepare(
    'SELECT * FROM workflow_runs WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: number;
    team_id: string;
    playbook_name: string;
    started_by: string;
    task_ids: string;
    status: string;
    started_at: string;
    completed_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    playbookName: row.playbook_name,
    startedBy: row.started_by,
    taskIds: JSON.parse(row.task_ids) as number[],
    status: row.status as WorkflowRunStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

function exportAgentProfiles(db: Database.Database, teamId: string): AgentProfile[] {
  const rows = db.prepare(
    'SELECT * FROM agent_profiles WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: number;
    team_id: string;
    name: string;
    description: string;
    system_prompt: string;
    default_capabilities: string;
    default_tags: string;
    created_by: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    defaultCapabilities: JSON.parse(row.default_capabilities) as string[],
    defaultTags: JSON.parse(row.default_tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function exportSchedules(db: Database.Database, teamId: string): Schedule[] {
  const rows = db.prepare(
    'SELECT * FROM schedules WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: number;
    team_id: string;
    playbook_name: string;
    cron_expression: string;
    enabled: number;
    next_run_at: string | null;
    last_run_at: string | null;
    last_workflow_run_id: number | null;
    created_by: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    playbookName: row.playbook_name,
    cronExpression: row.cron_expression,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastWorkflowRunId: row.last_workflow_run_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function exportInboundEndpoints(db: Database.Database, teamId: string): ExportedInboundEndpoint[] {
  const rows = db.prepare(
    'SELECT * FROM inbound_endpoints WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as Array<{
    id: number;
    team_id: string;
    endpoint_key: string;
    name: string;
    action_type: string;
    action_config: string;
    hmac_secret: string | null;
    active: number;
    created_by: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    action_type: row.action_type,
    action_config: JSON.parse(row.action_config) as Record<string, unknown>,
    endpoint_key: REDACTED,
    hmac_secret: row.hmac_secret === null ? null : REDACTED,
    active: row.active === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

function exportWebhooks(db: Database.Database, teamId: string): ExportedWebhook[] {
  const rows = db.prepare(
    'SELECT * FROM webhooks WHERE team_id = ? ORDER BY created_at ASC',
  ).all(teamId) as Array<{
    id: string;
    team_id: string;
    url: string;
    secret: string;
    event_types: string;
    active: number;
    failure_count: number;
    created_by: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    secret: REDACTED,
    event_types: JSON.parse(row.event_types) as string[],
    active: row.active === 1,
    failure_count: row.failure_count,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function exportTeamData(db: Database.Database, teamId: string): TeamDataExport {
  const context_entries = exportContextEntries(db, teamId);
  const events = exportEvents(db, teamId);
  const tasks = exportTasks(db, teamId);
  const task_dependencies = exportTaskDependencies(db, teamId);
  const agents = exportAgents(db, teamId);
  const messages = exportMessages(db, teamId);
  const artifacts = exportArtifacts(db, teamId);
  const playbooks = exportPlaybooks(db, teamId);
  const workflow_runs = exportWorkflowRuns(db, teamId);
  const agent_profiles = exportAgentProfiles(db, teamId);
  const schedules = exportSchedules(db, teamId);
  const inbound_endpoints = exportInboundEndpoints(db, teamId);
  const webhooks = exportWebhooks(db, teamId);

  return {
    version: EXPORT_VERSION,
    team_id: teamId,
    exported_at: new Date().toISOString(),
    counts: {
      context_entries: context_entries.length,
      events: events.length,
      tasks: tasks.length,
      task_dependencies: task_dependencies.length,
      agents: agents.length,
      messages: messages.length,
      artifacts: artifacts.length,
      playbooks: playbooks.length,
      workflow_runs: workflow_runs.length,
      agent_profiles: agent_profiles.length,
      schedules: schedules.length,
      inbound_endpoints: inbound_endpoints.length,
      webhooks: webhooks.length,
    },
    context_entries,
    events,
    tasks,
    task_dependencies,
    agents,
    messages,
    artifacts,
    playbooks,
    workflow_runs,
    agent_profiles,
    schedules,
    inbound_endpoints,
    webhooks,
  };
}
