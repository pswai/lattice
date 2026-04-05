import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
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

export function createScheduleRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // POST /schedules — define (upsert)
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = DefineScheduleSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId, agentId } = c.get('auth');
    const result = defineSchedule(db, teamId, agentId, parsed.data);
    return c.json(result, 201);
  });

  // GET /schedules — list
  router.get('/', (c) => {
    const { teamId } = c.get('auth');
    const result = listSchedules(db, teamId);
    return c.json(result);
  });

  // DELETE /schedules/:id — delete
  router.delete('/:id', (c) => {
    const { teamId } = c.get('auth');
    const idStr = c.req.param('id');
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid schedule id');
    }
    const result = deleteSchedule(db, teamId, id);
    return c.json(result);
  });

  return router;
}
