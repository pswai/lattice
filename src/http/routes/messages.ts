import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { sendMessage, getMessages } from '../../models/message.js';
import { ValidationError } from '../../errors.js';
import { validate } from '../validation.js';

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

    const sinceIdParam = c.req.query('since_id');
    const limitParam = c.req.query('limit');

    const since_id = sinceIdParam !== undefined ? parseInt(sinceIdParam, 10) : undefined;
    if (since_id !== undefined && (!Number.isFinite(since_id) || since_id < 0)) {
      throw new ValidationError('since_id must be a non-negative integer');
    }
    const limit = limitParam !== undefined ? parseInt(limitParam, 10) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      throw new ValidationError('limit must be a positive integer');
    }

    const result = await getMessages(db, workspaceId, agentId, { since_id, limit });
    return c.json(result);
  });

  return router;
}
