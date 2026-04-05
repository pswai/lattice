import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { getTeamAnalytics, parseSinceDuration } from '../src/models/analytics.js';

/**
 * Insert a task directly with a specific created_at / updated_at so we can
 * deterministically test completion-time aggregates.
 */
function insertTask(
  db: import('better-sqlite3').Database,
  teamId: string,
  opts: {
    description?: string;
    status: 'open' | 'claimed' | 'completed' | 'escalated' | 'abandoned';
    createdBy: string;
    claimedBy?: string | null;
    createdAt: string;
    updatedAt: string;
  },
): number {
  const result = db.prepare(`
    INSERT INTO tasks (team_id, description, status, created_by, claimed_by, claimed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    teamId,
    opts.description ?? 'test task',
    opts.status,
    opts.createdBy,
    opts.claimedBy ?? null,
    opts.claimedBy ? opts.createdAt : null,
    opts.createdAt,
    opts.updatedAt,
  );
  return Number(result.lastInsertRowid);
}

function insertEvent(
  db: import('better-sqlite3').Database,
  teamId: string,
  opts: { eventType: string; message: string; createdBy: string; createdAt: string; tags?: string[] },
): void {
  db.prepare(`
    INSERT INTO events (team_id, event_type, message, tags, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(teamId, opts.eventType, opts.message, JSON.stringify(opts.tags ?? []), opts.createdBy, opts.createdAt);
}

function insertContext(
  db: import('better-sqlite3').Database,
  teamId: string,
  opts: { key: string; value: string; createdBy: string; createdAt: string },
): void {
  db.prepare(`
    INSERT INTO context_entries (team_id, key, value, tags, created_by, created_at)
    VALUES (?, ?, ?, '[]', ?, ?)
  `).run(teamId, opts.key, opts.value, opts.createdBy, opts.createdAt);
}

function insertMessage(
  db: import('better-sqlite3').Database,
  teamId: string,
  opts: { from: string; to: string; message: string; createdAt: string },
): void {
  db.prepare(`
    INSERT INTO messages (team_id, from_agent, to_agent, message, tags, created_at)
    VALUES (?, ?, ?, ?, '[]', ?)
  `).run(teamId, opts.from, opts.to, opts.message, opts.createdAt);
}

function insertAgent(
  db: import('better-sqlite3').Database,
  teamId: string,
  opts: { id: string; status: 'online' | 'offline' | 'busy' },
): void {
  db.prepare(`
    INSERT INTO agents (id, team_id, capabilities, status, metadata)
    VALUES (?, ?, '[]', ?, '{}')
  `).run(opts.id, teamId, opts.status);
}

describe('parseSinceDuration', () => {
  it('defaults to 24h', () => {
    const now = Date.now();
    const iso = parseSinceDuration(undefined);
    const then = new Date(iso).getTime();
    const diffHours = (now - then) / (60 * 60 * 1000);
    expect(diffHours).toBeGreaterThan(23.9);
    expect(diffHours).toBeLessThan(24.1);
  });

  it('parses "7d"', () => {
    const now = Date.now();
    const iso = parseSinceDuration('7d');
    const then = new Date(iso).getTime();
    const diffDays = (now - then) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(6.99);
    expect(diffDays).toBeLessThan(7.01);
  });

  it('parses "30d"', () => {
    const now = Date.now();
    const iso = parseSinceDuration('30d');
    const then = new Date(iso).getTime();
    const diffDays = (now - then) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(29.99);
    expect(diffDays).toBeLessThan(30.01);
  });

  it('rejects invalid formats', () => {
    expect(() => parseSinceDuration('bogus')).toThrow();
    expect(() => parseSinceDuration('7')).toThrow();
    expect(() => parseSinceDuration('7y')).toThrow();
  });
});

describe('getTeamAnalytics', () => {
  let ctx: TestContext;
  const nowIso = () => new Date().toISOString();
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('returns zero-valued analytics for an empty team', () => {
    const since = ago(24 * 60 * 60 * 1000);
    const result = getTeamAnalytics(ctx.db, ctx.teamId, since);

    expect(result.tasks.total).toBe(0);
    expect(result.tasks.by_status).toEqual({ open: 0, claimed: 0, completed: 0, escalated: 0, abandoned: 0 });
    expect(result.tasks.completion_rate).toBe(0);
    expect(result.tasks.avg_completion_ms).toBeNull();
    expect(result.tasks.median_completion_ms).toBeNull();
    expect(result.events.total).toBe(0);
    expect(result.events.per_hour_last_24h).toHaveLength(24);
    expect(result.events.per_hour_last_24h.every(x => x === 0)).toBe(true);
    expect(result.agents.total).toBe(0);
    expect(result.agents.online).toBe(0);
    expect(result.agents.top_producers).toEqual([]);
    expect(result.context.total_entries).toBe(0);
    expect(result.context.entries_since).toBe(0);
    expect(result.messages.total).toBe(0);
    expect(result.messages.since).toBe(0);
  });

  it('aggregates all sections with seeded data', () => {
    const team = ctx.teamId;
    const db = ctx.db;

    // Agents
    insertAgent(db, team, { id: 'alice', status: 'online' });
    insertAgent(db, team, { id: 'bob', status: 'online' });
    insertAgent(db, team, { id: 'carol', status: 'offline' });

    // Tasks — seed with deterministic durations (in ms)
    const now = nowIso();
    const tenMin = 10 * 60 * 1000;
    const twentyMin = 20 * 60 * 1000;
    const thirtyMin = 30 * 60 * 1000;

    insertTask(db, team, { status: 'completed', createdBy: 'alice', claimedBy: 'alice', createdAt: ago(tenMin + 60000), updatedAt: ago(60000) });
    insertTask(db, team, { status: 'completed', createdBy: 'alice', claimedBy: 'alice', createdAt: ago(twentyMin + 60000), updatedAt: ago(60000) });
    insertTask(db, team, { status: 'completed', createdBy: 'bob', claimedBy: 'bob', createdAt: ago(thirtyMin + 60000), updatedAt: ago(60000) });
    insertTask(db, team, { status: 'abandoned', createdBy: 'alice', createdAt: ago(60000), updatedAt: now });
    insertTask(db, team, { status: 'open', createdBy: 'alice', createdAt: ago(60000), updatedAt: now });
    insertTask(db, team, { status: 'claimed', createdBy: 'bob', claimedBy: 'bob', createdAt: ago(60000), updatedAt: now });
    insertTask(db, team, { status: 'escalated', createdBy: 'bob', claimedBy: 'bob', createdAt: ago(60000), updatedAt: now });

    // Events
    insertEvent(db, team, { eventType: 'LEARNING', message: 'a', createdBy: 'alice', createdAt: ago(60000) });
    insertEvent(db, team, { eventType: 'LEARNING', message: 'b', createdBy: 'alice', createdAt: ago(60000) });
    insertEvent(db, team, { eventType: 'BROADCAST', message: 'c', createdBy: 'alice', createdAt: ago(60000) });
    insertEvent(db, team, { eventType: 'BROADCAST', message: 'd', createdBy: 'bob', createdAt: ago(60000) });
    insertEvent(db, team, { eventType: 'ERROR', message: 'e', createdBy: 'bob', createdAt: ago(60000) });
    insertEvent(db, team, { eventType: 'ESCALATION', message: 'f', createdBy: 'bob', createdAt: ago(60000) });
    insertEvent(db, team, { eventType: 'TASK_UPDATE', message: 'g', createdBy: 'carol', createdAt: ago(60000) });

    // Context
    insertContext(db, team, { key: 'k1', value: 'v1', createdBy: 'alice', createdAt: ago(60000) });
    insertContext(db, team, { key: 'k2', value: 'v2', createdBy: 'alice', createdAt: ago(60000) });
    insertContext(db, team, { key: 'k3', value: 'v3', createdBy: 'bob', createdAt: ago(60000) });
    insertContext(db, team, { key: 'k-old', value: 'vx', createdBy: 'carol', createdAt: ago(40 * 24 * 60 * 60 * 1000) });

    // Messages
    insertMessage(db, team, { from: 'alice', to: 'bob', message: 'hi', createdAt: ago(60000) });
    insertMessage(db, team, { from: 'bob', to: 'alice', message: 'hi back', createdAt: ago(60000) });
    insertMessage(db, team, { from: 'carol', to: 'alice', message: 'old', createdAt: ago(40 * 24 * 60 * 60 * 1000) });

    const since = ago(24 * 60 * 60 * 1000);
    const result = getTeamAnalytics(db, team, since);

    // Tasks
    expect(result.tasks.total).toBe(7);
    expect(result.tasks.by_status).toEqual({ open: 1, claimed: 1, completed: 3, escalated: 1, abandoned: 1 });
    // completion_rate = 3 / (3 + 1) = 0.75
    expect(result.tasks.completion_rate).toBeCloseTo(0.75, 5);
    // Durations: ~10min, ~20min, ~30min → avg ~20min, median ~20min
    expect(result.tasks.avg_completion_ms).not.toBeNull();
    expect(result.tasks.avg_completion_ms!).toBeGreaterThan(19 * 60 * 1000);
    expect(result.tasks.avg_completion_ms!).toBeLessThan(21 * 60 * 1000);
    expect(result.tasks.median_completion_ms).not.toBeNull();
    expect(result.tasks.median_completion_ms!).toBeGreaterThan(19 * 60 * 1000);
    expect(result.tasks.median_completion_ms!).toBeLessThan(21 * 60 * 1000);

    // Events
    expect(result.events.total).toBe(7);
    expect(result.events.by_type).toEqual({ LEARNING: 2, BROADCAST: 2, ESCALATION: 1, ERROR: 1, TASK_UPDATE: 1 });
    expect(result.events.per_hour_last_24h).toHaveLength(24);
    // All events in bucket 0 (within last hour)
    expect(result.events.per_hour_last_24h[0]).toBe(7);

    // Agents
    expect(result.agents.total).toBe(3);
    expect(result.agents.online).toBe(2);
    // top_producers sorted by events desc — alice: 3 events/2 completed, bob: 3 events/1 completed, carol: 1 event/0
    expect(result.agents.top_producers.length).toBeGreaterThanOrEqual(2);
    expect(result.agents.top_producers[0].agent_id).toBe('alice');
    expect(result.agents.top_producers[0].events).toBe(3);
    expect(result.agents.top_producers[0].tasks_completed).toBe(2);
    expect(result.agents.top_producers[1].agent_id).toBe('bob');
    expect(result.agents.top_producers[1].events).toBe(3);
    expect(result.agents.top_producers[1].tasks_completed).toBe(1);

    // Context
    expect(result.context.total_entries).toBe(4);
    expect(result.context.entries_since).toBe(3);
    expect(result.context.top_authors[0]).toEqual({ agent_id: 'alice', count: 2 });
    expect(result.context.top_authors[1]).toEqual({ agent_id: 'bob', count: 1 });

    // Messages
    expect(result.messages.total).toBe(3);
    expect(result.messages.since).toBe(2);
  });

  it('since filter narrows results', () => {
    const team = ctx.teamId;
    const db = ctx.db;

    // Events: 2 recent, 3 old
    insertEvent(db, team, { eventType: 'LEARNING', message: 'recent1', createdBy: 'a', createdAt: ago(60 * 60 * 1000) });
    insertEvent(db, team, { eventType: 'LEARNING', message: 'recent2', createdBy: 'a', createdAt: ago(2 * 60 * 60 * 1000) });
    insertEvent(db, team, { eventType: 'LEARNING', message: 'old1', createdBy: 'b', createdAt: ago(10 * 24 * 60 * 60 * 1000) });
    insertEvent(db, team, { eventType: 'LEARNING', message: 'old2', createdBy: 'b', createdAt: ago(20 * 24 * 60 * 60 * 1000) });
    insertEvent(db, team, { eventType: 'LEARNING', message: 'old3', createdBy: 'b', createdAt: ago(40 * 24 * 60 * 60 * 1000) });

    const narrow = getTeamAnalytics(db, team, ago(24 * 60 * 60 * 1000));
    expect(narrow.events.total).toBe(2);

    const wide = getTeamAnalytics(db, team, ago(30 * 24 * 60 * 60 * 1000));
    expect(wide.events.total).toBe(4);

    const widest = getTeamAnalytics(db, team, ago(60 * 24 * 60 * 60 * 1000));
    expect(widest.events.total).toBe(5);
  });
});

describe('GET /api/v1/analytics', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('returns analytics with default since=24h', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/analytics', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('tasks');
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('agents');
    expect(data).toHaveProperty('context');
    expect(data).toHaveProperty('messages');
    expect(data.events.per_hour_last_24h).toHaveLength(24);
  });

  it('respects since parameter', async () => {
    // Seed an event
    await request(ctx.app, 'POST', '/api/v1/events', {
      headers: authHeaders(ctx.apiKey, 'agent-a'),
      body: { event_type: 'LEARNING', message: 'hi', tags: [] },
    });
    const res = await request(ctx.app, 'GET', '/api/v1/analytics?since=7d', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.events.total).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid since parameter', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/analytics?since=bogus', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/analytics', {});
    expect(res.status).toBe(401);
  });
});
