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
  updated_by: string | null;
  updated_at: string | null;
  expires_at: string | null;
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
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? null,
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

/** Upsert a context entry by key and broadcast a LEARNING event. */
export async function saveContext(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: SaveContextInput,
): Promise<SaveContextResponse> {
  // Check if key exists for this team to determine created vs replaced
  const existing = await db.get<{ id: number; value: string }>(
    'SELECT id, value FROM context_entries WHERE workspace_id = ? AND key = ?',
    workspaceId, input.key,
  );

  let entryId: number;

  const now = new Date().toISOString();
  const expiresAt = input.ttl_seconds
    ? new Date(Date.now() + input.ttl_seconds * 1000).toISOString()
    : null;

  if (existing) {
    // Update in place — preserves the original ID
    await db.run(`
      UPDATE context_entries SET value = ?, tags = ?, updated_by = ?, updated_at = ?, expires_at = ?
      WHERE workspace_id = ? AND key = ?
    `, input.value, JSON.stringify(input.tags), agentId, now, expiresAt, workspaceId, input.key);
    entryId = existing.id;
  } else {
    const result = await db.run(`
      INSERT INTO context_entries (workspace_id, key, value, tags, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, workspaceId, input.key, input.value, JSON.stringify(input.tags), agentId, now, expiresAt);
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

/** Delete a context entry by key. */
export async function deleteContext(
  db: DbAdapter,
  workspaceId: string,
  key: string,
): Promise<{ deleted: boolean }> {
  const result = await db.run(
    'DELETE FROM context_entries WHERE workspace_id = ? AND key = ?',
    workspaceId, key,
  );
  return { deleted: result.changes > 0 };
}

/** Full-text search over context entries (SQLite FTS5 / Postgres pg_trgm). */
export async function getContext(
  db: DbAdapter,
  workspaceId: string,
  input: GetContextInput,
): Promise<GetContextResponse> {
  return getContextWithBuilder(db, workspaceId, input);
}

// ---------------------------------------------------------------------------
// Query builder — shared logic for SQLite and Postgres context search
// ---------------------------------------------------------------------------

interface QueryParts {
  from: string;
  conditions: string[];
  params: unknown[];
  orderBy: string;
  /** Extra params appended after conditions (e.g. similarity() args in ORDER BY) */
  orderParams: unknown[];
}

function buildContextQuery(
  dialect: 'sqlite' | 'pg',
  workspaceId: string,
  input: GetContextInput,
): QueryParts {
  const hasTags = input.tags && input.tags.length > 0;
  const hasQuery = input.query && input.query.trim().length > 0;

  const conditions: string[] = ['ce.workspace_id = ?', '(ce.expires_at IS NULL OR ce.expires_at > ?)'];
  const params: unknown[] = [workspaceId, new Date().toISOString()];
  const orderParams: unknown[] = [];

  // Default FROM and ORDER
  let from = 'context_entries ce';
  let orderBy = 'ce.created_at DESC';

  // --- Creator filter ---
  if (input.created_by) {
    conditions.push('ce.created_by = ?');
    params.push(input.created_by);
  }

  // --- Tag filtering (same structure, dialect-specific json function) ---
  if (hasTags) {
    const placeholders = input.tags!.map(() => '?').join(', ');
    if (dialect === 'sqlite') {
      conditions.push(`EXISTS (
            SELECT 1 FROM ${jsonArrayTable(dialect, 'ce.tags', 't')}
            WHERE t.value IN (${placeholders})
          )`);
    } else {
      conditions.push(`EXISTS (
            SELECT 1 FROM ${jsonArrayTable('pg', 'ce.tags')} AS t
            WHERE t IN (${placeholders})
          )`);
    }
    params.push(...input.tags!);
  }

  // --- Text search (dialect-specific) ---
  if (hasQuery && dialect === 'sqlite') {
    const useLike = needsLikeFallback(input.query!);
    if (useLike) {
      // LIKE fallback for short tokens
      const likeParts: string[] = [];
      for (const t of queryTokens(input.query!)) {
        const pat = `%${escapeLikeToken(t)}%`;
        likeParts.push("(ce.key LIKE ? ESCAPE '\\' OR ce.value LIKE ? ESCAPE '\\' OR ce.tags LIKE ? ESCAPE '\\')");
        params.push(pat, pat, pat);
      }
      conditions.push(likeParts.join(' AND '));
      // LIKE fallback uses recency ordering
    } else {
      // FTS5 path
      const ftsQuery = escapeFts5Query(input.query!);
      from = 'context_entries ce\n        JOIN context_entries_fts fts ON ce.id = fts.rowid';
      conditions.push('context_entries_fts MATCH ?');
      params.push(ftsQuery);
      orderBy = 'bm25(context_entries_fts, 10.0, 1.0, 5.0)';
    }
  } else if (hasQuery && dialect === 'pg') {
    // ILIKE search
    const tokens = input.query!.trim().split(/\s+/).filter(Boolean);
    const ilikeParts: string[] = [];
    for (const t of tokens) {
      const pat = `%${escapeLikeToken(t)}%`;
      ilikeParts.push('(ce.key ILIKE ? OR ce.value ILIKE ? OR ce.tags::text ILIKE ?)');
      params.push(pat, pat, pat);
    }
    conditions.push(ilikeParts.join(' AND '));
    orderBy = '(similarity(ce.key, ?) + similarity(ce.value, ?)) DESC';
    orderParams.push(input.query!, input.query!);
  }

  return { from, conditions, params, orderBy, orderParams };
}

async function getContextWithBuilder(
  db: DbAdapter,
  workspaceId: string,
  input: GetContextInput,
): Promise<GetContextResponse> {
  const limit = Math.min(input.limit ?? 20, 100);
  const hasQuery = !!(input.query && input.query.trim().length > 0);
  const qp = buildContextQuery(db.dialect, workspaceId, input);

  const where = qp.conditions.join('\n          AND ');

  // Data query (with ORDER BY + LIMIT)
  const dataSql = `
        SELECT ce.* FROM ${qp.from}
        WHERE ${where}
        ORDER BY ${qp.orderBy}
        LIMIT ?`;
  const rows = await db.all<ContextRow>(dataSql, ...qp.params, ...qp.orderParams, limit);

  // Count query (no ORDER BY, no LIMIT)
  const countSql = `
        SELECT COUNT(*) as cnt FROM ${qp.from}
        WHERE ${where}`;
  const countRow = await db.get<{ cnt: number }>(countSql, ...qp.params);
  const total = countRow!.cnt;

  return {
    entries: rows.map(r => rowToEntry(r, hasQuery)),
    total,
  };
}
