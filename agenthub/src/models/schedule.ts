import type Database from 'better-sqlite3';
import { ValidationError } from '../errors.js';
import { getPlaybook } from './playbook.js';

export interface Schedule {
  id: number;
  teamId: string;
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
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
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
  };
}

const UNSUPPORTED_CRON =
  'Unsupported cron pattern — use */N * * * *, 0 */N * * *, 0 N * * *, or 0 H * * D';

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
      throw new ValidationError(UNSUPPORTED_CRON);
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
      throw new ValidationError(UNSUPPORTED_CRON);
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
      throw new ValidationError(UNSUPPORTED_CRON);
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
      throw new ValidationError(UNSUPPORTED_CRON);
    }
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new ValidationError(UNSUPPORTED_CRON);
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

  throw new ValidationError(UNSUPPORTED_CRON);
}

export interface DefineScheduleInput {
  playbook_name: string;
  cron_expression: string;
  enabled?: boolean;
}

export function defineSchedule(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: DefineScheduleInput,
): Schedule {
  if (!input.playbook_name || input.playbook_name.length === 0) {
    throw new ValidationError('playbook_name is required');
  }
  if (!input.cron_expression || input.cron_expression.length === 0) {
    throw new ValidationError('cron_expression is required');
  }

  // Validate playbook exists (throws NotFoundError if missing)
  getPlaybook(db, teamId, input.playbook_name);

  const enabled = input.enabled === false ? 0 : 1;
  const nextRunAt = computeNextRun(input.cron_expression, new Date()).toISOString();

  db.prepare(`
    INSERT INTO schedules (team_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, playbook_name, cron_expression) DO UPDATE SET
      enabled = excluded.enabled,
      next_run_at = excluded.next_run_at,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(teamId, input.playbook_name, input.cron_expression, enabled, nextRunAt, agentId);

  const row = db.prepare(
    'SELECT * FROM schedules WHERE team_id = ? AND playbook_name = ? AND cron_expression = ?',
  ).get(teamId, input.playbook_name, input.cron_expression) as ScheduleRow;

  return rowToSchedule(row);
}

export function listSchedules(
  db: Database.Database,
  teamId: string,
): { schedules: Schedule[]; total: number } {
  const rows = db.prepare(
    'SELECT * FROM schedules WHERE team_id = ? ORDER BY id ASC',
  ).all(teamId) as ScheduleRow[];

  return {
    schedules: rows.map(rowToSchedule),
    total: rows.length,
  };
}

export function deleteSchedule(
  db: Database.Database,
  teamId: string,
  id: number,
): { deleted: boolean } {
  const result = db.prepare(
    'DELETE FROM schedules WHERE team_id = ? AND id = ?',
  ).run(teamId, id);
  return { deleted: result.changes > 0 };
}

/** Cross-team — returns schedules whose next_run_at is due (<= now) and enabled. */
export function getDueSchedules(db: Database.Database): Schedule[] {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `).all(now) as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function markScheduleFired(
  db: Database.Database,
  id: number,
  workflowRunId: number,
  nextRunAt: string,
): void {
  db.prepare(`
    UPDATE schedules
    SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        last_workflow_run_id = ?,
        next_run_at = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(workflowRunId, nextRunAt, id);
}
