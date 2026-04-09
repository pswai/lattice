import { Hono } from 'hono';
import type { DbAdapter } from '../../db/adapter.js';
import { listWorkflowRuns, getWorkflowRun, cancelWorkflowRun, type WorkflowRunStatus } from '../../models/workflow.js';
import { ValidationError } from '../../errors.js';

const VALID_STATUSES: WorkflowRunStatus[] = ['running', 'completed', 'failed'];

export function createWorkflowRunRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // GET /workflow-runs — list
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');
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
    const result = await listWorkflowRuns(db, workspaceId, { status, limit });
    return c.json(result);
  });

  // GET /workflow-runs/:id — get one
  router.get('/:id', async (c) => {
    const { workspaceId } = c.get('auth');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid workflow run id');
    }
    const result = await getWorkflowRun(db, workspaceId, id);
    return c.json(result);
  });

  // POST /workflow-runs/:id/cancel — cancel a running workflow
  router.post('/:id/cancel', async (c) => {
    const { workspaceId, agentId } = c.get('auth');
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid workflow run id');
    }
    const result = await cancelWorkflowRun(db, workspaceId, agentId, id);
    return c.json(result);
  });

  return router;
}
