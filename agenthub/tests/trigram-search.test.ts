import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

/**
 * Trigram FTS5 tokenizer verification.
 *
 * The default unicode61 tokenizer only indexes whole words, so short queries
 * like "cli" or mid-word fragments return nothing. Switching to the trigram
 * tokenizer makes partial/substring matches work natively.
 */
describe('Trigram FTS search', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestContext();
    const headers = authHeaders(ctx.apiKey);
    const entries = [
      { key: 'cli-usage',        value: 'Run the cli tool to bootstrap a team',          tags: ['cli', 'tooling'] },
      { key: 'lattice-overview', value: 'Lattice coordinates AI agents over MCP',      tags: ['overview'] },
      { key: 'about-page',       value: 'The about section describes the product',       tags: ['docs'] },
      { key: 'abandoned-task',   value: 'abstract abandoned workflow run',               tags: ['tasks'] },
      { key: 'migration-notes',  value: 'Database migrations happen on connect',         tags: ['db'] },
      { key: 'webhook-hmac',     value: 'Webhooks sign with HMAC-SHA256 secret',         tags: ['webhooks'] },
    ];
    for (const body of entries) {
      await request(ctx.app, 'POST', '/api/v1/context', { headers, body });
    }
  });

  it('matches a 3-char substring ("cli") that whole-word tokenizers miss', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=cli', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Matches both the "cli-usage" key and "cli" token in value
    expect(data.entries.length).toBeGreaterThan(0);
    const keys = data.entries.map((e: { key: string }) => e.key);
    expect(keys).toContain('cli-usage');
  });

  it('matches a 2-char query ("ab") via LIKE fallback', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=ab', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // "about-page" and "abandoned-task" both contain "ab"
    const keys = data.entries.map((e: { key: string }) => e.key);
    expect(keys).toContain('about-page');
    expect(keys).toContain('abandoned-task');
  });

  it('matches a middle-of-word fragment ("gent" inside "Lattice")', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=gent', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const keys = data.entries.map((e: { key: string }) => e.key);
    expect(keys).toContain('lattice-overview');
  });

  it('matches a fragment spanning word interior ("hook" inside "Webhooks")', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=hook', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const keys = data.entries.map((e: { key: string }) => e.key);
    expect(keys).toContain('webhook-hmac');
  });

  it('returns 0 for a clearly non-existent substring', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=xyzqqqq', {
      headers: authHeaders(ctx.apiKey),
    });
    const data = await res.json();
    expect(data.entries).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it('combines trigram search with tag filter', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=cli&tags=cli', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries.length).toBe(1);
    expect(data.entries[0].key).toBe('cli-usage');
  });

  it('combines short (LIKE-fallback) query with tag filter', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=ab&tags=docs', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const keys = data.entries.map((e: { key: string }) => e.key);
    expect(keys).toContain('about-page');
    expect(keys).not.toContain('abandoned-task'); // tag=tasks, not docs
  });

  it('quoted FTS operator characters do not break search', async () => {
    // "-" in "HMAC-SHA256" is an FTS5 operator; must be escaped safely
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=HMAC-SHA256', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const keys = data.entries.map((e: { key: string }) => e.key);
    expect(keys).toContain('webhook-hmac');
  });
});

/**
 * Migration path: a database created with the old unicode61 tokenizer should
 * be transparently upgraded to trigram on next initDatabase() call.
 */
describe('Trigram FTS migration', () => {
  it('upgrades a legacy unicode61 FTS table to trigram, preserving entries', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { initDatabase } = await import('../src/db/connection.js');
    const { createHash } = await import('crypto');
    const path = await import('path');
    const os = await import('os');
    const fs = await import('fs');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigram-mig-'));
    const dbPath = path.join(tmpDir, 'legacy.db');

    // Build a legacy DB with the default (unicode61) tokenizer manually.
    {
      const legacy = new Database(dbPath);
      legacy.pragma('journal_mode = WAL');
      legacy.exec(`
        CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
        CREATE TABLE context_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE(team_id, key)
        );
        CREATE VIRTUAL TABLE context_entries_fts USING fts5(
          key, value, tags, content='context_entries', content_rowid='id'
        );
      `);
      legacy.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t1', 'Team 1');
      legacy.prepare(`INSERT INTO context_entries (team_id, key, value, tags, created_by) VALUES (?, ?, ?, ?, ?)`)
        .run('t1', 'cli-doc', 'the cli subcommand', '[]', 'seed');
      // Populate FTS from content table
      legacy.exec(`INSERT INTO context_entries_fts(context_entries_fts) VALUES('rebuild')`);
      // Sanity: legacy tokenizer should NOT find "cli" as a prefix-free 3-char query
      const pre = legacy.prepare(`SELECT COUNT(*) as cnt FROM context_entries_fts WHERE context_entries_fts MATCH ?`).get(`"cli"`) as { cnt: number };
      // "cli" is a whole word in the value so legacy does find it; use a fragment instead.
      const mid = legacy.prepare(`SELECT COUNT(*) as cnt FROM context_entries_fts WHERE context_entries_fts MATCH ?`).get(`"ubc"`) as { cnt: number };
      expect(pre.cnt).toBeGreaterThanOrEqual(0);
      expect(mid.cnt).toBe(0); // legacy can't match interior fragments
      legacy.close();
    }

    // Reopen via initDatabase — should migrate to trigram.
    const db = initDatabase(dbPath);
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='context_entries_fts'").get() as { sql: string };
    expect(schema.sql).toMatch(/tokenize\s*=\s*['"]?trigram/i);

    // After migration, interior fragment should match.
    const hit = db.prepare(`SELECT COUNT(*) as cnt FROM context_entries_fts WHERE context_entries_fts MATCH ?`).get(`"ubc"`) as { cnt: number };
    expect(hit.cnt).toBe(1);

    // Original row still present (rebuild preserved data).
    const orig = db.prepare(`SELECT key FROM context_entries`).all() as Array<{ key: string }>;
    expect(orig.map(r => r.key)).toContain('cli-doc');

    db.close();
    // tidy up
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    // silence unused-import lint
    void createHash;
  });

  it('is idempotent — calling initDatabase twice leaves trigram table intact', async () => {
    const { initDatabase } = await import('../src/db/connection.js');
    const path = await import('path');
    const os = await import('os');
    const fs = await import('fs');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigram-idem-'));
    const dbPath = path.join(tmpDir, 'fresh.db');

    const db1 = initDatabase(dbPath);
    db1.close();
    const db2 = initDatabase(dbPath);
    const schema = db2.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='context_entries_fts'").get() as { sql: string };
    expect(schema.sql).toMatch(/tokenize\s*=\s*['"]?trigram/i);
    db2.close();

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
});
