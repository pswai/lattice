import type Database from 'better-sqlite3';
import {
  getDueSchedules,
  markScheduleFired,
  computeNextRun,
} from '../models/schedule.js';
import { runPlaybook } from '../models/playbook.js';
import { broadcastInternal } from '../models/event.js';

const SCHEDULER_INTERVAL_MS = 30_000;
const SCHEDULER_AGENT_ID = 'system:scheduler';

export function startScheduler(db: Database.Database): NodeJS.Timeout {
  return setInterval(() => {
    runDueSchedules(db);
  }, SCHEDULER_INTERVAL_MS);
}

/** Run one pass of the scheduler. Exported for tests. */
export function runDueSchedules(db: Database.Database): number {
  const due = getDueSchedules(db);
  let fired = 0;
  for (const schedule of due) {
    try {
      const run = runPlaybook(
        db,
        schedule.teamId,
        SCHEDULER_AGENT_ID,
        schedule.playbookName,
      );
      const nextRunAt = computeNextRun(schedule.cronExpression, new Date()).toISOString();
      markScheduleFired(db, schedule.id, run.workflow_run_id, nextRunAt);

      broadcastInternal(
        db,
        schedule.teamId,
        'BROADCAST',
        `Schedule #${schedule.id} fired: ran playbook "${schedule.playbookName}" (workflow_run ${run.workflow_run_id})`,
        ['schedule_fired', 'scheduler'],
        SCHEDULER_AGENT_ID,
      );
      fired++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcastInternal(
        db,
        schedule.teamId,
        'ERROR',
        `Schedule #${schedule.id} failed: ${message}`,
        ['schedule_fired', 'scheduler', 'error'],
        SCHEDULER_AGENT_ID,
      );
      // Advance next_run_at anyway so we don't tight-loop on a broken schedule.
      try {
        const nextRunAt = computeNextRun(schedule.cronExpression, new Date()).toISOString();
        markScheduleFired(db, schedule.id, schedule.lastWorkflowRunId ?? 0, nextRunAt);
      } catch {
        // If cron is somehow invalid now, leave it; admin will need to fix.
      }
    }
  }
  return fired;
}
