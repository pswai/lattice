import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import {
  defineSchedule,
  listSchedules,
  deleteSchedule,
} from '../../models/schedule.js';
import { ValidationError } from '../../errors.js';

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
    const parsed = DefineScheduleSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId, agentId } = c.get('auth');
    const result = await defineSchedule(db, teamId, agentId, parsed.data);
    return c.json(result, 201);
  });

  // GET /schedules — list
  router.get('/', async (c) => {
    const { teamId } = c.get('auth');
    const result = await listSchedules(db, teamId);
    return c.json(result);
  });

  // DELETE /schedules/:id — delete
  router.delete('/:id', async (c) => {
    const { teamId } = c.get('auth');
    const idStr = c.req.param('id');
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid schedule id');
    }
    const result = await deleteSchedule(db, teamId, id);
    return c.json(result);
  });

  return router;
}
