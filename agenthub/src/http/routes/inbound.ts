import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  defineInboundEndpoint,
  listInboundEndpoints,
  deleteInboundEndpoint,
  getInboundEndpointByKey,
  processInboundWebhook,
  verifyHmacSignature,
  type InboundActionType,
} from '../../models/inbound.js';
import { AppError, ValidationError } from '../../errors.js';

const CreateEndpointSchema = z.object({
  name: z.string().min(1).max(200),
  action_type: z.enum(['create_task', 'broadcast_event', 'save_context', 'run_playbook']),
  action_config: z.record(z.unknown()).optional(),
  hmac_secret: z.string().min(8).max(200).optional(),
});

/**
 * Public receiver router — mounted BEFORE auth middleware at /api/v1/inbound.
 * The endpoint_key in the URL IS the auth.
 */
export function createInboundReceiverRoutes(db: Database.Database): Hono {
  const router = new Hono();

  router.post('/:endpoint_key', async (c) => {
    const key = c.req.param('endpoint_key');
    const endpoint = getInboundEndpointByKey(db, key);
    if (!endpoint || !endpoint.active) {
      return c.json({ error: 'NOT_FOUND', message: 'Endpoint not found' }, 404);
    }

    // Read raw body first for HMAC verification, then parse as JSON.
    const bodyRaw = await c.req.text();

    if (endpoint.hmacSecret) {
      const sig = c.req.header('X-AgentHub-Signature');
      if (!verifyHmacSignature(endpoint.hmacSecret, bodyRaw, sig)) {
        return c.json(
          { error: 'UNAUTHORIZED', message: 'Invalid HMAC signature' },
          401,
        );
      }
    }

    let payload: Record<string, unknown> = {};
    if (bodyRaw.length > 0) {
      try {
        const parsed = JSON.parse(bodyRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        } else {
          return c.json(
            { error: 'VALIDATION_ERROR', message: 'Body must be a JSON object' },
            400,
          );
        }
      } catch {
        return c.json(
          { error: 'VALIDATION_ERROR', message: 'Body must be valid JSON' },
          400,
        );
      }
    }

    try {
      const result = processInboundWebhook(db, endpoint, payload);
      return c.json({ ok: true, action_taken: result });
    } catch (err) {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as 400);
      }
      throw err;
    }
  });

  return router;
}

/**
 * Authenticated management router — mounted at /api/v1/inbound behind auth.
 * Lets users create/list/delete endpoints.
 */
export function createInboundManagementRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // POST /inbound — create endpoint
  router.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateEndpointSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', {
        issues: parsed.error.flatten().fieldErrors,
      });
    }
    const { teamId, agentId } = c.get('auth');
    const endpoint = defineInboundEndpoint(db, teamId, agentId, {
      name: parsed.data.name,
      action_type: parsed.data.action_type as InboundActionType,
      action_config: parsed.data.action_config,
      hmac_secret: parsed.data.hmac_secret,
    });
    return c.json(endpoint, 201);
  });

  // GET /inbound — list endpoints
  router.get('/', (c) => {
    const { teamId } = c.get('auth');
    const result = listInboundEndpoints(db, teamId);
    return c.json(result);
  });

  // DELETE /inbound/:id — delete endpoint
  router.delete('/:id', (c) => {
    const { teamId } = c.get('auth');
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new ValidationError('id must be a number');
    }
    const result = deleteInboundEndpoint(db, teamId, id);
    return c.json(result);
  });

  return router;
}
