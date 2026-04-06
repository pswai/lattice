import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { broadcastEvent, getUpdates, waitForEvent } from '../../models/event.js';
import { scanForSecrets } from '../../services/secret-scanner.js';
import { SecretDetectedError, ValidationError } from '../../errors.js';
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
    const parsed = BroadcastSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId, agentId } = c.get('auth');

    // Secret scan on message
    const scan = scanForSecrets(parsed.data.message);
    if (!scan.clean) {
      throw new SecretDetectedError(scan.matches[0].pattern, scan.matches[0].preview);
    }

    const result = await broadcastEvent(db, teamId, agentId, parsed.data);
    return c.json(result, 201);
  });

  // GET /events/wait — long-poll for matching events
  router.get('/wait', async (c) => {
    const { teamId } = c.get('auth');

    const sinceIdParam = c.req.query('since_id');
    if (sinceIdParam === undefined) {
      throw new ValidationError('since_id is required');
    }
    const since_id = parseInt(sinceIdParam, 10);
    if (!Number.isFinite(since_id) || since_id < 0) {
      throw new ValidationError('since_id must be a non-negative integer');
    }

    const timeoutParam = c.req.query('timeout_sec');
    const timeout_sec = timeoutParam !== undefined ? parseInt(timeoutParam, 10) : undefined;
    if (timeout_sec !== undefined && (!Number.isFinite(timeout_sec) || timeout_sec < 0)) {
      throw new ValidationError('timeout_sec must be a non-negative integer');
    }

    const topicsParam = c.req.query('topics');
    const topics = topicsParam ? topicsParam.split(',').filter(Boolean) : undefined;

    const eventTypeParam = c.req.query('event_type');
    if (eventTypeParam && !EVENT_TYPES.includes(eventTypeParam as EventType)) {
      throw new ValidationError('invalid event_type');
    }
    const event_type = eventTypeParam as EventType | undefined;

    const result = await waitForEvent(db, teamId, { since_id, timeout_sec, topics, event_type });
    return c.json(result);
  });

  // GET /events — get_updates
  router.get('/', async (c) => {
    const { teamId, agentId } = c.get('auth');

    const sinceIdParam = c.req.query('since_id');
    const sinceTimestamp = c.req.query('since_timestamp');
    const topicsParam = c.req.query('topics');
    const limitParam = c.req.query('limit');
    const includeContextParam = c.req.query('include_context');

    const since_id = sinceIdParam ? parseInt(sinceIdParam, 10) : undefined;
    const topics = topicsParam ? topicsParam.split(',').filter(Boolean) : undefined;
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    const include_context = includeContextParam === 'false' ? false : true;

    const result = await getUpdates(db, teamId, {
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
