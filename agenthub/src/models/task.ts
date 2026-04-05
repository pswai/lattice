import type Database from 'better-sqlite3';
import type { Task, TaskStatus, TaskPriority, CreateTaskInput, UpdateTaskInput, CreateTaskResponse, UpdateTaskResponse } from './types.js';
import { TaskConflictError, InvalidTransitionError, NotFoundError, ForbiddenError, ValidationError } from '../errors.js';
import { broadcastInternal } from './event.js';
import { saveContext } from './context.js';
import { checkWorkflowCompletion } from './workflow.js';
import { incrementUsage } from './usage.js';

interface TaskRow {
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
}

function rowToTask(row: TaskRow): Task {
  return {
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
  };
}

// Valid state transitions: from → allowed to states
const VALID_TRANSITIONS: Record<string, string[]> = {
  open: ['claimed'],
  claimed: ['completed', 'escalated', 'abandoned'],
  abandoned: ['claimed'],
};

export function getTask(
  db: Database.Database,
  teamId: string,
  taskId: number,
): Task {
  const row = db.prepare(
    'SELECT * FROM tasks WHERE id = ? AND team_id = ?',
  ).get(taskId, teamId) as TaskRow | undefined;

  if (!row) {
    throw new NotFoundError('Task', taskId);
  }

  return rowToTask(row);
}

export interface ListTasksInput {
  status?: string;
  claimed_by?: string;
  assigned_to?: string;
  limit?: number;
}

