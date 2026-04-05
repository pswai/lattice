import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { registerAgent, heartbeat, listAgents } from '../../models/agent.js';
import { ValidationError } from '../../errors.js';

const RegisterAgentSchema = z.object({
  agent_id: z.string().min(1).max(100),
  capabilities: z.array(z.string().max(100)).max(50),
  status: z.enum(['online', 'offline', 'busy']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const HeartbeatSchema = z.object({
  status: z.enum(['online', 'offline', 'busy']).optional(),
});

export function createAgentRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // POST /agents — register or update an agent
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = RegisterAgentSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId } = c.get('auth');
    const result = registerAgent(db, teamId, parsed.data);
    return c.json(result, 201);
  });

  // GET /agents — list agents with optional filters
  router.get('/', (c) => {
    const { teamId } = c.get('auth');
    const capability = c.req.query('capability');
    const status = c.req.query('status') as 'online' | 'offline' | 'busy' | undefined;

    const result = listAgents(db, teamId, { capability, status });
    return c.json(result);
  });

  // POST /agents/:id/heartbeat — keep agent alive
  router.post('/:id/heartbeat', async (c) => {
    const agentId = c.req.param('id');
    const { teamId } = c.get('auth');
    const body = await c.req.json().catch(() => ({}));
    const parsed = HeartbeatSchema.safeParse(body);

    const result = heartbeat(db, teamId, agentId, parsed.success ? parsed.data.status : undefined);
    return c.json(result);
  });

  return router;
}
