import type Database from 'better-sqlite3';
import type { ContextEntry, SaveContextInput, GetContextInput, SaveContextResponse, GetContextResponse } from './types.js';
import { broadcastInternal } from './event.js';
import { ValidationError } from '../errors.js';

/** Max value length returned in search results to prevent response size blowup */
const SEARCH_VALUE_TRUNCATE = 10_000;

interface ContextRow {
  id: number;
  team_id: string;
  key: string;
  value: string;
  tags: string;
  created_by: string;
  created_at: string;
}

function rowToEntry(row: ContextRow, truncate = false): ContextEntry {
  let value = row.value;
  if (truncate && value.length > SEARCH_VALUE_TRUNCATE) {
    value = value.slice(0, SEARCH_VALUE_TRUNCATE) + `... [truncated, ${row.value.length} chars total]`;
  }
  return {
    id: row.id,
    teamId: row.team_id,
    key: row.key,
    value,
    tags: JSON.parse(row.tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Escape special FTS5 query syntax characters.
 * FTS5 treats - * " ( ) : ^ as operators. Wrap each token in double quotes
 * to force literal matching. The trigram tokenizer handles short queries and
 * substring matches natively, so no prefix-wildcard fallback is needed.
 */
function escapeFts5Query(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * The trigram tokenizer only matches tokens of length >= 3. For shorter
 * query tokens (1-2 chars) fall back to a LIKE-based substring scan over
 * key, value, and tags so results are still returned.
 */
function queryTokens(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}

function needsLikeFallback(query: string): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return false;
  return tokens.some(t => t.length < 3);
}

function escapeLikeToken(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function saveContext(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: SaveContextInput,
): SaveContextResponse {
  // Check if key exists for this team to determine created vs replaced
  const existing = db.prepare(
    'SELECT id FROM context_entries WHERE team_id = ? AND key = ?',
  ).get(teamId, input.key) as { id: number } | undefined;

  let entryId: number;

  if (existing) {
    // Update in place — preserves the original ID
    db.prepare(`
      UPDATE context_entries SET value = ?, tags = ?, created_by = ?,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE team_id = ? AND key = ?
    `).run(input.value, JSON.stringify(input.tags), agentId, teamId, input.key);
    entryId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO context_entries (team_id, key, value, tags, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(teamId, input.key, input.value, JSON.stringify(input.tags), agentId);
    entryId = Number(result.lastInsertRowid);
  }

  // Auto-broadcast LEARNING event after successful save
  broadcastInternal(
    db, teamId, 'LEARNING',
    `Context saved: "${input.key}" by ${agentId}`,
    input.tags, agentId,
  );

  return {
    id: entryId,
    key: input.key,
    created: !existing,
  };
}

export function getContext(
  db: Database.Database,
  teamId: string,
  input: GetContextInput,
): GetContextResponse {
  const limit = Math.min(input.limit ?? 20, 100);
  const hasTags = input.tags && input.tags.length > 0;
  const hasQuery = input.query && input.query.trim().length > 0;
  const useLike = hasQuery && needsLikeFallback(input.query!);

  // Build LIKE clause + params for short-query fallback (one AND-ed clause
  // per token, each matching key/value/tags).
  let likeClause = '';
  const likeParams: string[] = [];
  if (useLike) {
    const parts: string[] = [];
    for (const t of queryTokens(input.query!)) {
      const pat = `%${escapeLikeToken(t)}%`;
      parts.push("(ce.key LIKE ? ESCAPE '\\' OR ce.value LIKE ? ESCAPE '\\' OR ce.tags LIKE ? ESCAPE '\\')");
      likeParams.push(pat, pat, pat);
    }
    likeClause = parts.join(' AND ');
  }

  let rows: ContextRow[];

  if (hasQuery && hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    if (useLike) {
      rows = db.prepare(`
        SELECT ce.* FROM context_entries ce
        WHERE ce.team_id = ?
          AND EXISTS (
            SELECT 1 FROM json_each(ce.tags) AS t
            WHERE t.value IN (${placeholders})
          )
          AND ${likeClause}
        ORDER BY ce.created_at DESC
        LIMIT ?
      `).all(teamId, ...input.tags!, ...likeParams, limit) as ContextRow[];
    } else {
      const ftsQuery = escapeFts5Query(input.query!);
      rows = db.prepare(`
        SELECT ce.* FROM context_entries ce
        JOIN context_entries_fts fts ON ce.id = fts.rowid
        WHERE ce.team_id = ?
          AND EXISTS (
            SELECT 1 FROM json_each(ce.tags) AS t
            WHERE t.value IN (${placeholders})
          )
          AND context_entries_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `).all(teamId, ...input.tags!, ftsQuery, limit) as ContextRow[];
    }
  } else if (hasQuery) {
    if (useLike) {
      rows = db.prepare(`
        SELECT ce.* FROM context_entries ce
        WHERE ce.team_id = ?
          AND ${likeClause}
        ORDER BY ce.created_at DESC
        LIMIT ?
      `).all(teamId, ...likeParams, limit) as ContextRow[];
    } else {
      const ftsQuery = escapeFts5Query(input.query!);
      rows = db.prepare(`
        SELECT ce.* FROM context_entries ce
        JOIN context_entries_fts fts ON ce.id = fts.rowid
        WHERE ce.team_id = ?
          AND context_entries_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `).all(teamId, ftsQuery, limit) as ContextRow[];
    }
  } else if (hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    rows = db.prepare(`
      SELECT ce.* FROM context_entries ce
      WHERE ce.team_id = ?
        AND EXISTS (
          SELECT 1 FROM json_each(ce.tags) AS t
          WHERE t.value IN (${placeholders})
        )
      ORDER BY ce.created_at DESC
      LIMIT ?
    `).all(teamId, ...input.tags!, limit) as ContextRow[];
  } else {
    // No filters — browse all entries for this team
    rows = db.prepare(`
      SELECT * FROM context_entries
      WHERE team_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(teamId, limit) as ContextRow[];
  }

  // Compute true total (not capped by LIMIT) for proper pagination
  let total: number;
  if (hasQuery && hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    if (useLike) {
      const countRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM context_entries ce
        WHERE ce.team_id = ?
          AND EXISTS (
            SELECT 1 FROM json_each(ce.tags) AS t
            WHERE t.value IN (${placeholders})
          )
          AND ${likeClause}
      `).get(teamId, ...input.tags!, ...likeParams) as { cnt: number };
      total = countRow.cnt;
    } else {
      const ftsQuery = escapeFts5Query(input.query!);
      const countRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM context_entries ce
        JOIN context_entries_fts fts ON ce.id = fts.rowid
        WHERE ce.team_id = ?
          AND EXISTS (
            SELECT 1 FROM json_each(ce.tags) AS t
            WHERE t.value IN (${placeholders})
          )
          AND context_entries_fts MATCH ?
      `).get(teamId, ...input.tags!, ftsQuery) as { cnt: number };
      total = countRow.cnt;
    }
  } else if (hasQuery) {
    if (useLike) {
      const countRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM context_entries ce
        WHERE ce.team_id = ?
          AND ${likeClause}
      `).get(teamId, ...likeParams) as { cnt: number };
      total = countRow.cnt;
    } else {
      const ftsQuery = escapeFts5Query(input.query!);
      const countRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM context_entries ce
        JOIN context_entries_fts fts ON ce.id = fts.rowid
        WHERE ce.team_id = ?
          AND context_entries_fts MATCH ?
      `).get(teamId, ftsQuery) as { cnt: number };
      total = countRow.cnt;
    }
  } else if (hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    const countRow = db.prepare(`
      SELECT COUNT(*) as cnt FROM context_entries ce
      WHERE ce.team_id = ?
        AND EXISTS (
          SELECT 1 FROM json_each(ce.tags) AS t
          WHERE t.value IN (${placeholders})
        )
    `).get(teamId, ...input.tags!) as { cnt: number };
    total = countRow.cnt;
  } else {
    const countRow = db.prepare(`
      SELECT COUNT(*) as cnt FROM context_entries WHERE team_id = ?
    `).get(teamId) as { cnt: number };
    total = countRow.cnt;
  }

  return {
    entries: rows.map(r => rowToEntry(r, hasQuery === true)),
    total,
  };
}
