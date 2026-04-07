import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { sendMessage, getMessages } from '../../models/message.js';
import { ValidationError } from '../../errors.js';

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
    const parsed = SendMessageSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { workspaceId, agentId } = c.get('auth');
    const result = await sendMessage(db, workspaceId, agentId, parsed.data);
    return c.json(result, 201);
  });

  // GET /messages — get messages for the authenticated agent
  router.get('/', async (c) => {
    const { workspaceId, agentId } = c.get('auth');

    const sinceIdParam = c.req.query('since_id');
    const limitParam = c.req.query('limit');

    const since_id = sinceIdParam ? (parseInt(sinceIdParam, 10) || 0) : undefined;
    const limit = limitParam ? (parseInt(limitParam, 10) || 50) : undefined;

    const result = await getMessages(db, workspaceId, agentId, { since_id, limit });
    return c.json(result);
  });

  return router;
}
