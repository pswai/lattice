import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  listDeliveries,
} from '../../models/webhook.js';
import { ValidationError } from '../../errors.js';

const CreateWebhookSchema = z.object({
  url: z.string().min(1).max(2048),
  event_types: z.array(z.string().max(50)).min(1).max(20).optional(),
});

export function createWebhookRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /webhooks
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = CreateWebhookSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    const { workspaceId, agentId } = c.get('auth');
    const webhook = await createWebhook(db, workspaceId, agentId, parsed.data);
    return c.json(webhook, 201);
  });

  // GET /webhooks
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');
    const webhooks = (await listWebhooks(db, workspaceId)).map((w) => ({
      ...w,
      secret: w.secret.slice(0, 10) + '...',
    }));
    return c.json({ webhooks, total: webhooks.length });
  });

  // GET /webhooks/:id
  router.get('/:id', async (c) => {
    const { workspaceId } = c.get('auth');
    const wh = await getWebhook(db, workspaceId, c.req.param('id'));
    return c.json({ ...wh, secret: wh.secret.slice(0, 10) + '...' });
  });

  // DELETE /webhooks/:id
  router.delete('/:id', async (c) => {
    const { workspaceId } = c.get('auth');
    const result = await deleteWebhook(db, workspaceId, c.req.param('id'));
    return c.json(result);
  });

  // GET /webhooks/:id/deliveries
  router.get('/:id/deliveries', async (c) => {
    const { workspaceId } = c.get('auth');
    const id = c.req.param('id');
    const limitParam = c.req.query('limit');
    const limit = limitParam !== undefined ? parseInt(limitParam, 10) : 100;
    if (!Number.isFinite(limit) || limit < 1) {
      throw new ValidationError('limit must be a positive integer');
    }
    const deliveries = await listDeliveries(db, workspaceId, id, limit);
    return c.json({ deliveries, total: deliveries.length });
  });

  return router;
}
