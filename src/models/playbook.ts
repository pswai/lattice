import type { DbAdapter } from '../db/adapter.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { throwIfSecretsFound } from '../services/secret-scanner.js';
import { createTask } from './task.js';
import { createWorkflowRun, setWorkflowRunTaskIds, checkWorkflowCompletion } from './workflow.js';


/** A single task template within a playbook definition. */
export interface PlaybookTaskTemplate {
  description: string;
  role?: string;
  depends_on_index?: number[];
}

/** A reusable multi-task workflow template. */
export interface Playbook {
  id: number;
  workspaceId: string;
  name: string;
  description: string;
  tasks: PlaybookTaskTemplate[];
  requiredVars?: string[];
  createdBy: string;
  createdAt: string;
}

interface PlaybookRow {
  id: number;
  workspace_id: string;
  name: string;
  description: string;
  tasks_json: string;
  required_vars: string | null;
  created_by: string;
  created_at: string;
}

function rowToPlaybook(row: PlaybookRow): Playbook {
  const requiredVars = row.required_vars
    ? (JSON.parse(row.required_vars) as string[])
    : undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    tasks: JSON.parse(row.tasks_json) as PlaybookTaskTemplate[],
    ...(requiredVars && { requiredVars }),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Input for creating or updating a playbook definition (upsert by name). */
export interface DefinePlaybookInput {
  name: string;
  description: string;
  tasks: PlaybookTaskTemplate[];
  required_vars?: string[];
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

/** Create or replace a playbook definition. Validates task templates and scans for secrets. */
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
  const requiredVarsJson = input.required_vars && input.required_vars.length > 0
    ? JSON.stringify(input.required_vars)
    : null;

  await db.run(`
    INSERT INTO playbooks (workspace_id, name, description, tasks_json, required_vars, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, name) DO UPDATE SET
      description = excluded.description,
      tasks_json = excluded.tasks_json,
      required_vars = excluded.required_vars
  `, workspaceId, input.name, input.description, tasksJson, requiredVarsJson, agentId);

  const row = await db.get<PlaybookRow>(
    'SELECT * FROM playbooks WHERE workspace_id = ? AND name = ?',
    workspaceId, input.name,
  );

  return rowToPlaybook(row!);
}

/** Summary shape for list — omits full tasks array. */
export interface PlaybookSummary {
  id: number;
  workspaceId: string;
  name: string;
  description: string;
  taskCount: number;
  requiredVars?: string[];
  createdBy: string;
  createdAt: string;
}

/** List all playbooks in a workspace, ordered by name. Returns summaries without full task definitions. */
export async function listPlaybooks(
  db: DbAdapter,
  workspaceId: string,
): Promise<{ playbooks: PlaybookSummary[]; total: number }> {
  const rows = await db.all<PlaybookRow>(
    'SELECT * FROM playbooks WHERE workspace_id = ? ORDER BY name ASC',
    workspaceId,
  );

  return {
    playbooks: rows.map(row => {
      const requiredVars = row.required_vars
        ? (JSON.parse(row.required_vars) as string[])
        : undefined;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        description: row.description,
        taskCount: (JSON.parse(row.tasks_json) as PlaybookTaskTemplate[]).length,
        ...(requiredVars && { requiredVars }),
        createdBy: row.created_by,
        createdAt: row.created_at,
      };
    }),
    total: rows.length,
  };
}

/** Fetch a playbook by name. Throws NotFoundError if missing. */
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

/** Extract all `{{vars.X}}` references from a string. */
function extractVarRefs(str: string): string[] {
  const refs: string[] = [];
  const re = /\{\{vars\.(\w+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) refs.push(m[1]);
  return refs;
}

/**
 * Validate that all template variables referenced in descriptions are
 * provided. Also validates `required_vars` if the playbook declares them.
 */
function validateVars(
  playbook: Playbook,
  vars: Record<string, string> | undefined,
): void {
  // 1. Check required_vars declared by the playbook
  if (playbook.requiredVars && playbook.requiredVars.length > 0) {
    const missing = playbook.requiredVars.filter(
      (v) => !vars || !Object.prototype.hasOwnProperty.call(vars, v),
    );
    if (missing.length > 0) {
      throw new ValidationError(
        `Playbook '${playbook.name}' requires vars: ${missing.join(', ')}`,
        { missing_vars: missing },
      );
    }
  }

  // 2. Detect all {{vars.X}} in task descriptions and check they're provided
  const allRefs = new Set<string>();
  for (const t of playbook.tasks) {
    const desc = t.role ? `[${t.role}] ${t.description}` : t.description;
    for (const ref of extractVarRefs(desc)) allRefs.add(ref);
  }

  if (allRefs.size > 0) {
    const unreplaced = [...allRefs].filter(
      (v) => !vars || !Object.prototype.hasOwnProperty.call(vars, v),
    );
    if (unreplaced.length > 0) {
      throw new ValidationError(
        `Playbook '${playbook.name}' has unresolved template variables: ${unreplaced.join(', ')}. ` +
        `Provide them via the vars parameter or remove them from the playbook.`,
        { unreplaced_vars: unreplaced },
      );
    }
  }
}

/**
 * Instantiate a playbook as a workflow run — creates concrete tasks
 * with dependency edges mirroring the playbook's template graph.
 */
export async function runPlaybook(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  name: string,
  vars?: Record<string, string>,
): Promise<{ workflow_run_id: number; created_task_ids: number[] }> {
  const playbook = await getPlaybook(db, workspaceId, name);
  validateVars(playbook, vars);

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

  // Re-check completion for all tasks in case any finished during the race
  // window between workflow creation (with empty task_ids) and now.
  for (const taskId of createdIds) {
    await checkWorkflowCompletion(db, taskId);
  }


  return { workflow_run_id: workflowRunId, created_task_ids: createdIds };
}
