import type Database from 'better-sqlite3';
import { ValidationError, NotFoundError } from '../errors.js';
import { createTask } from './task.js';
import { createWorkflowRun, setWorkflowRunTaskIds } from './workflow.js';

export interface PlaybookTaskTemplate {
  description: string;
  role?: string;
  depends_on_index?: number[];
}

export interface Playbook {
  id: number;
  teamId: string;
  name: string;
  description: string;
  tasks: PlaybookTaskTemplate[];
  createdBy: string;
  createdAt: string;
}

interface PlaybookRow {
  id: number;
  team_id: string;
  name: string;
  description: string;
  tasks_json: string;
  created_by: string;
  created_at: string;
}

function rowToPlaybook(row: PlaybookRow): Playbook {
  return {
    id: row.id,
    teamId: row.team_id,
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

export function definePlaybook(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: DefinePlaybookInput,
): Playbook {
  if (!input.name || input.name.length === 0) {
    throw new ValidationError('name is required');
  }
  if (!input.description || input.description.length === 0) {
    throw new ValidationError('description is required');
  }
  validateTasks(input.tasks);

  const tasksJson = JSON.stringify(input.tasks);

  db.prepare(`
    INSERT INTO playbooks (team_id, name, description, tasks_json, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(team_id, name) DO UPDATE SET
      description = excluded.description,
      tasks_json = excluded.tasks_json,
      created_by = excluded.created_by
  `).run(teamId, input.name, input.description, tasksJson, agentId);

  const row = db.prepare(
    'SELECT * FROM playbooks WHERE team_id = ? AND name = ?',
  ).get(teamId, input.name) as PlaybookRow;

  return rowToPlaybook(row);
}

export function listPlaybooks(
  db: Database.Database,
  teamId: string,
): { playbooks: Playbook[]; total: number } {
  const rows = db.prepare(
    'SELECT * FROM playbooks WHERE team_id = ? ORDER BY name ASC',
  ).all(teamId) as PlaybookRow[];

  return {
    playbooks: rows.map(rowToPlaybook),
    total: rows.length,
  };
}

export function getPlaybook(
  db: Database.Database,
  teamId: string,
  name: string,
): Playbook {
  const row = db.prepare(
    'SELECT * FROM playbooks WHERE team_id = ? AND name = ?',
  ).get(teamId, name) as PlaybookRow | undefined;

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

export function runPlaybook(
  db: Database.Database,
  teamId: string,
  agentId: string,
  name: string,
  vars?: Record<string, string>,
): { workflow_run_id: number; created_task_ids: number[] } {
  const playbook = getPlaybook(db, teamId, name);

  const workflowRunId = createWorkflowRun(db, teamId, name, agentId);

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

    const result = createTask(db, teamId, agentId, {
      description,
      status: 'open',
      depends_on: dependsOn.length > 0 ? dependsOn : undefined,
    });
    createdIds.push(result.task_id);
  }

  setWorkflowRunTaskIds(db, workflowRunId, createdIds);

  return { workflow_run_id: workflowRunId, created_task_ids: createdIds };
}
