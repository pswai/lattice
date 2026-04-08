import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { sendMessage, getMessages } from '../../models/message.js';
import { validate, optionalInt } from '../validation.js';

const SendMessageSchema = z.object({
  to: z.string().min(1).max(100),
  message: z.string().min(1).max(10_000),
  tags: z.array(z.string().max(50)).max(20),
});

export function createMessageRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /messages — send a message
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(SendMessageSchema, body);

    const { workspaceId, agentId } = c.get('auth');
    const result = await sendMessage(db, workspaceId, agentId, parsed);
    return c.json(result, 201);
  });

  // GET /messages — get messages for the authenticated agent
  router.get('/', async (c) => {
    const { workspaceId, agentId } = c.get('auth');

    const since_id = optionalInt(c.req.query('since_id'), 'since_id', { min: 0 });
    const limit = optionalInt(c.req.query('limit'), 'limit', { min: 1 });

    const result = await getMessages(db, workspaceId, agentId, { since_id, limit });
    return c.json(result);
  });

  return router;
}
