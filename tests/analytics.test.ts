import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { getWorkspaceAnalytics, parseSinceDuration } from '../src/models/analytics.js';
import { createTask, updateTask } from '../src/models/task.js';

/**
 * Insert a task directly with a specific created_at / updated_at so we can
 * deterministically test completion-time aggregates.
 */
function insertTask(
  db: import('better-sqlite3').Database,
  workspaceId: string,
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
    INSERT INTO tasks (workspace_id, description, status, created_by, claimed_by, claimed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId,
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
  workspaceId: string,
  opts: { eventType: string; message: string; createdBy: string; createdAt: string; tags?: string[] },
): void {
  db.prepare(`
    INSERT INTO events (workspace_id, event_type, message, tags, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(workspaceId, opts.eventType, opts.message, JSON.stringify(opts.tags ?? []), opts.createdBy, opts.createdAt);
}

function insertContext(
  db: import('better-sqlite3').Database,
  workspaceId: string,
  opts: { key: string; value: string; createdBy: string; createdAt: string },
): void {
  db.prepare(`
    INSERT INTO context_entries (workspace_id, key, value, tags, created_by, created_at)
    VALUES (?, ?, ?, '[]', ?, ?)
  `).run(workspaceId, opts.key, opts.value, opts.createdBy, opts.createdAt);
}

function insertMessage(
  db: import('better-sqlite3').Database,
  workspaceId: string,
  opts: { from: string; to: string; message: string; createdAt: string },
): void {
  db.prepare(`
    INSERT INTO messages (workspace_id, from_agent, to_agent, message, tags, created_at)
    VALUES (?, ?, ?, ?, '[]', ?)
  `).run(workspaceId, opts.from, opts.to, opts.message, opts.createdAt);
}

function insertAgent(
  db: import('better-sqlite3').Database,
  workspaceId: string,
  opts: { id: string; status: 'online' | 'offline' | 'busy' },
): void {
  db.prepare(`
    INSERT INTO agents (id, workspace_id, capabilities, status, metadata)
    VALUES (?, ?, '[]', ?, '{}')
  `).run(opts.id, workspaceId, opts.status);
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

describe('getWorkspaceAnalytics', () => {
  let ctx: TestContext;
  const nowIso = () => new Date().toISOString();
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('returns zero-valued analytics for an empty team', async () => {
    const since = ago(24 * 60 * 60 * 1000);
    const result = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, since);

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

  it('aggregates all sections with seeded data', async () => {
    const team = ctx.workspaceId;
    const rawDb = ctx.rawDb;

    // Agents
    insertAgent(rawDb, team, { id: 'alice', status: 'online' });
    insertAgent(rawDb, team, { id: 'bob', status: 'online' });
    insertAgent(rawDb, team, { id: 'carol', status: 'offline' });

    // Tasks — seed with deterministic durations (in ms)
    const now = nowIso();
    const tenMin = 10 * 60 * 1000;
    const twentyMin = 20 * 60 * 1000;
    const thirtyMin = 30 * 60 * 1000;

    insertTask(rawDb, team, { status: 'completed', createdBy: 'alice', claimedBy: 'alice', createdAt: ago(tenMin + 60000), updatedAt: ago(60000) });
    insertTask(rawDb, team, { status: 'completed', createdBy: 'alice', claimedBy: 'alice', createdAt: ago(twentyMin + 60000), updatedAt: ago(60000) });
    insertTask(rawDb, team, { status: 'completed', createdBy: 'bob', claimedBy: 'bob', createdAt: ago(thirtyMin + 60000), updatedAt: ago(60000) });
    insertTask(rawDb, team, { status: 'abandoned', createdBy: 'alice', createdAt: ago(60000), updatedAt: now });
    insertTask(rawDb, team, { status: 'open', createdBy: 'alice', createdAt: ago(60000), updatedAt: now });
    insertTask(rawDb, team, { status: 'claimed', createdBy: 'bob', claimedBy: 'bob', createdAt: ago(60000), updatedAt: now });
    insertTask(rawDb, team, { status: 'escalated', createdBy: 'bob', claimedBy: 'bob', createdAt: ago(60000), updatedAt: now });

    // Events
    insertEvent(rawDb, team, { eventType: 'LEARNING', message: 'a', createdBy: 'alice', createdAt: ago(60000) });
    insertEvent(rawDb, team, { eventType: 'LEARNING', message: 'b', createdBy: 'alice', createdAt: ago(60000) });
    insertEvent(rawDb, team, { eventType: 'BROADCAST', message: 'c', createdBy: 'alice', createdAt: ago(60000) });
    insertEvent(rawDb, team, { eventType: 'BROADCAST', message: 'd', createdBy: 'bob', createdAt: ago(60000) });
    insertEvent(rawDb, team, { eventType: 'ERROR', message: 'e', createdBy: 'bob', createdAt: ago(60000) });
    insertEvent(rawDb, team, { eventType: 'ESCALATION', message: 'f', createdBy: 'bob', createdAt: ago(60000) });
    insertEvent(rawDb, team, { eventType: 'TASK_UPDATE', message: 'g', createdBy: 'carol', createdAt: ago(60000) });

    // Context
    insertContext(rawDb, team, { key: 'k1', value: 'v1', createdBy: 'alice', createdAt: ago(60000) });
    insertContext(rawDb, team, { key: 'k2', value: 'v2', createdBy: 'alice', createdAt: ago(60000) });
    insertContext(rawDb, team, { key: 'k3', value: 'v3', createdBy: 'bob', createdAt: ago(60000) });
    insertContext(rawDb, team, { key: 'k-old', value: 'vx', createdBy: 'carol', createdAt: ago(40 * 24 * 60 * 60 * 1000) });

    // Messages
    insertMessage(rawDb, team, { from: 'alice', to: 'bob', message: 'hi', createdAt: ago(60000) });
    insertMessage(rawDb, team, { from: 'bob', to: 'alice', message: 'hi back', createdAt: ago(60000) });
    insertMessage(rawDb, team, { from: 'carol', to: 'alice', message: 'old', createdAt: ago(40 * 24 * 60 * 60 * 1000) });

    const since = ago(24 * 60 * 60 * 1000);
    const result = await getWorkspaceAnalytics(ctx.db, team, since);

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

  it('since filter narrows results', async () => {
    const team = ctx.workspaceId;
    const rawDb = ctx.rawDb;

    // Events: 2 recent, 3 old
    insertEvent(rawDb, team, { eventType: 'LEARNING', message: 'recent1', createdBy: 'a', createdAt: ago(60 * 60 * 1000) });
    insertEvent(rawDb, team, { eventType: 'LEARNING', message: 'recent2', createdBy: 'a', createdAt: ago(2 * 60 * 60 * 1000) });
    insertEvent(rawDb, team, { eventType: 'LEARNING', message: 'old1', createdBy: 'b', createdAt: ago(10 * 24 * 60 * 60 * 1000) });
    insertEvent(rawDb, team, { eventType: 'LEARNING', message: 'old2', createdBy: 'b', createdAt: ago(20 * 24 * 60 * 60 * 1000) });
    insertEvent(rawDb, team, { eventType: 'LEARNING', message: 'old3', createdBy: 'b', createdAt: ago(40 * 24 * 60 * 60 * 1000) });

    const narrow = await getWorkspaceAnalytics(ctx.db, team, ago(24 * 60 * 60 * 1000));
    expect(narrow.events.total).toBe(2);

    const wide = await getWorkspaceAnalytics(ctx.db, team, ago(30 * 24 * 60 * 60 * 1000));
    expect(wide.events.total).toBe(4);

    const widest = await getWorkspaceAnalytics(ctx.db, team, ago(60 * 24 * 60 * 60 * 1000));
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

// ─── Analytics multi-dimension cross-filtering (from round3-coverage-p1) ─

describe('Analytics — multi-dimension cross-filtering', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestContext();
  });

  it('should return tasks filtered by both status and time range', async () => {
    const t1 = await createTask(ctx.db, ctx.workspaceId, 'agent-a', {
      description: 'Open task', status: 'open',
    });
    const t2 = await createTask(ctx.db, ctx.workspaceId, 'agent-a', {
      description: 'Claimed task', status: 'claimed',
    });
    const t3 = await createTask(ctx.db, ctx.workspaceId, 'agent-b', {
      description: 'Done task', status: 'claimed',
    });
    await updateTask(ctx.db, ctx.workspaceId, 'agent-b', {
      task_id: t3.task_id, status: 'completed', version: 1, result: 'done',
    });

    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const analytics = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);

    expect(analytics.tasks.by_status.open).toBe(1);
    expect(analytics.tasks.by_status.claimed).toBe(1);
    expect(analytics.tasks.by_status.completed).toBe(1);
    expect(analytics.tasks.total).toBe(3);
    expect(analytics.tasks.completion_rate).toBeGreaterThan(0);
  });

  it('should cross-filter agents by events and completed tasks', async () => {
    ctx.rawDb.prepare(
      `INSERT INTO agents (id, workspace_id, capabilities, status, metadata, last_heartbeat) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run('agent-a', ctx.workspaceId, '[]', 'online', '{}');
    ctx.rawDb.prepare(
      `INSERT INTO agents (id, workspace_id, capabilities, status, metadata, last_heartbeat) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run('agent-b', ctx.workspaceId, '[]', 'online', '{}');

    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'LEARNING', 'Found something', '[]', 'agent-a');
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'BROADCAST', 'Update', '[]', 'agent-b');
    ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'ERROR', 'Oops', '[]', 'agent-a');

    const t = await createTask(ctx.db, ctx.workspaceId, 'agent-b', {
      description: 'Task by B', status: 'claimed',
    });
    await updateTask(ctx.db, ctx.workspaceId, 'agent-b', {
      task_id: t.task_id, status: 'completed', version: 1, result: 'done',
    });

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const analytics = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);

    expect(analytics.agents.total).toBe(2);
    expect(analytics.agents.online).toBe(2);
    expect(analytics.agents.top_producers.length).toBeGreaterThan(0);

    const agentA = analytics.agents.top_producers.find((p) => p.agent_id === 'agent-a');
    const agentB = analytics.agents.top_producers.find((p) => p.agent_id === 'agent-b');
    expect(agentA?.events).toBe(2);
    expect(agentB?.tasks_completed).toBe(1);
  });

  it('should aggregate event types correctly', async () => {
    for (const type of ['LEARNING', 'LEARNING', 'BROADCAST', 'ERROR', 'ESCALATION', 'TASK_UPDATE']) {
      ctx.rawDb.prepare(
        `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
      ).run(ctx.workspaceId, type, `msg-${type}`, '[]', 'agent');
    }

    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const analytics = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);

    expect(analytics.events.by_type.LEARNING).toBe(2);
    expect(analytics.events.by_type.BROADCAST).toBe(1);
    expect(analytics.events.by_type.ERROR).toBe(1);
    expect(analytics.events.by_type.ESCALATION).toBe(1);
    expect(analytics.events.by_type.TASK_UPDATE).toBe(1);
    expect(analytics.events.total).toBe(6);
  });

  it('should compute context stats with cross-filtering', async () => {
    ctx.rawDb.prepare(
      `INSERT INTO context_entries (workspace_id, key, value, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'k1', 'v1', '["a"]', 'agent-a');
    ctx.rawDb.prepare(
      `INSERT INTO context_entries (workspace_id, key, value, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'k2', 'v2', '["b"]', 'agent-a');
    ctx.rawDb.prepare(
      `INSERT INTO context_entries (workspace_id, key, value, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, 'k3', 'v3', '["c"]', 'agent-b');

    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const analytics = await getWorkspaceAnalytics(ctx.db, ctx.workspaceId, sinceIso);

    expect(analytics.context.total_entries).toBe(3);
    expect(analytics.context.entries_since).toBe(3);
    expect(analytics.context.top_authors.length).toBe(2);
    expect(analytics.context.top_authors[0].agent_id).toBe('agent-a');
    expect(analytics.context.top_authors[0].count).toBe(2);
  });
});
