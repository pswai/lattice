import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { createOpsRoutes, refreshGaugesFromDb } from '../src/http/routes/ops.js';
import { metricsRegistry } from '../src/metrics.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

function mountOps(db: Database.Database, metricsEnabled = true): Hono {
  const app = new Hono();
  app.route('/', createOpsRoutes(db, { metricsEnabled }));
  return app;
}

describe('GET /healthz', () => {
  it('returns 200 ok', async () => {
    const db = createDb();
    const app = mountOps(db);
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('returns 200 ready when DB is working', async () => {
    const db = createDb();
    const app = mountOps(db);
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ready' });
  });

  it('returns 503 unready when DB is closed', async () => {
    const db = createDb();
    const app = mountOps(db);
    db.close();
    const res = await app.request('/readyz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe('unready');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });
});

describe('GET /metrics', () => {
  beforeEach(() => {
    // Force refresh on every call
  });

  it('returns prometheus text with correct content type', async () => {
    const db = createDb();
    const app = mountOps(db);
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    const text = await res.text();
    expect(text).toContain('# HELP agenthub_http_requests_total');
    expect(text).toContain('# TYPE agenthub_http_requests_total counter');
    expect(text).toContain('agenthub_http_request_duration_ms');
    expect(text).toContain('agenthub_active_agents');
    expect(text).toContain('agenthub_tasks');
    expect(text).toContain('agenthub_events_total');
    expect(text).toContain('agenthub_up');
    expect(text).toContain('agenthub_up 1');
  });

  it('reflects agents-online gauge from DB', async () => {
    const db = createDb();
    db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t1', 'T1');
    db.prepare(
      "INSERT INTO agents (id, team_id, status, capabilities) VALUES ('a1', 't1', 'online', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO agents (id, team_id, status, capabilities) VALUES ('a2', 't1', 'online', '[]')",
    ).run();
    db.prepare(
      "INSERT INTO agents (id, team_id, status, capabilities) VALUES ('a3', 't1', 'offline', '[]')",
    ).run();
    refreshGaugesFromDb(db, { force: true });
    const app = mountOps(db);
    // Force fresh read by calling refresh with force via re-route
    refreshGaugesFromDb(db, { force: true });
    const res = await app.request('/metrics');
    const text = await res.text();
    expect(text).toContain('agenthub_active_agents{team="t1"} 2');
  });

  it('reflects tasks-by-status gauge from DB', async () => {
    const db = createDb();
    db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t2', 'T2');
    db.prepare(
      "INSERT INTO tasks (team_id, description, status, created_by) VALUES ('t2', 'a', 'open', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO tasks (team_id, description, status, created_by) VALUES ('t2', 'b', 'open', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO tasks (team_id, description, status, created_by) VALUES ('t2', 'c', 'completed', 'x')",
    ).run();
    refreshGaugesFromDb(db, { force: true });
    const text = refreshRender(db);
    expect(text).toContain('agenthub_tasks{team="t2",status="open"} 2');
    expect(text).toContain('agenthub_tasks{team="t2",status="completed"} 1');
  });

  it('returns disabled marker when metrics disabled', async () => {
    const db = createDb();
    const app = mountOps(db, false);
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('metrics disabled');
    expect(text).not.toContain('# TYPE agenthub_');
  });
});

// Render the registry inline for tests without worrying about rate-limit.
function refreshRender(db: Database.Database): string {
  refreshGaugesFromDb(db, { force: true });
  return metricsRegistry.render();
}
