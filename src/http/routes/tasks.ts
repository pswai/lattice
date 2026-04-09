import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { createTask, createTasks, updateTask, listTasks, getTask, getTaskGraph } from '../../models/task.js';
import { validate, optionalInt, requireInt } from '../validation.js';

const CreateTaskSchema = z.object({
  description: z.string().min(1).max(10_000),
  status: z.enum(['open', 'claimed']).optional(),
  depends_on: z.array(z.number().int().positive()).max(100).optional(),
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
    const { workspaceId } = c.get('auth');

    const status = c.req.query('status');
    const claimedBy = c.req.query('claimed_by');
    const assignedTo = c.req.query('assigned_to');
    const createdBy = c.req.query('created_by');
    const priority = c.req.query('priority');
    const claimable = c.req.query('claimable') === 'true' ? true : undefined;
    const descriptionContains = c.req.query('description_contains');
    const createdAfter = c.req.query('created_after');
    const updatedAfter = c.req.query('updated_after');
    const resultContains = c.req.query('result_contains');
    const limit = optionalInt(c.req.query('limit'), 'limit', { min: 1 });

    const result = await listTasks(db, workspaceId, {
      status, claimed_by: claimedBy, assigned_to: assignedTo,
      created_by: createdBy, priority, claimable,
      description_contains: descriptionContains,
      created_after: createdAfter, updated_after: updatedAfter,
      result_contains: resultContains, limit,
    });
    return c.json(result);
  });

  // GET /tasks/graph — task DAG for visualization (declared before /:id)
  router.get('/graph', async (c) => {
    const { workspaceId } = c.get('auth');
    const status = c.req.query('status');
    const workflowRunId = optionalInt(c.req.query('workflow_run_id'), 'workflow_run_id');
    const limit = optionalInt(c.req.query('limit'), 'limit');

    const result = await getTaskGraph(db, workspaceId, {
      status,
      workflow_run_id: workflowRunId,
      limit,
    });
    return c.json(result);
  });

  // GET /tasks/:id — get single task
  router.get('/:id', async (c) => {
    const { workspaceId } = c.get('auth');
    const taskId = requireInt(c.req.param('id'), 'task_id');

    const task = await getTask(db, workspaceId, taskId);
    return c.json(task);
  });

  // POST /tasks/bulk — create multiple tasks
  const CreateTasksBulkSchema = z.object({
    tasks: z.array(z.object({
      description: z.string().min(1).max(10_000),
      status: z.enum(['open', 'claimed']).optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
      assigned_to: z.string().max(100).optional(),
      depends_on_index: z.array(z.number().int().nonnegative()).max(100).optional(),
    })).min(1).max(50),
  });

  router.post('/bulk', async (c) => {
    const body = await c.req.json();
    const parsed = validate(CreateTasksBulkSchema, body);
    const { workspaceId, agentId } = c.get('auth');
    const result = await createTasks(db, workspaceId, agentId, parsed);
    return c.json(result, 201);
  });

  // POST /tasks — create_task
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(CreateTaskSchema, body);

    const { workspaceId, agentId } = c.get('auth');
    const result = await createTask(db, workspaceId, agentId, parsed);
    return c.json(result, 201);
  });

  // PATCH /tasks/:id — update_task
  router.patch('/:id', async (c) => {
    const taskId = requireInt(c.req.param('id'), 'task_id');

    const body = await c.req.json();
    const parsed = validate(UpdateTaskSchema, body);

    const { workspaceId, agentId } = c.get('auth');
    const result = await updateTask(db, workspaceId, agentId, {
      task_id: taskId,
      ...parsed,
    });
    return c.json(result);
  });

  return router;
}
