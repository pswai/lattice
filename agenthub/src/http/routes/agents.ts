import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { registerAgent, heartbeat, listAgents } from '../../models/agent.js';
import { ValidationError } from '../../errors.js';

const RegisterAgentSchema = z.object({
  agent_id: z.string().min(1).max(100),
  capabilities: z.array(z.string().max(100)).max(50),
  status: z.enum(['online', 'offline', 'busy']).optional(),
  metadata: z.record(z.unknown()).optional().refine(
    (v) => v === undefined || JSON.stringify(v).length <= 10_240,
    { message: 'metadata must be under 10 KB when serialized' },
  ),
});

const HeartbeatSchema = z.object({
  status: z.enum(['online', 'offline', 'busy']).optional(),
});

export function createAgentRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /agents — register or update an agent
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = RegisterAgentSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { workspaceId } = c.get('auth');
    const result = await registerAgent(db, workspaceId, parsed.data);
    return c.json(result, 201);
  });

  // GET /agents — list agents with optional filters
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');
    const capability = c.req.query('capability');
    const status = c.req.query('status') as 'online' | 'offline' | 'busy' | undefined;

    const result = await listAgents(db, workspaceId, { capability, status });
    return c.json(result);
  });

  // POST /agents/:id/heartbeat — keep agent alive
  router.post('/:id/heartbeat', async (c) => {
    const agentId = c.req.param('id');
    const { workspaceId } = c.get('auth');
    const body = await c.req.json().catch(() => ({}));
    const parsed = HeartbeatSchema.safeParse(body);

    const result = await heartbeat(db, workspaceId, agentId, parsed.success ? parsed.data.status : undefined);
    return c.json(result);
  });

  return router;
}
