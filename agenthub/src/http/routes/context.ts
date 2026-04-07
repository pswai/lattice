import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { saveContext, getContext } from '../../models/context.js';
import { throwIfSecretsFound } from '../../services/secret-scanner.js';
import { ValidationError } from '../../errors.js';

const SaveContextSchema = z.object({
  key: z.string().min(1).max(255),
  value: z.string().min(1).max(100_000),
  tags: z.array(z.string().max(50)).max(20),
});

export function createContextRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /context — save_context
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = SaveContextSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { workspaceId, agentId } = c.get('auth');

    // Secret scan on both key and value
    for (const field of [parsed.data.key, parsed.data.value]) {
      throwIfSecretsFound(field);
    }

    // saveContext handles both DB write and auto-broadcast of LEARNING event
    const result = await saveContext(db, workspaceId, agentId, parsed.data);

    return c.json(result, 201);
  });

  // GET /context — get_context
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');

    const query = c.req.query('query') || '';
    const tagsParam = c.req.query('tags');
    const limitParam = c.req.query('limit');

    const tags = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;
    const limit = limitParam !== undefined ? parseInt(limitParam, 10) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      throw new ValidationError('limit must be a positive integer');
    }

    const result = await getContext(db, workspaceId, { query, tags, limit });
    return c.json(result);
  });

  return router;
}
