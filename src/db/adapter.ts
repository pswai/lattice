/**
 * Database adapter abstraction — allows Lattice to run against
 * either SQLite (self-hosted / dev) or Postgres (cloud / SaaS).
 *
 * Model code uses:
 *   await db.get<Row>('SELECT * FROM t WHERE id = ?', id)
 * instead of:
 *   db.prepare('SELECT * FROM t WHERE id = ?').get(id)
 *
 * The adapter handles dialect differences (placeholder syntax,
 * INSERT OR IGNORE, etc.) transparently.
 */

import type Database from 'better-sqlite3';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DbAdapter {
  readonly dialect: 'sqlite' | 'pg';

  /** Fetch a single row (or undefined). */
  get<T = any>(sql: string, ...params: any[]): Promise<T | undefined>;

  /** Fetch all matching rows. */
  all<T = any>(sql: string, ...params: any[]): Promise<T[]>;

  /** Execute a mutation (INSERT/UPDATE/DELETE). */
  run(sql: string, ...params: any[]): Promise<RunResult>;

  /** Run multiple statements inside a transaction. */
  transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T>;

  /** Execute raw SQL (DDL, multi-statement). */
  exec(sql: string): Promise<void>;

  /** Close the connection / pool. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQL dialect helpers
// ---------------------------------------------------------------------------

/**
 * Rewrite `?` positional placeholders to Postgres `$1, $2, ...` style.
 * Only transforms `?` outside of string literals (single-quoted).
 */
function rewritePlaceholders(sql: string): string {
  let idx = 0;
  let inString = false;
  let result = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inString) {
      inString = true;
      result += ch;
    } else if (ch === "'" && inString) {
      // Handle escaped single quotes ''
      if (i + 1 < sql.length && sql[i + 1] === "'") {
        result += "''";
        i++;
      } else {
        inString = false;
        result += ch;
      }
    } else if (ch === '?' && !inString) {
      result += `$${++idx}`;
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Rewrite SQLite-specific SQL to Postgres-compatible SQL.
 * - `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
 */
function rewriteSqliteIdioms(sql: string): string {
  return sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
}

/**
 * For `INSERT OR IGNORE` rewriting, we append `ON CONFLICT DO NOTHING`
 * when the original SQL used `INSERT OR IGNORE` (detected before rewrite).
 */
function adaptSql(sql: string, dialect: 'sqlite' | 'pg'): string {
  if (dialect === 'sqlite') return sql;

  const hadOrIgnore = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
  let adapted = rewriteSqliteIdioms(sql);
  if (hadOrIgnore) {
    // Append ON CONFLICT DO NOTHING before any trailing semicolon
    adapted = adapted.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  }
  adapted = rewritePlaceholders(adapted);
  return adapted;
}

// ---------------------------------------------------------------------------
// SQLite adapter
// ---------------------------------------------------------------------------

export class SqliteAdapter implements DbAdapter {
  readonly dialect = 'sqlite' as const;
  constructor(public readonly rawDb: Database.Database) {}

  /**
   * Direct access to better-sqlite3's prepare() for backward compat in tests
   * and the few places that need raw SQL (FTS5 MATCH, PRAGMA, etc.).
   */
  prepare(sql: string): Database.Statement {
    return this.rawDb.prepare(sql);
  }

  /** Direct access to better-sqlite3's pragma() for introspection. */
  pragma(pragma: string): unknown {
    return this.rawDb.pragma(pragma);
  }

  async get<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
    return this.rawDb.prepare(sql).get(...params) as T | undefined;
  }

  async all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
    return this.rawDb.prepare(sql).all(...params) as T[];
  }

  async run(sql: string, ...params: any[]): Promise<RunResult> {
    const result = this.rawDb.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    // better-sqlite3's .transaction() rejects async callbacks, so we use
    // manual BEGIN/COMMIT. Since SqliteAdapter methods resolve synchronously,
    // the await inside fn completes within the same tick.
    this.rawDb.exec('BEGIN');
    try {
      const result = await fn(this);
      this.rawDb.exec('COMMIT');
      return result;
    } catch (err) {
      this.rawDb.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string): Promise<void> {
    this.rawDb.exec(sql);
  }

  async close(): Promise<void> {
    this.rawDb.close();
  }
}

// ---------------------------------------------------------------------------
// Postgres adapter (lazy-loaded to avoid requiring pg when using SQLite)
// ---------------------------------------------------------------------------

export class PgAdapter implements DbAdapter {
  readonly dialect = 'pg' as const;
  private pool: any; // pg.Pool — typed as any to avoid hard dep when unused

  constructor(pool: any) {
    this.pool = pool;
  }

  async get<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
    const adapted = adaptSql(sql, 'pg');
    const result = await this.pool.query(adapted, params);
    return result.rows[0] as T | undefined;
  }

  async all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
    const adapted = adaptSql(sql, 'pg');
    const result = await this.pool.query(adapted, params);
    return result.rows as T[];
  }

  async run(sql: string, ...params: any[]): Promise<RunResult> {
    const adapted = adaptSql(sql, 'pg');
    const result = await this.pool.query(adapted, params);
    // Postgres returns rowCount for changes. For INSERT RETURNING, the
    // lastInsertRowid comes from a RETURNING clause; for non-RETURNING
    // inserts we return 0 (callers that need the ID should use RETURNING).
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows?.[0]?.id ?? 0,
    };
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txAdapter = new PgClientAdapter(client);
      const result = await fn(txAdapter);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Transaction-scoped Postgres adapter that uses a single client connection.
 */
class PgClientAdapter implements DbAdapter {
  readonly dialect = 'pg' as const;
  private client: any;

  constructor(client: any) {
    this.client = client;
  }

  async get<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
    const adapted = adaptSql(sql, 'pg');
    const result = await this.client.query(adapted, params);
    return result.rows[0] as T | undefined;
  }

  async all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
    const adapted = adaptSql(sql, 'pg');
    const result = await this.client.query(adapted, params);
    return result.rows as T[];
  }

  async run(sql: string, ...params: any[]): Promise<RunResult> {
    const adapted = adaptSql(sql, 'pg');
    const result = await this.client.query(adapted, params);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows?.[0]?.id ?? 0,
    };
  }

  async transaction<T>(_fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    // Nested transactions use SAVEPOINTs
    const savepointName = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.client.query(`SAVEPOINT ${savepointName}`);
    try {
      const result = await _fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw err;
    }
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async close(): Promise<void> {
    // No-op: client is released by the parent transaction
  }
}

// ---------------------------------------------------------------------------
// SQL dialect helpers (exported for model use)
// ---------------------------------------------------------------------------

/**
 * Returns the dialect-appropriate FROM expression for iterating JSON arrays.
 *
 * SQLite:   json_each(col) AS alias          — yields alias.value
 * Postgres: jsonb_array_elements_text(col) AS alias(value)  — same semantics
 *
 * When no alias is given the expression omits the AS clause (useful when
 * the caller references the implicit `value` column directly).
 */
export function jsonArrayTable(dialect: 'sqlite' | 'pg', col: string, alias?: string): string {
  if (!alias) {
    return dialect === 'sqlite'
      ? `json_each(${col})`
      : `jsonb_array_elements_text(${col})`;
  }
  return dialect === 'sqlite'
    ? `json_each(${col}) AS ${alias}`
    : `jsonb_array_elements_text(${col}) AS ${alias}(value)`;
}

/**
 * Returns a current-timestamp expression for use in SQL.
 * Prefer passing `new Date().toISOString()` as a parameter instead.
 */
export function nowExpr(dialect: 'sqlite' | 'pg'): string {
  return dialect === 'sqlite'
    ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    : "to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
}
