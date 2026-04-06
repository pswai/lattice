import type { DbAdapter } from '../db/adapter.js';
import { jsonArrayTable } from '../db/adapter.js';
import type { Task, TaskStatus, TaskPriority, CreateTaskInput, UpdateTaskInput, CreateTaskResponse, UpdateTaskResponse } from './types.js';
import { TaskConflictError, InvalidTransitionError, NotFoundError, ForbiddenError, ValidationError } from '../errors.js';
import { broadcastInternal } from './event.js';
import { saveContext } from './context.js';
import { checkWorkflowCompletion } from './workflow.js';
import { incrementUsage } from './usage.js';

interface TaskRow {
  id: number;
  workspace_id: string;
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
    workspaceId: row.workspace_id,
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

export async function getTask(
  db: DbAdapter,
  workspaceId: string,
  taskId: number,
): Promise<Task> {
  const row = await db.get<TaskRow>(
    'SELECT * FROM tasks WHERE id = ? AND workspace_id = ?',
    taskId, workspaceId,
  );

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

export async function listTasks(
  db: DbAdapter,
  workspaceId: string,
  input: ListTasksInput,
): Promise<{ tasks: Task[]; total: number }> {
  const limit = Math.min(input.limit ?? 50, 200);
  const conditions = ['workspace_id = ?'];
  const params: (string | number)[] = [workspaceId];

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

  const rows = await db.all<TaskRow>(`
    SELECT * FROM tasks
    WHERE ${conditions.join(' AND ')}
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `, ...params);

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

export async function getTaskGraph(
  db: DbAdapter,
  workspaceId: string,
  input: GetTaskGraphInput,
): Promise<{ nodes: TaskGraphNode[]; edges: TaskGraphEdge[] }> {
  const limit = Math.min(input.limit ?? 100, 500);
  const conditions = ['t.workspace_id = ?'];
  const params: (string | number)[] = [workspaceId];

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
      JOIN workflow_runs wr ON wr.workspace_id = t.workspace_id AND wr.id = ?
      WHERE ${conditions.join(' AND ')}
        AND EXISTS (SELECT 1 FROM ${jsonArrayTable(db.dialect, 'wr.task_ids')} WHERE value = t.id)
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

  const rows = await db.all<{
    id: number;
    description: string;
    status: string;
    priority: string;
    assigned_to: string | null;
    claimed_by: string | null;
    created_at: string;
  }>(sql, ...params);

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
  const edgeRows = await db.all<{ task_id: number; depends_on: number }>(`
    SELECT task_id, depends_on FROM task_dependencies
    WHERE task_id IN (${placeholders}) AND depends_on IN (${placeholders})
  `, ...nodeIds, ...nodeIds);

  const edges: TaskGraphEdge[] = edgeRows.map((e) => ({
    from: e.depends_on,
    to: e.task_id,
  }));

  return { nodes, edges };
}

export async function createTask(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: CreateTaskInput,
): Promise<CreateTaskResponse> {
  const status = input.status ?? 'claimed';
  const priority = input.priority ?? 'P2';
  const assignedTo = input.assigned_to ?? null;
  // When the task is auto-claimed at creation, prefer the assigned agent —
  // otherwise the creator holds the claim and the assignee can't complete it.
  const claimedBy = status === 'claimed' ? (assignedTo ?? agentId) : null;
  const claimedAt = status === 'claimed' ? new Date().toISOString() : null;

  const result = await db.run(`
    INSERT INTO tasks (workspace_id, description, status, created_by, claimed_by, claimed_at, priority, assigned_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, workspaceId, input.description, status, agentId, claimedBy, claimedAt, priority, assignedTo);

  const taskId = Number(result.lastInsertRowid);

  // Insert task dependencies if provided
  if (input.depends_on && input.depends_on.length > 0) {
    for (const depId of input.depends_on) {
      await db.run(
        'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
        taskId, depId,
      );
    }
  }

  // Auto-broadcast TASK_UPDATE event
  await broadcastInternal(
    db, workspaceId, 'TASK_UPDATE',
    `Task #${taskId} created: "${input.description}" (status: ${status})`,
    ['task-update'], agentId,
  );

  // Billing: count task creation as one execution.
  await incrementUsage(db, workspaceId, { exec: 1 });

  return {
    task_id: taskId,
    status,
    claimed_by: claimedBy,
  };
}

export async function updateTask(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: UpdateTaskInput,
): Promise<UpdateTaskResponse> {
  // Fetch current task
  const row = await db.get<TaskRow>(
    'SELECT * FROM tasks WHERE id = ? AND workspace_id = ?',
    input.task_id, workspaceId,
  );

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
    const blockers = await db.all<{ id: number; description: string; status: string }>(`
      SELECT t.id, t.description, t.status FROM task_dependencies td
      JOIN tasks t ON t.id = td.depends_on
      WHERE td.task_id = ? AND t.status != 'completed'
    `, input.task_id);

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
  const updateResult = await db.run(`
    UPDATE tasks
    SET status = ?,
        result = ?,
        claimed_by = ?,
        claimed_at = ?,
        priority = ?,
        assigned_to = ?,
        version = version + 1,
        updated_at = ?
    WHERE id = ? AND version = ?
  `, input.status, resultText, claimedBy, claimedAt, priority, assignedTo, new Date().toISOString(), input.task_id, input.version);

  if (updateResult.changes === 0) {
    // Re-fetch to get current version for error message
    const current = await db.get<{ version: number }>('SELECT version FROM tasks WHERE id = ?', input.task_id);
    throw new TaskConflictError(current!.version, input.version);
  }

  const newVersion = input.version + 1;

  // Side effects based on new status
  if (input.status === 'completed') {
    await broadcastInternal(
      db, workspaceId, 'TASK_UPDATE',
      `Task #${input.task_id} completed by ${agentId}: ${resultText ?? '(no result)'}`,
      ['task-update'], agentId,
    );
    // Save result as context entry
    if (resultText) {
      await saveContext(db, workspaceId, agentId, {
        key: `task-result-${input.task_id}`,
        value: resultText,
        tags: ['task-result'],
      });
    }
  } else if (input.status === 'escalated') {
    await broadcastInternal(
      db, workspaceId, 'ESCALATION',
      `Task #${input.task_id} escalated by ${agentId}: ${resultText ?? '(no reason)'}`,
      ['task-escalation'], agentId,
    );
  } else if (input.status === 'abandoned') {
    await broadcastInternal(
      db, workspaceId, 'TASK_UPDATE',
      `Task #${input.task_id} abandoned by ${agentId}`,
      ['task-update'], agentId,
    );
  } else if (input.status === 'claimed') {
    await broadcastInternal(
      db, workspaceId, 'TASK_UPDATE',
      `Task #${input.task_id} claimed by ${agentId}`,
      ['task-update'], agentId,
    );
  }

  // Update workflow_run status if this task belongs to one
  await checkWorkflowCompletion(db, input.task_id);

  return {
    task_id: input.task_id,
    status: input.status,
    version: newVersion,
  };
}
