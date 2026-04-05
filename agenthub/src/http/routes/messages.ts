import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { sendMessage, getMessages } from '../../models/message.js';
import { ValidationError } from '../../errors.js';

const SendMessageSchema = z.object({
  to: z.string().min(1).max(100),
  message: z.string().min(1).max(10_000),
  tags: z.array(z.string().max(50)).max(20),
});

export function createMessageRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // POST /messages — send a message
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = SendMessageSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId, agentId } = c.get('auth');
    const result = sendMessage(db, teamId, agentId, parsed.data);
    return c.json(result, 201);
  });

  // GET /messages — get messages for the authenticated agent
  router.get('/', (c) => {
    const { teamId, agentId } = c.get('auth');

    const sinceIdParam = c.req.query('since_id');
    const limitParam = c.req.query('limit');

    const since_id = sinceIdParam ? parseInt(sinceIdParam, 10) : undefined;
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    const result = getMessages(db, teamId, agentId, { since_id, limit });
    return c.json(result);
  });

  return router;
}
