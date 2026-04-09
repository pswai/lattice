import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { sendMessage, getMessages, searchMessages, getThread, waitForMessage } from '../../models/message.js';
import { throwIfSecretsFound } from '../../services/secret-scanner.js';
import { validate, optionalInt, requireInt } from '../validation.js';

const SendMessageSchema = z.object({
  to: z.string().min(1).max(100),
  message: z.string().min(1).max(10_000),
  tags: z.array(z.string().max(50)).max(20),
  reply_to: z.number().int().positive().optional(),
});

export function createMessageRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /messages — send a message
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(SendMessageSchema, body);
    throwIfSecretsFound(parsed.message);

    const { workspaceId, agentId } = c.get('auth');
    const result = await sendMessage(db, workspaceId, agentId, parsed);
    return c.json(result, 201);
  });

  // GET /messages/search — search message history
  router.get('/search', async (c) => {
    const { workspaceId, agentId } = c.get('auth');
    const query = c.req.query('query');
    const withAgent = c.req.query('with_agent');
    const sinceId = optionalInt(c.req.query('since_id'), 'since_id', { min: 0 });
    const limit = optionalInt(c.req.query('limit'), 'limit', { min: 1 });
    const result = await searchMessages(db, workspaceId, agentId, { query, with_agent: withAgent, since_id: sinceId, limit });
    return c.json(result);
  });

  // GET /messages/thread/:id — get all messages in a thread
  router.get('/thread/:id', async (c) => {
    const { workspaceId } = c.get('auth');
    const messageId = requireInt(c.req.param('id'), 'message_id');
    const result = await getThread(db, workspaceId, messageId);
    return c.json(result);
  });

  // GET /messages/wait — long-poll for new messages
  router.get('/wait', async (c) => {
    const { workspaceId, agentId } = c.get('auth');

    const since_id = requireInt(c.req.query('since_id'), 'since_id', { min: 0 });
    const timeout_sec = optionalInt(c.req.query('timeout_sec'), 'timeout_sec', { min: 0 });

    const result = await waitForMessage(db, workspaceId, agentId, { since_id, timeout_sec });
    return c.json(result);
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
