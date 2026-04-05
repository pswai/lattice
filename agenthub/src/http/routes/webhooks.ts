import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
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

export function createWebhookRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // POST /webhooks
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = CreateWebhookSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    const { teamId, agentId } = c.get('auth');
    const webhook = createWebhook(db, teamId, agentId, parsed.data);
    return c.json(webhook, 201);
  });

  // GET /webhooks
  router.get('/', (c) => {
    const { teamId } = c.get('auth');
    const webhooks = listWebhooks(db, teamId).map((w) => ({
      ...w,
      secret: w.secret.slice(0, 10) + '...',
    }));
    return c.json({ webhooks, total: webhooks.length });
  });

  // GET /webhooks/:id
  router.get('/:id', (c) => {
    const { teamId } = c.get('auth');
    const wh = getWebhook(db, teamId, c.req.param('id'));
    return c.json({ ...wh, secret: wh.secret.slice(0, 10) + '...' });
  });

  // DELETE /webhooks/:id
  router.delete('/:id', (c) => {
    const { teamId } = c.get('auth');
    const result = deleteWebhook(db, teamId, c.req.param('id'));
    return c.json(result);
  });

  // GET /webhooks/:id/deliveries
  router.get('/:id/deliveries', (c) => {
    const { teamId } = c.get('auth');
    const id = c.req.param('id');
    const limitParam = c.req.query('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 100;
    const deliveries = listDeliveries(db, teamId, id, limit);
    return c.json({ deliveries, total: deliveries.length });
  });

  return router;
}
