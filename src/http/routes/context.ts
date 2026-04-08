import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { saveContext, getContext } from '../../models/context.js';
import { throwIfSecretsFound } from '../../services/secret-scanner.js';
import { validate, optionalInt } from '../validation.js';

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
    const parsed = validate(SaveContextSchema, body);
    const { workspaceId, agentId } = c.get('auth');

    // Secret scan on both key and value
    for (const field of [parsed.key, parsed.value]) {
      throwIfSecretsFound(field);
    }

    // saveContext handles both DB write and auto-broadcast of LEARNING event
    const result = await saveContext(db, workspaceId, agentId, parsed);

    return c.json(result, 201);
  });

  // GET /context — get_context
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');

    const query = c.req.query('query') || '';
    const tagsParam = c.req.query('tags');
    const tags = tagsParam ? tagsParam.split(',').filter(Boolean) : undefined;
    const limit = optionalInt(c.req.query('limit'), 'limit', { min: 1 });

    const result = await getContext(db, workspaceId, { query, tags, limit });
    return c.json(result);
  });

  return router;
}
