import type { DbAdapter } from '../db/adapter.js';
import { jsonArrayTable } from '../db/adapter.js';
import { NotFoundError } from '../errors.js';

export type WorkflowRunStatus = 'running' | 'completed' | 'failed';

export interface WorkflowRun {
  id: number;
  teamId: string;
  playbookName: string;
  startedBy: string;
  taskIds: number[];
  status: WorkflowRunStatus;
  startedAt: string;
  completedAt: string | null;
}

interface WorkflowRunRow {
  id: number;
  team_id: string;
  playbook_name: string;
  started_by: string;
  task_ids: string;
  status: string;
  started_at: string;
  completed_at: string | null;
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    teamId: row.team_id,
    playbookName: row.playbook_name,
    startedBy: row.started_by,
    taskIds: JSON.parse(row.task_ids) as number[],
    status: row.status as WorkflowRunStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function createWorkflowRun(
  db: DbAdapter,
  teamId: string,
  playbookName: string,
  startedBy: string,
): Promise<number> {
  const result = await db.run(`
    INSERT INTO workflow_runs (team_id, playbook_name, started_by, task_ids, status)
    VALUES (?, ?, ?, '[]', 'running')
  `, teamId, playbookName, startedBy);
  return Number(result.lastInsertRowid);
}

export async function setWorkflowRunTaskIds(
  db: DbAdapter,
  runId: number,
  taskIds: number[],
): Promise<void> {
  await db.run('UPDATE workflow_runs SET task_ids = ? WHERE id = ?',
    JSON.stringify(taskIds),
    runId,
  );
}

export interface ListWorkflowRunsInput {
  status?: WorkflowRunStatus;
  limit?: number;
}

export interface WorkflowRunListItem extends WorkflowRun {
  taskCount: number;
}

export async function listWorkflowRuns(
  db: DbAdapter,
  teamId: string,
  input: ListWorkflowRunsInput,
): Promise<{ workflow_runs: WorkflowRunListItem[]; total: number }> {
  const limit = Math.min(input.limit ?? 50, 200);
  const conditions = ['team_id = ?'];
  const params: (string | number)[] = [teamId];

  if (input.status) {
    conditions.push('status = ?');
    params.push(input.status);
  }

  params.push(limit);

  const rows = await db.all<WorkflowRunRow>(`
    SELECT * FROM workflow_runs
    WHERE ${conditions.join(' AND ')}
    ORDER BY started_at DESC
    LIMIT ?
  `, ...params);

  const items = rows.map((row) => {
    const run = rowToRun(row);
    return { ...run, taskCount: run.taskIds.length };
  });

  return { workflow_runs: items, total: items.length };
}

export interface WorkflowRunDetails extends WorkflowRun {
  tasks: Array<{ id: number; description: string; status: string }>;
}

export async function getWorkflowRun(
  db: DbAdapter,
  teamId: string,
  id: number,
): Promise<WorkflowRunDetails> {
  const row = await db.get<WorkflowRunRow>(
    'SELECT * FROM workflow_runs WHERE id = ? AND team_id = ?',
    id, teamId,
  );

  if (!row) {
    throw new NotFoundError('WorkflowRun', id);
  }

  const run = rowToRun(row);

  const tasks: Array<{ id: number; description: string; status: string }> = [];
  if (run.taskIds.length > 0) {
    const placeholders = run.taskIds.map(() => '?').join(',');
    const taskRows = await db.all<{ id: number; description: string; status: string }>(
      `SELECT id, description, status FROM tasks WHERE id IN (${placeholders}) AND team_id = ?`,
      ...run.taskIds, teamId,
    );
    tasks.push(...taskRows);
  }

  return { ...run, tasks };
}

/**
 * Check if the workflow that contains the given task is complete.
 * Called after updateTask. If ALL tasks in the run are terminal
 * (completed/escalated/abandoned), the run is marked completed.
 * If any task is escalated or abandoned, the run is marked failed.
 */
export async function checkWorkflowCompletion(
  db: DbAdapter,
  taskId: number,
): Promise<void> {
  // Find workflow run(s) that contain this task id in their JSON array.
  const rows = await db.all<{ id: number; task_ids: string }>(`
    SELECT id, task_ids FROM workflow_runs
    WHERE status = 'running'
      AND EXISTS (
        SELECT 1 FROM ${jsonArrayTable(db.dialect, 'task_ids')} WHERE value = ?
      )
  `, taskId);

  for (const row of rows) {
    const taskIds = JSON.parse(row.task_ids) as number[];
    if (taskIds.length === 0) continue;

    const placeholders = taskIds.map(() => '?').join(',');
    const statuses = await db.all<{ status: string }>(
      `SELECT status FROM tasks WHERE id IN (${placeholders})`,
      ...taskIds,
    );

    const terminal = ['completed', 'escalated', 'abandoned'];
    const allTerminal = statuses.length === taskIds.length &&
      statuses.every((s) => terminal.includes(s.status));

    if (!allTerminal) continue;

    const anyFailed = statuses.some((s) => s.status === 'escalated' || s.status === 'abandoned');
    const newStatus: WorkflowRunStatus = anyFailed ? 'failed' : 'completed';

    await db.run(`
      UPDATE workflow_runs
      SET status = ?, completed_at = ?
      WHERE id = ?
    `, newStatus, new Date().toISOString(), row.id);
  }
}
