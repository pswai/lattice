import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  defineProfile,
  listProfiles,
  getProfile,
  deleteProfile,
} from '../../models/profile.js';
import { ValidationError } from '../../errors.js';

const DefineProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(10_000),
  system_prompt: z.string().min(1).max(100_000),
  default_capabilities: z.array(z.string().max(100)).max(50).optional(),
  default_tags: z.array(z.string().max(50)).max(20).optional(),
});

export function createProfileRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // POST /profiles — define (upsert)
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = DefineProfileSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId, agentId } = c.get('auth');
    const result = defineProfile(db, teamId, agentId, parsed.data);
    return c.json(result, 201);
  });

  // GET /profiles — list
  router.get('/', (c) => {
    const { teamId } = c.get('auth');
    const result = listProfiles(db, teamId);
    return c.json(result);
  });

  // GET /profiles/:name — get one
  router.get('/:name', (c) => {
    const { teamId } = c.get('auth');
    const name = c.req.param('name');
    const result = getProfile(db, teamId, name);
    return c.json(result);
  });

  // DELETE /profiles/:name — delete
  router.delete('/:name', (c) => {
    const { teamId } = c.get('auth');
    const name = c.req.param('name');
    const result = deleteProfile(db, teamId, name);
    return c.json(result);
  });

  return router;
}
