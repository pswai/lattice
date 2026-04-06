import type { DbAdapter } from '../db/adapter.js';
import { jsonArrayTable } from '../db/adapter.js';
import type { ContextEntry, SaveContextInput, GetContextInput, SaveContextResponse, GetContextResponse } from './types.js';
import { broadcastInternal } from './event.js';
import { ValidationError } from '../errors.js';

/** Max value length returned in search results to prevent response size blowup */
const SEARCH_VALUE_TRUNCATE = 10_000;

interface ContextRow {
  id: number;
  workspace_id: string;
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
    workspaceId: row.workspace_id,
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

export async function saveContext(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: SaveContextInput,
): Promise<SaveContextResponse> {
  // Check if key exists for this team to determine created vs replaced
  const existing = await db.get<{ id: number }>(
    'SELECT id FROM context_entries WHERE workspace_id = ? AND key = ?',
    workspaceId, input.key,
  );

  let entryId: number;

  if (existing) {
    // Update in place — preserves the original ID
    await db.run(`
      UPDATE context_entries SET value = ?, tags = ?, created_by = ?,
        created_at = ?
      WHERE workspace_id = ? AND key = ?
    `, input.value, JSON.stringify(input.tags), agentId, new Date().toISOString(), workspaceId, input.key);
    entryId = existing.id;
  } else {
    const result = await db.run(`
      INSERT INTO context_entries (workspace_id, key, value, tags, created_by)
      VALUES (?, ?, ?, ?, ?)
    `, workspaceId, input.key, input.value, JSON.stringify(input.tags), agentId);
    entryId = Number(result.lastInsertRowid);
  }

  // Auto-broadcast LEARNING event after successful save
  await broadcastInternal(
    db, workspaceId, 'LEARNING',
    `Context saved: "${input.key}" by ${agentId}`,
    input.tags, agentId,
  );

  return {
    id: entryId,
    key: input.key,
    created: !existing,
  };
}

export async function getContext(
  db: DbAdapter,
  workspaceId: string,
  input: GetContextInput,
): Promise<GetContextResponse> {
  if (db.dialect === 'pg') {
    return getContextPg(db, workspaceId, input);
  } else {
    return getContextSqlite(db, workspaceId, input);
  }
}

// ---------------------------------------------------------------------------
// SQLite path — FTS5 MATCH with LIKE fallback for short tokens
// ---------------------------------------------------------------------------

async function getContextSqlite(
  db: DbAdapter,
  workspaceId: string,
  input: GetContextInput,
): Promise<GetContextResponse> {
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
      rows = await db.all<ContextRow>(`
        SELECT ce.* FROM context_entries ce
        WHERE ce.workspace_id = ?
          AND EXISTS (
            SELECT 1 FROM ${jsonArrayTable(db.dialect, 'ce.tags', 't')}
            WHERE t.value IN (${placeholders})
          )
          AND ${likeClause}
        ORDER BY ce.created_at DESC
        LIMIT ?
      `, workspaceId, ...input.tags!, ...likeParams, limit);
    } else {
      const ftsQuery = escapeFts5Query(input.query!);
      rows = await db.all<ContextRow>(`
        SELECT ce.* FROM context_entries ce
        JOIN context_entries_fts fts ON ce.id = fts.rowid
        WHERE ce.workspace_id = ?
          AND EXISTS (
            SELECT 1 FROM ${jsonArrayTable(db.dialect, 'ce.tags', 't')}
            WHERE t.value IN (${placeholders})
          )
          AND context_entries_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `, workspaceId, ...input.tags!, ftsQuery, limit);
    }
  } else if (hasQuery) {
    if (useLike) {
      rows = await db.all<ContextRow>(`
        SELECT ce.* FROM context_entries ce
        WHERE ce.workspace_id = ?
          AND ${likeClause}
        ORDER BY ce.created_at DESC
        LIMIT ?
      `, workspaceId, ...likeParams, limit);
    } else {
      const ftsQuery = escapeFts5Query(input.query!);
      rows = await db.all<ContextRow>(`
        SELECT ce.* FROM context_entries ce
        JOIN context_entries_fts fts ON ce.id = fts.rowid
        WHERE ce.workspace_id = ?
          AND context_entries_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `, workspaceId, ftsQuery, limit);
    }
  } else if (hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    rows = await db.all<ContextRow>(`
      SELECT ce.* FROM context_entries ce
      WHERE ce.workspace_id = ?
        AND EXISTS (
          SELECT 1 FROM ${jsonArrayTable(db.dialect, 'ce.tags', 't')}
          WHERE t.value IN (${placeholders})
        )
      ORDER BY ce.created_at DESC
      LIMIT ?
    `, workspaceId, ...input.tags!, limit);
  } else {
    // No filters — browse all entries for this team
    rows = await db.all<ContextRow>(`
      SELECT * FROM context_entries
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, workspaceId, limit);
  }

  // Compute true total (not capped by LIMIT) for proper pagination
  let total: number;
  if (hasQuery && hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    if (useLike) {
      const countRow = await db.get<{ cnt: number }>(`
        SELECT COUNT(*) as cnt FROM context_entries ce
        WHERE ce.workspace_id = ?
          AND EXISTS (
            SELECT 1 FROM ${jsonArrayTable(db.dialect, 'ce.tags', 't')}
            WHERE t.value IN (${placeholders})
          )
          AND ${likeClause}
      `, workspaceId, ...input.tags!, ...likeParams);
      total = countRow!.cnt;
    } else {
      const ftsQuery = escapeFts5Query(input.query!);
      const countRow = await db.get<{ cnt: number }>(`
        SELECT COUNT(*) as cnt FROM context_entries ce
        JOIN context_entries_fts fts ON ce.id = fts.rowid
        WHERE ce.workspace_id = ?
          AND EXISTS (
            SELECT 1 FROM ${jsonArrayTable(db.dialect, 'ce.tags', 't')}
            WHERE t.value IN (${placeholders})
          )
          AND context_entries_fts MATCH ?
      `, workspaceId, ...input.tags!, ftsQuery);
      total = countRow!.cnt;
    }
  } else if (hasQuery) {
    if (useLike) {
      const countRow = await db.get<{ cnt: number }>(`
        SELECT COUNT(*) as cnt FROM context_entries ce
        WHERE ce.workspace_id = ?
          AND ${likeClause}
      `, workspaceId, ...likeParams);
      total = countRow!.cnt;
    } else {
      const ftsQuery = escapeFts5Query(input.query!);
      const countRow = await db.get<{ cnt: number }>(`
        SELECT COUNT(*) as cnt FROM context_entries ce
        JOIN context_entries_fts fts ON ce.id = fts.rowid
        WHERE ce.workspace_id = ?
          AND context_entries_fts MATCH ?
      `, workspaceId, ftsQuery);
      total = countRow!.cnt;
    }
  } else if (hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    const countRow = await db.get<{ cnt: number }>(`
      SELECT COUNT(*) as cnt FROM context_entries ce
      WHERE ce.workspace_id = ?
        AND EXISTS (
          SELECT 1 FROM ${jsonArrayTable(db.dialect, 'ce.tags', 't')}
          WHERE t.value IN (${placeholders})
        )
    `, workspaceId, ...input.tags!);
    total = countRow!.cnt;
  } else {
    const countRow = await db.get<{ cnt: number }>(`
      SELECT COUNT(*) as cnt FROM context_entries WHERE workspace_id = ?
    `, workspaceId);
    total = countRow!.cnt;
  }

  return {
    entries: rows.map(r => rowToEntry(r, hasQuery === true)),
    total,
  };
}

// ---------------------------------------------------------------------------
// Postgres path — ILIKE + pg_trgm similarity() for relevance ordering
// ---------------------------------------------------------------------------

async function getContextPg(
  db: DbAdapter,
  workspaceId: string,
  input: GetContextInput,
): Promise<GetContextResponse> {
  const limit = Math.min(input.limit ?? 20, 100);
  const hasTags = input.tags && input.tags.length > 0;
  const hasQuery = input.query && input.query.trim().length > 0;

  const jsonArr = jsonArrayTable('pg', 'ce.tags');

  // Build ILIKE clause + params for text search (one AND-ed clause per token,
  // each token must match at least one of key/value/tags).
  let ilikeClause = '';
  const ilikeParams: string[] = [];
  if (hasQuery) {
    const tokens = input.query!.trim().split(/\s+/).filter(Boolean);
    const parts: string[] = [];
    for (const t of tokens) {
      const pat = `%${escapeLikeToken(t)}%`;
      parts.push("(ce.key ILIKE ? OR ce.value ILIKE ? OR ce.tags::text ILIKE ?)");
      ilikeParams.push(pat, pat, pat);
    }
    ilikeClause = parts.join(' AND ');
  }

  let rows: ContextRow[];

  if (hasQuery && hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    rows = await db.all<ContextRow>(`
      SELECT ce.* FROM context_entries ce
      WHERE ce.workspace_id = ?
        AND EXISTS (
          SELECT 1 FROM ${jsonArr} AS t
          WHERE t IN (${placeholders})
        )
        AND ${ilikeClause}
      ORDER BY (similarity(ce.key, ?) + similarity(ce.value, ?)) DESC
      LIMIT ?
    `, workspaceId, ...input.tags!, ...ilikeParams, input.query!, input.query!, limit);
  } else if (hasQuery) {
    rows = await db.all<ContextRow>(`
      SELECT ce.* FROM context_entries ce
      WHERE ce.workspace_id = ?
        AND ${ilikeClause}
      ORDER BY (similarity(ce.key, ?) + similarity(ce.value, ?)) DESC
      LIMIT ?
    `, workspaceId, ...ilikeParams, input.query!, input.query!, limit);
  } else if (hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    rows = await db.all<ContextRow>(`
      SELECT ce.* FROM context_entries ce
      WHERE ce.workspace_id = ?
        AND EXISTS (
          SELECT 1 FROM ${jsonArr} AS t
          WHERE t IN (${placeholders})
        )
      ORDER BY ce.created_at DESC
      LIMIT ?
    `, workspaceId, ...input.tags!, limit);
  } else {
    // No filters — browse all entries for this team
    rows = await db.all<ContextRow>(`
      SELECT * FROM context_entries
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, workspaceId, limit);
  }

  // Compute true total (not capped by LIMIT) for proper pagination
  let total: number;
  if (hasQuery && hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    const countRow = await db.get<{ cnt: number }>(`
      SELECT COUNT(*) as cnt FROM context_entries ce
      WHERE ce.workspace_id = ?
        AND EXISTS (
          SELECT 1 FROM ${jsonArr} AS t
          WHERE t IN (${placeholders})
        )
        AND ${ilikeClause}
    `, workspaceId, ...input.tags!, ...ilikeParams);
    total = countRow!.cnt;
  } else if (hasQuery) {
    const countRow = await db.get<{ cnt: number }>(`
      SELECT COUNT(*) as cnt FROM context_entries ce
      WHERE ce.workspace_id = ?
        AND ${ilikeClause}
    `, workspaceId, ...ilikeParams);
    total = countRow!.cnt;
  } else if (hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    const countRow = await db.get<{ cnt: number }>(`
      SELECT COUNT(*) as cnt FROM context_entries ce
      WHERE ce.workspace_id = ?
        AND EXISTS (
          SELECT 1 FROM ${jsonArr} AS t
          WHERE t IN (${placeholders})
        )
    `, workspaceId, ...input.tags!);
    total = countRow!.cnt;
  } else {
    const countRow = await db.get<{ cnt: number }>(`
      SELECT COUNT(*) as cnt FROM context_entries WHERE workspace_id = ?
    `, workspaceId);
    total = countRow!.cnt;
  }

  return {
    entries: rows.map(r => rowToEntry(r, hasQuery === true)),
    total,
  };
}
