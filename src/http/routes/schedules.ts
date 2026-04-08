import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import {
  defineSchedule,
  listSchedules,
  deleteSchedule,
} from '../../models/schedule.js';
import { ValidationError } from '../../errors.js';
import { validate } from '../validation.js';

const DefineScheduleSchema = z.object({
  playbook_name: z.string().min(1).max(100),
  cron_expression: z.string().min(1).max(100),
  enabled: z.boolean().optional(),
});

export function createScheduleRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /schedules — define (upsert)
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(DefineScheduleSchema, body);

    const { workspaceId, agentId } = c.get('auth');
    const result = await defineSchedule(db, workspaceId, agentId, parsed);
    return c.json(result, 201);
  });

  // GET /schedules — list
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');
    const result = await listSchedules(db, workspaceId);
    return c.json(result);
  });

  // DELETE /schedules/:id — delete
  router.delete('/:id', async (c) => {
    const { workspaceId } = c.get('auth');
    const idStr = c.req.param('id');
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid schedule id');
    }
    const result = await deleteSchedule(db, workspaceId, id);
    return c.json(result);
  });

  return router;
}
