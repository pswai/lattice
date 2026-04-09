import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import { registerAgent, heartbeat, listAgents } from '../../models/agent.js';
import { validate, optionalInt } from '../validation.js';

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
  metadata: z.record(z.unknown()).optional().refine(
    (v) => v === undefined || JSON.stringify(v).length <= 10_240,
    { message: 'metadata must be under 10 KB when serialized' },
  ),
});

export function createAgentRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /agents — register or update an agent
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(RegisterAgentSchema, body);

    const { workspaceId } = c.get('auth');
    const result = await registerAgent(db, workspaceId, parsed);
    return c.json(result, 201);
  });

  // GET /agents — list agents with optional filters
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');
    const capability = c.req.query('capability');
    const status = c.req.query('status') as 'online' | 'offline' | 'busy' | undefined;
    const activeWithinMinutes = optionalInt(c.req.query('active_within_minutes'), 'active_within_minutes', { min: 1 });
    const metadataContains = c.req.query('metadata_contains');

    const result = await listAgents(db, workspaceId, {
      capability, status,
      active_within_minutes: activeWithinMinutes,
      metadata_contains: metadataContains,
    });
    return c.json(result);
  });

  // POST /agents/:id/heartbeat — keep agent alive
  router.post('/:id/heartbeat', async (c) => {
    const agentId = c.req.param('id');
    const { workspaceId } = c.get('auth');
    const body = await c.req.json().catch(() => ({}));
    const parsed = HeartbeatSchema.safeParse(body);

    const result = await heartbeat(db, workspaceId, agentId,
      parsed.success ? parsed.data.status : undefined,
      parsed.success ? parsed.data.metadata : undefined);
    return c.json(result);
  });

  return router;
}
