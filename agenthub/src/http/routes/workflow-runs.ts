import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { listWorkflowRuns, getWorkflowRun, type WorkflowRunStatus } from '../../models/workflow.js';
import { ValidationError } from '../../errors.js';

const VALID_STATUSES: WorkflowRunStatus[] = ['running', 'completed', 'failed'];

export function createWorkflowRunRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // GET /workflow-runs — list
  router.get('/', (c) => {
    const { teamId } = c.get('auth');
    const statusParam = c.req.query('status');
    const limitParam = c.req.query('limit');

    let status: WorkflowRunStatus | undefined;
    if (statusParam) {
      if (!VALID_STATUSES.includes(statusParam as WorkflowRunStatus)) {
        throw new ValidationError(`Invalid status: ${statusParam}`);
      }
      status = statusParam as WorkflowRunStatus;
    }

    const limit = limitParam ? Number(limitParam) : undefined;
    const result = listWorkflowRuns(db, teamId, { status, limit });
    return c.json(result);
  });

  // GET /workflow-runs/:id — get one
  router.get('/:id', (c) => {
    const { teamId } = c.get('auth');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid workflow run id');
    }
    const result = getWorkflowRun(db, teamId, id);
    return c.json(result);
  });

  return router;
}
