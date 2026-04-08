import type { DbAdapter } from '../db/adapter.js';
import {
  getDueSchedules,
  markScheduleFired,
  computeNextRun,
} from '../models/schedule.js';
import { runPlaybook } from '../models/playbook.js';
import { broadcastInternal } from '../models/event.js';
import { getLogger } from '../logger.js';

const SCHEDULER_INTERVAL_MS = 30_000;
const SCHEDULER_AGENT_ID = 'system:scheduler';

let schedulerRunning = false;

/** Start the cron scheduler loop — fires due schedules every 30 seconds. */
export function startScheduler(db: DbAdapter): NodeJS.Timeout {
  return setInterval(() => {
    runDueSchedules(db).catch((err) =>
      getLogger().error('scheduler_failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, SCHEDULER_INTERVAL_MS);
}

/** Run one pass of the scheduler. Exported for tests. */
export async function runDueSchedules(db: DbAdapter): Promise<number> {
  if (schedulerRunning) return 0;
  schedulerRunning = true;
  try {
    return await runDueSchedulesInner(db);
  } finally {
    schedulerRunning = false;
  }
}

async function runDueSchedulesInner(db: DbAdapter): Promise<number> {
  const due = await getDueSchedules(db);
  let fired = 0;
  for (const schedule of due) {
    try {
      const run = await runPlaybook(
        db,
        schedule.workspaceId,
        SCHEDULER_AGENT_ID,
        schedule.playbookName,
      );
      const nextRunAt = computeNextRun(schedule.cronExpression, new Date()).toISOString();
      await markScheduleFired(db, schedule.id, run.workflow_run_id, nextRunAt);

      await broadcastInternal(
        db,
        schedule.workspaceId,
        'BROADCAST',
        `Schedule #${schedule.id} fired: ran playbook "${schedule.playbookName}" (workflow_run ${run.workflow_run_id})`,
        ['schedule_fired', 'scheduler'],
        SCHEDULER_AGENT_ID,
      );
      fired++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await broadcastInternal(
        db,
        schedule.workspaceId,
        'ERROR',
        `Schedule #${schedule.id} failed: ${message}`,
        ['schedule_fired', 'scheduler', 'error'],
        SCHEDULER_AGENT_ID,
      );
      // Advance next_run_at anyway so we don't tight-loop on a broken schedule.
      try {
        const nextRunAt = computeNextRun(schedule.cronExpression, new Date()).toISOString();
        await markScheduleFired(db, schedule.id, schedule.lastWorkflowRunId ?? 0, nextRunAt);
      } catch {
        // If cron is somehow invalid now, leave it; admin will need to fix.
      }
    }
  }
  return fired;
}
