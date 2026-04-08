import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { broadcastEvent, getUpdates, waitForEvent } from '../../models/event.js';
import { throwIfSecretsFound } from '../../services/secret-scanner.js';
import { ValidationError } from '../../errors.js';
import { validate, optionalInt, requireInt } from '../validation.js';
import type { EventType } from '../../models/types.js';

const EVENT_TYPES: EventType[] = ['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE'];

const BroadcastSchema = z.object({
  event_type: z.enum(['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE']),
  message: z.string().min(1).max(10_000),
  tags: z.array(z.string().max(50)).max(20),
});

export function createEventRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /events — broadcast
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(BroadcastSchema, body);

    const { workspaceId, agentId } = c.get('auth');

    // Secret scan on message
    throwIfSecretsFound(parsed.message);

    const result = await broadcastEvent(db, workspaceId, agentId, parsed);
    return c.json(result, 201);
  });

  // GET /events/wait — long-poll for matching events
  router.get('/wait', async (c) => {
    const { workspaceId } = c.get('auth');

    const since_id = requireInt(c.req.query('since_id'), 'since_id', { min: 0 });
    const timeout_sec = optionalInt(c.req.query('timeout_sec'), 'timeout_sec', { min: 0 });

    const topicsParam = c.req.query('topics');
    const topics = topicsParam ? topicsParam.split(',').filter(Boolean) : undefined;

    const eventTypeParam = c.req.query('event_type');
    if (eventTypeParam && !EVENT_TYPES.includes(eventTypeParam as EventType)) {
      throw new ValidationError('invalid event_type');
    }
    const event_type = eventTypeParam as EventType | undefined;

    const result = await waitForEvent(db, workspaceId, { since_id, timeout_sec, topics, event_type });
    return c.json(result);
  });

  // GET /events — get_updates
  router.get('/', async (c) => {
    const { workspaceId, agentId } = c.get('auth');

    const sinceTimestamp = c.req.query('since_timestamp');
    const topicsParam = c.req.query('topics');
    const includeContextParam = c.req.query('include_context');

    const since_id = optionalInt(c.req.query('since_id'), 'since_id', { min: 0 });
    const topics = topicsParam ? topicsParam.split(',').filter(Boolean) : undefined;
    const limit = optionalInt(c.req.query('limit'), 'limit', { min: 1 });
    const include_context = includeContextParam === 'false' ? false : true;

    const result = await getUpdates(db, workspaceId, {
      since_id,
      since_timestamp: sinceTimestamp,
      topics,
      limit,
      agent_id: agentId,
      include_context,
    });
    return c.json(result);
  });

  return router;
}
