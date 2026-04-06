import type { DbAdapter } from '../db/adapter.js';
import type {
  Artifact,
  ArtifactContentType,
  ArtifactSummary,
  SaveArtifactInput,
  SaveArtifactResponse,
  ListArtifactsInput,
  ListArtifactsResponse,
} from './types.js';
import { scanForSecrets } from '../services/secret-scanner.js';
import { SecretDetectedError, ValidationError, NotFoundError } from '../errors.js';
import { incrementUsage } from './usage.js';

export const MAX_ARTIFACT_SIZE = 1_048_576; // 1 MB

export const ALLOWED_CONTENT_TYPES: readonly ArtifactContentType[] = [
  'text/plain',
  'text/markdown',
  'text/html',
  'application/json',
  'text/x-typescript',
  'text/x-javascript',
  'text/x-python',
  'text/css',
] as const;

interface ArtifactRow {
  id: number;
  workspace_id: string;
  key: string;
  content_type: string;
  content: string;
  metadata: string;
  size: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.key,
    contentType: row.content_type as ArtifactContentType,
    content: row.content,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    size: row.size,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: Omit<ArtifactRow, 'content'>): ArtifactSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    key: row.key,
    contentType: row.content_type as ArtifactContentType,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    size: row.size,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isAllowedContentType(ct: string): ct is ArtifactContentType {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(ct);
}

export async function saveArtifact(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: SaveArtifactInput,
): Promise<SaveArtifactResponse> {
  if (!isAllowedContentType(input.content_type)) {
    throw new ValidationError(
      `Invalid content_type. Allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}`,
      { content_type: input.content_type },
    );
  }

  const size = Buffer.byteLength(input.content, 'utf8');
  if (size > MAX_ARTIFACT_SIZE) {
    throw new ValidationError(
      `Artifact content exceeds max size of ${MAX_ARTIFACT_SIZE} bytes (got ${size})`,
      { size, max_size: MAX_ARTIFACT_SIZE },
    );
  }

  const scan = scanForSecrets(input.content);
  if (!scan.clean) {
    throw new SecretDetectedError(scan.matches[0].pattern, scan.matches[0].preview);
  }

  const metadataJson = JSON.stringify(input.metadata ?? {});

  const existing = await db.get<{ id: number; size: number }>(
    'SELECT id, size FROM artifacts WHERE workspace_id = ? AND key = ?',
    workspaceId, input.key,
  );

  let artifactId: number;
  if (existing) {
    await db.run(`
      UPDATE artifacts
      SET content_type = ?, content = ?, metadata = ?, size = ?,
          updated_at = ?
      WHERE workspace_id = ? AND key = ?
    `, input.content_type, input.content, metadataJson, size, new Date().toISOString(), workspaceId, input.key);
    artifactId = existing.id;
  } else {
    const result = await db.run(`
      INSERT INTO artifacts (workspace_id, key, content_type, content, metadata, size, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, workspaceId, input.key, input.content_type, input.content, metadataJson, size, agentId);
    artifactId = Number(result.lastInsertRowid);
  }

  // Track storage: new bytes on insert, delta on update
  const delta = size - (existing?.size ?? 0);
  if (delta > 0) {
    await incrementUsage(db, workspaceId, { storageBytes: delta });
  }

  return {
    id: artifactId,
    key: input.key,
    size,
    created: !existing,
  };
}

export async function getArtifact(
  db: DbAdapter,
  workspaceId: string,
  key: string,
): Promise<Artifact> {
  const row = await db.get<ArtifactRow>(
    'SELECT * FROM artifacts WHERE workspace_id = ? AND key = ?',
    workspaceId, key,
  );
  if (!row) {
    throw new NotFoundError('Artifact', key);
  }
  return rowToArtifact(row);
}

export async function listArtifacts(
  db: DbAdapter,
  workspaceId: string,
  input: ListArtifactsInput,
): Promise<ListArtifactsResponse> {
  const limit = Math.min(input.limit ?? 50, 200);

  let rows: Omit<ArtifactRow, 'content'>[];
  let total: number;

  if (input.content_type) {
    if (!isAllowedContentType(input.content_type)) {
      throw new ValidationError(
        `Invalid content_type. Allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}`,
        { content_type: input.content_type },
      );
    }
    rows = await db.all<Omit<ArtifactRow, 'content'>>(`
      SELECT id, workspace_id, key, content_type, metadata, size, created_by, created_at, updated_at
      FROM artifacts
      WHERE workspace_id = ? AND content_type = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `, workspaceId, input.content_type, limit);
    const countRow = await db.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM artifacts WHERE workspace_id = ? AND content_type = ?',
      workspaceId, input.content_type,
    );
    total = countRow!.cnt;
  } else {
    rows = await db.all<Omit<ArtifactRow, 'content'>>(`
      SELECT id, workspace_id, key, content_type, metadata, size, created_by, created_at, updated_at
      FROM artifacts
      WHERE workspace_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `, workspaceId, limit);
    const countRow = await db.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM artifacts WHERE workspace_id = ?',
      workspaceId,
    );
    total = countRow!.cnt;
  }

  return {
    artifacts: rows.map(rowToSummary),
    total,
  };
}

export async function deleteArtifact(
  db: DbAdapter,
  workspaceId: string,
  key: string,
): Promise<{ deleted: boolean }> {
  const result = await db.run(
    'DELETE FROM artifacts WHERE workspace_id = ? AND key = ?',
    workspaceId, key,
  );
  if (result.changes === 0) {
    throw new NotFoundError('Artifact', key);
  }
  return { deleted: true };
}
