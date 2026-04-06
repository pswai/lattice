import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { createOpsRoutes, refreshGaugesFromDb } from '../src/http/routes/ops.js';
import { metricsRegistry } from '../src/metrics.js';
import { SqliteAdapter } from '../src/db/adapter.js';
import { DEFAULT_PLANS } from '../src/models/plan.js';

function createDb(): SqliteAdapter {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  // Seed default plans
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO subscription_plans
      (id, name, price_cents, exec_quota, api_call_quota, storage_bytes_quota, seat_quota, retention_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of DEFAULT_PLANS) {
    stmt.run(p.id, p.name, p.priceCents, p.execQuota, p.apiCallQuota, p.storageBytesQuota, p.seatQuota, p.retentionDays);
  }
  return new SqliteAdapter(db);
}

function mountOps(db: SqliteAdapter, metricsEnabled = true): Hono {
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
    db.rawDb.close();
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
    expect(text).toContain('# HELP lattice_http_requests_total');
    expect(text).toContain('# TYPE lattice_http_requests_total counter');
    expect(text).toContain('lattice_http_request_duration_ms');
    expect(text).toContain('lattice_active_agents');
    expect(text).toContain('lattice_tasks');
    expect(text).toContain('lattice_events_total');
    expect(text).toContain('lattice_up');
    expect(text).toContain('lattice_up 1');
  });

  it('reflects agents-online gauge from DB', async () => {
    const db = createDb();
    db.rawDb.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t1', 'T1');
    db.rawDb.prepare(
      "INSERT INTO agents (id, team_id, status, capabilities) VALUES ('a1', 't1', 'online', '[]')",
    ).run();
    db.rawDb.prepare(
      "INSERT INTO agents (id, team_id, status, capabilities) VALUES ('a2', 't1', 'online', '[]')",
    ).run();
    db.rawDb.prepare(
      "INSERT INTO agents (id, team_id, status, capabilities) VALUES ('a3', 't1', 'offline', '[]')",
    ).run();
    await refreshGaugesFromDb(db, { force: true });
    const app = mountOps(db);
    // Force fresh read by calling refresh with force via re-route
    await refreshGaugesFromDb(db, { force: true });
    const res = await app.request('/metrics');
    const text = await res.text();
    expect(text).toContain('lattice_active_agents{team="t1"} 2');
  });

  it('reflects tasks-by-status gauge from DB', async () => {
    const db = createDb();
    db.rawDb.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t2', 'T2');
    db.rawDb.prepare(
      "INSERT INTO tasks (team_id, description, status, created_by) VALUES ('t2', 'a', 'open', 'x')",
    ).run();
    db.rawDb.prepare(
      "INSERT INTO tasks (team_id, description, status, created_by) VALUES ('t2', 'b', 'open', 'x')",
    ).run();
    db.rawDb.prepare(
      "INSERT INTO tasks (team_id, description, status, created_by) VALUES ('t2', 'c', 'completed', 'x')",
    ).run();
    const text = await refreshRender(db);
    expect(text).toContain('lattice_tasks{team="t2",status="open"} 2');
    expect(text).toContain('lattice_tasks{team="t2",status="completed"} 1');
  });

  it('returns disabled marker when metrics disabled', async () => {
    const db = createDb();
    const app = mountOps(db, false);
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('metrics disabled');
    expect(text).not.toContain('# TYPE lattice_');
  });
});

// Render the registry inline for tests without worrying about rate-limit.
async function refreshRender(db: SqliteAdapter): Promise<string> {
  await refreshGaugesFromDb(db, { force: true });
  return metricsRegistry.render();
}