export function listTasks(
  db: Database.Database,
  teamId: string,
  input: ListTasksInput,
): { tasks: Task[]; total: number } {
  const limit = Math.min(input.limit ?? 50, 200);
  const conditions = ['team_id = ?'];
  const params: (string | number)[] = [teamId];

  if (input.status) {
    conditions.push('status = ?');
    params.push(input.status);
  }

  if (input.claimed_by) {
    conditions.push('claimed_by = ?');
    params.push(input.claimed_by);
  }

  if (input.assigned_to) {
    conditions.push('assigned_to = ?');
    params.push(input.assigned_to);
  }

  params.push(limit);

  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE ${conditions.join(' AND ')}
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `).all(...params) as TaskRow[];

  return {
    tasks: rows.map(rowToTask),
    total: rows.length,
  };
}

export interface TaskGraphNode {
  id: number;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo: string | null;
  claimedBy: string | null;
  createdAt: string;
}

export interface TaskGraphEdge {
  from: number;
  to: number;
}

export interface GetTaskGraphInput {
  status?: string;
  workflow_run_id?: number;
  limit?: number;
}

export function getTaskGraph(
  db: Database.Database,
  teamId: string,
  input: GetTaskGraphInput,
): { nodes: TaskGraphNode[]; edges: TaskGraphEdge[] } {
  const limit = Math.min(input.limit ?? 100, 500);
  const conditions = ['t.team_id = ?'];
  const params: (string | number)[] = [teamId];

  if (input.status) {
    const statuses = input.status
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      conditions.push(`t.status IN (${placeholders})`);
      params.push(...statuses);
    }
  }

  let sql: string;
  if (input.workflow_run_id !== undefined) {
    sql = `
      SELECT t.id, t.description, t.status, t.priority, t.assigned_to, t.claimed_by, t.created_at
      FROM tasks t
      JOIN workflow_runs wr ON wr.team_id = t.team_id AND wr.id = ?
      WHERE ${conditions.join(' AND ')}
        AND EXISTS (SELECT 1 FROM json_each(wr.task_ids) WHERE value = t.id)
      ORDER BY t.priority ASC, t.created_at ASC
      LIMIT ?
    `;
    params.unshift(input.workflow_run_id);
    params.push(limit);
  } else {
    sql = `
      SELECT t.id, t.description, t.status, t.priority, t.assigned_to, t.claimed_by, t.created_at
      FROM tasks t
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.priority ASC, t.created_at ASC
      LIMIT ?
    `;
    params.push(limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    description: string;
    status: string;
    priority: string;
    assigned_to: string | null;
    claimed_by: string | null;
    created_at: string;
  }>;

  const nodes: TaskGraphNode[] = rows.map((r) => ({
    id: r.id,
    description: r.description,
    status: r.status as TaskStatus,
    priority: r.priority as TaskPriority,
    assignedTo: r.assigned_to,
    claimedBy: r.claimed_by,
    createdAt: r.created_at,
  }));

  if (nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeIds = nodes.map((n) => n.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const edgeRows = db.prepare(`
    SELECT task_id, depends_on FROM task_dependencies
    WHERE task_id IN (${placeholders}) AND depends_on IN (${placeholders})
  `).all(...nodeIds, ...nodeIds) as Array<{ task_id: number; depends_on: number }>;

  const edges: TaskGraphEdge[] = edgeRows.map((e) => ({
    from: e.depends_on,
    to: e.task_id,
  }));

  return { nodes, edges };
}

export function createTask(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: CreateTaskInput,
): CreateTaskResponse {
  const status = input.status ?? 'claimed';
  const priority = input.priority ?? 'P2';
  const assignedTo = input.assigned_to ?? null;
  // When the task is auto-claimed at creation, prefer the assigned agent —
  // otherwise the creator holds the claim and the assignee can't complete it.
  const claimedBy = status === 'claimed' ? (assignedTo ?? agentId) : null;
  const claimedAt = status === 'claimed' ? new Date().toISOString() : null;

  const result = db.prepare(`
    INSERT INTO tasks (team_id, description, status, created_by, claimed_by, claimed_at, priority, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(teamId, input.description, status, agentId, claimedBy, claimedAt, priority, assignedTo);

  const taskId = Number(result.lastInsertRowid);

  // Insert task dependencies if provided
  if (input.depends_on && input.depends_on.length > 0) {
    const insertDep = db.prepare(
      'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
    );
    for (const depId of input.depends_on) {
      insertDep.run(taskId, depId);
    }
  }

  // Auto-broadcast TASK_UPDATE event
  broadcastInternal(
    db, teamId, 'TASK_UPDATE',
    `Task #${taskId} created: "${input.description}" (status: ${status})`,
    ['task-update'], agentId,
  );

  // Billing: count task creation as one execution.
  incrementUsage(db, teamId, { exec: 1 });

  return {
    task_id: taskId,
    status,
    claimed_by: claimedBy,
  };
}

export function updateTask(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: UpdateTaskInput,
): UpdateTaskResponse {
  // Fetch current task
  const row = db.prepare(
    'SELECT * FROM tasks WHERE id = ? AND team_id = ?',
  ).get(input.task_id, teamId) as TaskRow | undefined;

  if (!row) {
    throw new NotFoundError('Task', input.task_id);
  }

  const task = rowToTask(row);

  // Check version FIRST — surface concurrency conflicts before anything else
  if (task.version !== input.version) {
    throw new TaskConflictError(task.version, input.version);
  }

  // Validate state transition
  const allowed = VALID_TRANSITIONS[task.status];
  if (!allowed || !allowed.includes(input.status)) {
    throw new InvalidTransitionError(task.status, input.status);
  }

  // Authorization: only claimed_by agent can complete/escalate/abandon (unless reaper)
  if (
    task.status === 'claimed' &&
    ['completed', 'escalated', 'abandoned'].includes(input.status) &&
    task.claimedBy !== agentId &&
    agentId !== 'system:reaper'
  ) {
    throw new ForbiddenError(`Only the claiming agent (${task.claimedBy}) can ${input.status} this task.`);
  }

  // Check dependencies before allowing claim
  if (input.status === 'claimed') {
    const blockers = db.prepare(`
      SELECT t.id, t.description, t.status FROM task_dependencies td
      JOIN tasks t ON t.id = td.depends_on
      WHERE td.task_id = ? AND t.status != 'completed'
    `).all(input.task_id) as Array<{ id: number; description: string; status: string }>;

    if (blockers.length > 0) {
      const blockerList = blockers.map(b => `#${b.id} (${b.status})`).join(', ');
      throw new ValidationError(`Cannot claim: blocked by uncompleted tasks: ${blockerList}`);
    }
  }

  // Build update fields based on new status
  let claimedBy = task.claimedBy;
  let claimedAt = task.claimedAt;
  const resultText = input.result ?? task.result;
  const priority = input.priority ?? task.priority;
  const assignedTo =
    input.assigned_to === undefined ? task.assignedTo : input.assigned_to;

  if (input.status === 'claimed') {
    claimedBy = agentId;
    claimedAt = new Date().toISOString();
  } else if (input.status === 'abandoned') {
    claimedBy = null;
    claimedAt = null;
  }

  // Optimistic lock update
  const updateResult = db.prepare(`
    UPDATE tasks
    SET status = ?,
        result = ?,
        claimed_by = ?,
        claimed_at = ?,
        priority = ?,
        assigned_to = ?,
        version = version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND version = ?
  `).run(input.status, resultText, claimedBy, claimedAt, priority, assignedTo, input.task_id, input.version);

  if (updateResult.changes === 0) {
    // Re-fetch to get current version for error message
    const current = db.prepare('SELECT version FROM tasks WHERE id = ?').get(input.task_id) as { version: number };
    throw new TaskConflictError(current.version, input.version);
  }

  const newVersion = input.version + 1;

  // Side effects based on new status
  if (input.status === 'completed') {
    broadcastInternal(
      db, teamId, 'TASK_UPDATE',
      `Task #${input.task_id} completed by ${agentId}: ${resultText ?? '(no result)'}`,
      ['task-update'], agentId,
    );
    // Save result as context entry
    if (resultText) {
      saveContext(db, teamId, agentId, {
        key: `task-result-${input.task_id}`,
        value: resultText,
        tags: ['task-result'],
      });
    }
  } else if (input.status === 'escalated') {
    broadcastInternal(
      db, teamId, 'ESCALATION',
      `Task #${input.task_id} escalated by ${agentId}: ${resultText ?? '(no reason)'}`,
      ['task-escalation'], agentId,
    );
  } else if (input.status === 'abandoned') {
    broadcastInternal(
      db, teamId, 'TASK_UPDATE',
      `Task #${input.task_id} abandoned by ${agentId}`,
      ['task-update'], agentId,
    );
  } else if (input.status === 'claimed') {
    broadcastInternal(
      db, teamId, 'TASK_UPDATE',
      `Task #${input.task_id} claimed by ${agentId}`,
      ['task-update'], agentId,
    );
  }

  // Update workflow_run status if this task belongs to one
  checkWorkflowCompletion(db, input.task_id);

  return {
    task_id: input.task_id,
    status: input.status,
    version: newVersion,
  };
}
