import type { DbAdapter } from '../db/adapter.js';
import { ValidationError } from '../errors.js';
import { getPlaybook } from './playbook.js';

export interface Schedule {
  id: number;
  workspaceId: string;
  playbookName: string;
  cronExpression: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastWorkflowRunId: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: number;
  workspace_id: string;
  playbook_name: string;
  cron_expression: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_workflow_run_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    playbookName: row.playbook_name,
    cronExpression: row.cron_expression,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastWorkflowRunId: row.last_workflow_run_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function unsupportedCron(input: string): string {
  return (
    `Unsupported cron pattern: '${input}'. ` +
    `Supported: '*/N * * * *' (every N min), ` +
    `'0 */N * * *' (every N hours), ` +
    `'0 N * * *' (daily at N:00 UTC), ` +
    `'0 H * * D' (weekly day D at H:00 UTC).`
  );
}

/**
 * Compute the next firing Date strictly after `from` for the supported cron subset.
 * Supported patterns (UTC):
 *   - "*\/N * * * *"   — every N minutes (1 ≤ N ≤ 59)
 *   - "0 *\/N * * *"   — every N hours at minute 0 (1 ≤ N ≤ 23)
 *   - "0 N * * *"      — daily at hour N (0 ≤ N ≤ 23)
 *   - "0 H * * D"      — weekly on day D at hour H (0 ≤ H ≤ 23, 0 ≤ D ≤ 6, Sun=0)
 */
export function computeNextRun(expr: string, from: Date): Date {
  const trimmed = expr.trim();

  // Advance from `from` to the next whole-minute boundary strictly after it.
  const next = new Date(from);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);

  let m: RegExpMatchArray | null;

  // "*/N * * * *" — every N minutes
  if ((m = trimmed.match(/^\*\/(\d+) \* \* \* \*$/))) {
    const n = parseInt(m[1], 10);
    if (!Number.isInteger(n) || n < 1 || n > 59) {
      throw new ValidationError(unsupportedCron(trimmed));
    }
    while (next.getUTCMinutes() % n !== 0) {
      next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    return next;
  }

  // "0 */N * * *" — every N hours at minute 0
  if ((m = trimmed.match(/^0 \*\/(\d+) \* \* \*$/))) {
    const n = parseInt(m[1], 10);
    if (!Number.isInteger(n) || n < 1 || n > 23) {
      throw new ValidationError(unsupportedCron(trimmed));
    }
    while (next.getUTCMinutes() !== 0 || next.getUTCHours() % n !== 0) {
      next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    return next;
  }

  // "0 N * * *" — daily at hour N
  if ((m = trimmed.match(/^0 (\d+) \* \* \*$/))) {
    const h = parseInt(m[1], 10);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw new ValidationError(unsupportedCron(trimmed));
    }
    while (next.getUTCMinutes() !== 0 || next.getUTCHours() !== h) {
      next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    return next;
  }

  // "0 H * * D" — weekly on day D at hour H
  if ((m = trimmed.match(/^0 (\d+) \* \* (\d+)$/))) {
    const h = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw new ValidationError(unsupportedCron(trimmed));
    }
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new ValidationError(unsupportedCron(trimmed));
    }
    while (
      next.getUTCMinutes() !== 0 ||
      next.getUTCHours() !== h ||
      next.getUTCDay() !== day
    ) {
      next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    return next;
  }

  throw new ValidationError(unsupportedCron(trimmed));
}

export interface DefineScheduleInput {
  playbook_name: string;
  cron_expression: string;
  enabled?: boolean;
}

export async function defineSchedule(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: DefineScheduleInput,
): Promise<Schedule> {
  if (!input.playbook_name || input.playbook_name.length === 0) {
    throw new ValidationError('playbook_name is required');
  }
  if (!input.cron_expression || input.cron_expression.length === 0) {
    throw new ValidationError('cron_expression is required');
  }

  // Validate playbook exists (throws NotFoundError if missing)
  await getPlaybook(db, workspaceId, input.playbook_name);

  const enabled = input.enabled === false ? 0 : 1;
  const nextRunAt = computeNextRun(input.cron_expression, new Date()).toISOString();

  await db.run(`
    INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, playbook_name, cron_expression) DO UPDATE SET
      enabled = excluded.enabled,
      next_run_at = excluded.next_run_at,
      updated_at = ?
  `, workspaceId, input.playbook_name, input.cron_expression, enabled, nextRunAt, agentId, new Date().toISOString());

  const row = await db.get<ScheduleRow>(
    'SELECT * FROM schedules WHERE workspace_id = ? AND playbook_name = ? AND cron_expression = ?',
    workspaceId, input.playbook_name, input.cron_expression,
  );

  return rowToSchedule(row!);
}

export async function listSchedules(
  db: DbAdapter,
  workspaceId: string,
): Promise<{ schedules: Schedule[]; total: number }> {
  const rows = await db.all<ScheduleRow>(
    'SELECT * FROM schedules WHERE workspace_id = ? ORDER BY id ASC',
    workspaceId,
  );

  return {
    schedules: rows.map(rowToSchedule),
    total: rows.length,
  };
}

export async function deleteSchedule(
  db: DbAdapter,
  workspaceId: string,
  id: number,
): Promise<{ deleted: boolean }> {
  const result = await db.run(
    'DELETE FROM schedules WHERE workspace_id = ? AND id = ?',
    workspaceId, id,
  );
  return { deleted: result.changes > 0 };
}

/** Cross-team — returns schedules whose next_run_at is due (<= now) and enabled. */
export async function getDueSchedules(db: DbAdapter): Promise<Schedule[]> {
  const now = new Date().toISOString();
  const rows = await db.all<ScheduleRow>(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `, now);
  return rows.map(rowToSchedule);
}

export async function markScheduleFired(
  db: DbAdapter,
  id: number,
  workflowRunId: number,
  nextRunAt: string,
): Promise<void> {
  await db.run(`
    UPDATE schedules
    SET last_run_at = ?,
        last_workflow_run_id = ?,
        next_run_at = ?,
        updated_at = ?
    WHERE id = ?
  `, new Date().toISOString(), workflowRunId, nextRunAt, new Date().toISOString(), id);
}
