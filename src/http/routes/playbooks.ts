import { Hono } from 'hono';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import {
  definePlaybook,
  listPlaybooks,
  getPlaybook,
  runPlaybook,
} from '../../models/playbook.js';
import { ValidationError } from '../../errors.js';
import { validate } from '../validation.js';

const PlaybookTaskSchema = z.object({
  description: z.string().min(1).max(10_000),
  role: z.string().max(100).optional(),
  depends_on_index: z.array(z.number().int().nonnegative()).optional(),
});

const DefinePlaybookSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(10_000),
  tasks: z.array(PlaybookTaskSchema),
});

export function createPlaybookRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // POST /playbooks — define (upsert)
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = validate(DefinePlaybookSchema, body);

    const { workspaceId, agentId } = c.get('auth');
    const result = await definePlaybook(db, workspaceId, agentId, parsed);
    return c.json(result, 201);
  });

  // GET /playbooks — list
  router.get('/', async (c) => {
    const { workspaceId } = c.get('auth');
    const result = await listPlaybooks(db, workspaceId);
    return c.json(result);
  });

  // GET /playbooks/:name — get one
  router.get('/:name', async (c) => {
    const { workspaceId } = c.get('auth');
    const name = c.req.param('name');
    const result = await getPlaybook(db, workspaceId, name);
    return c.json(result);
  });

  // POST /playbooks/:name/run — run
  router.post('/:name/run', async (c) => {
    const { workspaceId, agentId } = c.get('auth');
    const name = c.req.param('name');
    let vars: Record<string, string> | undefined;
    // Body is optional; accept { vars: { KEY: "value" } } if present.
    if (c.req.header('content-type')?.includes('application/json')) {
      try {
        const body = await c.req.json();
        if (body && typeof body === 'object' && body.vars !== undefined) {
          const parsed = z.record(z.string()).safeParse(body.vars);
          if (!parsed.success) {
            throw new ValidationError('vars must be an object of string→string');
          }
          vars = parsed.data;
        }
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        // ignore body-parsing errors (empty body)
      }
    }
    const result = await runPlaybook(db, workspaceId, agentId, name, vars);
    return c.json(result, 201);
  });

  return router;
}
