import type Database from 'better-sqlite3';
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
  team_id: string;
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
    teamId: row.team_id,
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
    teamId: row.team_id,
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

export function saveArtifact(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: SaveArtifactInput,
): SaveArtifactResponse {
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

  const existing = db
    .prepare('SELECT id FROM artifacts WHERE team_id = ? AND key = ?')
    .get(teamId, input.key) as { id: number } | undefined;

  let artifactId: number;
  if (existing) {
    db.prepare(`
      UPDATE artifacts
      SET content_type = ?, content = ?, metadata = ?, size = ?, created_by = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE team_id = ? AND key = ?
    `).run(input.content_type, input.content, metadataJson, size, agentId, teamId, input.key);
    artifactId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO artifacts (team_id, key, content_type, content, metadata, size, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(teamId, input.key, input.content_type, input.content, metadataJson, size, agentId);
    artifactId = Number(result.lastInsertRowid);
  }

  return {
    id: artifactId,
    key: input.key,
    size,
    created: !existing,
  };
}

export function getArtifact(
  db: Database.Database,
  teamId: string,
  key: string,
): Artifact {
  const row = db
    .prepare('SELECT * FROM artifacts WHERE team_id = ? AND key = ?')
    .get(teamId, key) as ArtifactRow | undefined;
  if (!row) {
    throw new NotFoundError('Artifact', key);
  }
  return rowToArtifact(row);
}

export function listArtifacts(
  db: Database.Database,
  teamId: string,
  input: ListArtifactsInput,
): ListArtifactsResponse {
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
    rows = db.prepare(`
      SELECT id, team_id, key, content_type, metadata, size, created_by, created_at, updated_at
      FROM artifacts
      WHERE team_id = ? AND content_type = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(teamId, input.content_type, limit) as Omit<ArtifactRow, 'content'>[];
    total = (db.prepare(
      'SELECT COUNT(*) as cnt FROM artifacts WHERE team_id = ? AND content_type = ?',
    ).get(teamId, input.content_type) as { cnt: number }).cnt;
  } else {
    rows = db.prepare(`
      SELECT id, team_id, key, content_type, metadata, size, created_by, created_at, updated_at
      FROM artifacts
      WHERE team_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(teamId, limit) as Omit<ArtifactRow, 'content'>[];
    total = (db.prepare(
      'SELECT COUNT(*) as cnt FROM artifacts WHERE team_id = ?',
    ).get(teamId) as { cnt: number }).cnt;
  }

  return {
    artifacts: rows.map(rowToSummary),
    total,
  };
}

export function deleteArtifact(
  db: Database.Database,
  teamId: string,
  key: string,
): { deleted: boolean } {
  const result = db
    .prepare('DELETE FROM artifacts WHERE team_id = ? AND key = ?')
    .run(teamId, key);
  if (result.changes === 0) {
    throw new NotFoundError('Artifact', key);
  }
  return { deleted: true };
}
