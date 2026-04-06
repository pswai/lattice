import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { createTask, updateTask, listTasks, getTask, getTaskGraph } from '../../models/task.js';
import { ValidationError } from '../../errors.js';

const CreateTaskSchema = z.object({
  description: z.string().min(1).max(10_000),
  status: z.enum(['open', 'claimed']).optional(),
  depends_on: z.array(z.number().int().positive()).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  assigned_to: z.string().max(100).optional(),
});

const UpdateTaskSchema = z.object({
  status: z.enum(['claimed', 'completed', 'escalated', 'abandoned']),
  result: z.string().max(100_000).optional(),
  version: z.number().int().positive(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  assigned_to: z.string().max(100).nullable().optional(),
});

export function createTaskRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // GET /tasks — list tasks
  router.get('/', async (c) => {
    const { teamId } = c.get('auth');

    const status = c.req.query('status');
    const claimedBy = c.req.query('claimed_by');
    const assignedTo = c.req.query('assigned_to');
    const limitParam = c.req.query('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    const result = await listTasks(db, teamId, { status, claimed_by: claimedBy, assigned_to: assignedTo, limit });
    return c.json(result);
  });

  // GET /tasks/graph — task DAG for visualization (declared before /:id)
  router.get('/graph', async (c) => {
    const { teamId } = c.get('auth');
    const status = c.req.query('status');
    const workflowRunIdStr = c.req.query('workflow_run_id');
    const limitStr = c.req.query('limit');

    let workflowRunId: number | undefined;
    if (workflowRunIdStr !== undefined) {
      const parsed = parseInt(workflowRunIdStr, 10);
      if (isNaN(parsed)) {
        throw new ValidationError('Invalid workflow_run_id');
      }
      workflowRunId = parsed;
    }

    let limit: number | undefined;
    if (limitStr !== undefined) {
      const parsed = parseInt(limitStr, 10);
      if (isNaN(parsed)) {
        throw new ValidationError('Invalid limit');
      }
      limit = parsed;
    }

    const result = await getTaskGraph(db, teamId, {
      status,
      workflow_run_id: workflowRunId,
      limit,
    });
    return c.json(result);
  });

  // GET /tasks/:id — get single task
  router.get('/:id', async (c) => {
    const { teamId } = c.get('auth');
    const taskId = parseInt(c.req.param('id'), 10);
    if (isNaN(taskId)) {
      throw new ValidationError('Invalid task ID');
    }

    const task = await getTask(db, teamId, taskId);
    return c.json(task);
  });

  // POST /tasks — create_task
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = CreateTaskSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId, agentId } = c.get('auth');
    const result = await createTask(db, teamId, agentId, parsed.data);
    return c.json(result, 201);
  });

  // PATCH /tasks/:id — update_task
  router.patch('/:id', async (c) => {
    const taskId = parseInt(c.req.param('id'), 10);
    if (isNaN(taskId)) {
      throw new ValidationError('Invalid task ID');
    }

    const body = await c.req.json();
    const parsed = UpdateTaskSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId, agentId } = c.get('auth');
    const result = await updateTask(db, teamId, agentId, {
      task_id: taskId,
      ...parsed.data,
    });
    return c.json(result);
  });

  return router;
}
