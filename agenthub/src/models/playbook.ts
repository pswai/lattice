import type { DbAdapter } from '../db/adapter.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { throwIfSecretsFound } from '../services/secret-scanner.js';
import { createTask } from './task.js';
import { createWorkflowRun, setWorkflowRunTaskIds } from './workflow.js';
import { incrementUsage } from './usage.js';

export interface PlaybookTaskTemplate {
  description: string;
  role?: string;
  depends_on_index?: number[];
}

export interface Playbook {
  id: number;
  workspaceId: string;
  name: string;
  description: string;
  tasks: PlaybookTaskTemplate[];
  createdBy: string;
  createdAt: string;
}

interface PlaybookRow {
  id: number;
  workspace_id: string;
  name: string;
  description: string;
  tasks_json: string;
  created_by: string;
  created_at: string;
}

function rowToPlaybook(row: PlaybookRow): Playbook {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    tasks: JSON.parse(row.tasks_json) as PlaybookTaskTemplate[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export interface DefinePlaybookInput {
  name: string;
  description: string;
  tasks: PlaybookTaskTemplate[];
}

function validateTasks(tasks: PlaybookTaskTemplate[]): void {
  if (!Array.isArray(tasks)) {
    throw new ValidationError('tasks must be an array');
  }
  tasks.forEach((t, i) => {
    if (!t || typeof t.description !== 'string' || t.description.length === 0) {
      throw new ValidationError(`tasks[${i}].description is required`);
    }
    if (t.depends_on_index) {
      if (!Array.isArray(t.depends_on_index)) {
        throw new ValidationError(`tasks[${i}].depends_on_index must be an array`);
      }
      for (const idx of t.depends_on_index) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= tasks.length) {
          throw new ValidationError(`tasks[${i}].depends_on_index contains invalid index ${idx}`);
        }
        if (idx >= i) {
          throw new ValidationError(`tasks[${i}].depends_on_index[${idx}] must reference an earlier task`);
        }
      }
    }
  });
}

export async function definePlaybook(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: DefinePlaybookInput,
): Promise<Playbook> {
  if (!input.name || input.name.length === 0) {
    throw new ValidationError('name is required');
  }
  if (!input.description || input.description.length === 0) {
    throw new ValidationError('description is required');
  }
  validateTasks(input.tasks);

  // Scan description and task descriptions for secrets
  for (const field of [input.description, ...input.tasks.map(t => t.description)]) {
    throwIfSecretsFound(field);
  }

  const tasksJson = JSON.stringify(input.tasks);

  await db.run(`
    INSERT INTO playbooks (workspace_id, name, description, tasks_json, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, name) DO UPDATE SET
      description = excluded.description,
      tasks_json = excluded.tasks_json
  `, workspaceId, input.name, input.description, tasksJson, agentId);

  const row = await db.get<PlaybookRow>(
    'SELECT * FROM playbooks WHERE workspace_id = ? AND name = ?',
    workspaceId, input.name,
  );

  return rowToPlaybook(row!);
}

export async function listPlaybooks(
  db: DbAdapter,
  workspaceId: string,
): Promise<{ playbooks: Playbook[]; total: number }> {
  const rows = await db.all<PlaybookRow>(
    'SELECT * FROM playbooks WHERE workspace_id = ? ORDER BY name ASC',
    workspaceId,
  );

  return {
    playbooks: rows.map(rowToPlaybook),
    total: rows.length,
  };
}

export async function getPlaybook(
  db: DbAdapter,
  workspaceId: string,
  name: string,
): Promise<Playbook> {
  const row = await db.get<PlaybookRow>(
    'SELECT * FROM playbooks WHERE workspace_id = ? AND name = ?',
    workspaceId, name,
  );

  if (!row) {
    throw new NotFoundError('Playbook', name);
  }
  return rowToPlaybook(row);
}

function substituteVars(str: string, vars?: Record<string, string>): string {
  return str.replace(/\{\{vars\.(\w+)\}\}/g, (_, k: string) =>
    vars && Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : `{{vars.${k}}}`,
  );
}

export async function runPlaybook(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  name: string,
  vars?: Record<string, string>,
): Promise<{ workflow_run_id: number; created_task_ids: number[] }> {
  const playbook = await getPlaybook(db, workspaceId, name);

  const workflowRunId = await createWorkflowRun(db, workspaceId, name, agentId);

  const createdIds: number[] = [];
  for (let i = 0; i < playbook.tasks.length; i++) {
    const template = playbook.tasks[i];
    const dependsOn: number[] = [];
    if (template.depends_on_index) {
      for (const idx of template.depends_on_index) {
        dependsOn.push(createdIds[idx]);
      }
    }

    const rawDescription = template.role
      ? `[${template.role}] ${template.description}`
      : template.description;
    const description = substituteVars(rawDescription, vars);

    const result = await createTask(db, workspaceId, agentId, {
      description,
      status: 'open',
      depends_on: dependsOn.length > 0 ? dependsOn : undefined,
    });
    createdIds.push(result.task_id);
  }

  await setWorkflowRunTaskIds(db, workflowRunId, createdIds);

  // Billing: count 1 for the run itself (individual tasks are already counted
  // by createTask). Spec asks for: tasks spawned + 1 for the run.
  await incrementUsage(db, workspaceId, { exec: 1 });

  return { workflow_run_id: workflowRunId, created_task_ids: createdIds };
}
