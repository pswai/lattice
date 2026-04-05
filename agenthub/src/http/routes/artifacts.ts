import { Hono } from 'hono';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { saveArtifact, getArtifact, listArtifacts, deleteArtifact, ALLOWED_CONTENT_TYPES } from '../../models/artifact.js';
import { ValidationError } from '../../errors.js';
import type { ArtifactContentType } from '../../models/types.js';

const ContentTypeSchema = z.enum(ALLOWED_CONTENT_TYPES as unknown as [ArtifactContentType, ...ArtifactContentType[]]);

const SaveArtifactSchema = z.object({
  key: z.string().min(1).max(255),
  content_type: ContentTypeSchema,
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export function createArtifactRoutes(db: Database.Database): Hono {
  const router = new Hono();

  // POST /artifacts — save_artifact
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = SaveArtifactSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { teamId, agentId } = c.get('auth');
    const result = saveArtifact(db, teamId, agentId, parsed.data);
    return c.json(result, 201);
  });

  // GET /artifacts — list_artifacts
  router.get('/', (c) => {
    const { teamId } = c.get('auth');

    const contentTypeParam = c.req.query('content_type');
    const limitParam = c.req.query('limit');

    const content_type = contentTypeParam ? (contentTypeParam as ArtifactContentType) : undefined;
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    const result = listArtifacts(db, teamId, { content_type, limit });
    return c.json(result);
  });

  // GET /artifacts/:key — get_artifact
  router.get('/:key', (c) => {
    const { teamId } = c.get('auth');
    const key = c.req.param('key');
    const result = getArtifact(db, teamId, key);
    return c.json(result);
  });

  // DELETE /artifacts/:key — delete_artifact
  router.delete('/:key', (c) => {
    const { teamId } = c.get('auth');
    const key = c.req.param('key');
    const result = deleteArtifact(db, teamId, key);
    return c.json(result);
  });

  return router;
}
