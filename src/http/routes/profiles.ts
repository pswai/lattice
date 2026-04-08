import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import {
  defineProfile,
  listProfiles,
  getProfile,
  deleteProfile,
} from '../../models/profile.js';
import { validate } from '../validation.js';

const DefineProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(10_000),
  system_prompt: z.string().min(1).max(100_000),
  // Accept both REST-style (default_capabilities) and MCP-style (capabilities) field names
  default_capabilities: z.array(z.string().max(100)).max(50).optional(),
  default_tags: z.array(z.string().max(50)).max(20).optional(),
  capabilities: z.array(z.string().max(100)).max(50).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
}).transform((data) => ({
  name: data.name,
  description: data.description,
  system_prompt: data.system_prompt,
  default_capabilities: data.default_capabilities ?? data.capabilities,
  default_tags: data.default_tags ?? data.tags,
}));

export function createProfileRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /profiles — define (upsert)
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(DefineProfileSchema, body);

    const { workspaceId, agentId } = c.get('auth');
    const result = await defineProfile(db, workspaceId, agentId, parsed);
    return c.json(result, 201);
  });

  // GET /profiles — list
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');
    const result = await listProfiles(db, workspaceId);
    return c.json(result);
  });

  // GET /profiles/:name — get one
  router.get('/:name', async (c) => {
    const { workspaceId } = c.get('auth');
    const name = c.req.param('name');
    const result = await getProfile(db, workspaceId, name);
    return c.json(result);
  });

  // DELETE /profiles/:name — delete
  router.delete('/:name', async (c) => {
    const { workspaceId } = c.get('auth');
    const name = c.req.param('name');
    const result = await deleteProfile(db, workspaceId, name);
    return c.json(result);
  });

  return router;
}
