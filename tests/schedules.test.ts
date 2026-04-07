import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, createTestDb, setupWorkspace, type TestContext } from './helpers.js';
import {
  computeNextRun,
  defineSchedule,
  listSchedules,
  deleteSchedule,
  getDueSchedules,
} from '../src/models/schedule.js';
import { definePlaybook } from '../src/models/playbook.js';
import { runDueSchedules } from '../src/services/scheduler.js';

describe('computeNextRun — cron parser', () => {
  it('parses "*/5 * * * *" — every 5 minutes', () => {
    const from = new Date('2026-04-05T12:00:00.000Z');
    const next = computeNextRun('*/5 * * * *', from);
    expect(next.toISOString()).toBe('2026-04-05T12:05:00.000Z');
  });

  it('parses "*/15 * * * *" — rounds to next 15-min mark', () => {
    const from = new Date('2026-04-05T12:07:30.000Z');
    const next = computeNextRun('*/15 * * * *', from);
    expect(next.toISOString()).toBe('2026-04-05T12:15:00.000Z');
  });

  it('parses "*/30 * * * *" — :00 or :30', () => {
    const from = new Date('2026-04-05T12:31:00.000Z');
    const next = computeNextRun('*/30 * * * *', from);
    expect(next.toISOString()).toBe('2026-04-05T13:00:00.000Z');
  });

  it('parses "0 */2 * * *" — every 2 hours at minute 0', () => {
    const from = new Date('2026-04-05T12:30:00.000Z');
    const next = computeNextRun('0 */2 * * *', from);
    expect(next.toISOString()).toBe('2026-04-05T14:00:00.000Z');
  });

  it('parses "0 9 * * *" — daily at 09:00 UTC', () => {
    const from = new Date('2026-04-05T12:30:00.000Z');
    const next = computeNextRun('0 9 * * *', from);
    expect(next.toISOString()).toBe('2026-04-06T09:00:00.000Z');
  });

  it('parses "0 9 * * 1" — weekly on Monday at 09:00 UTC', () => {
    // 2026-04-05 is a Sunday
    const from = new Date('2026-04-05T12:30:00.000Z');
    const next = computeNextRun('0 9 * * 1', from);
    expect(next.toISOString()).toBe('2026-04-06T09:00:00.000Z'); // Mon
    expect(next.getUTCDay()).toBe(1);
  });

  it('computes strictly-after: at exact boundary, returns next interval', () => {
    const from = new Date('2026-04-05T12:05:00.000Z');
    const next = computeNextRun('*/5 * * * *', from);
    expect(next.toISOString()).toBe('2026-04-05T12:10:00.000Z');
  });

  it('throws ValidationError on unsupported patterns', () => {
    expect(() => computeNextRun('* * * * *', new Date())).toThrow(/Unsupported cron pattern/);
    expect(() => computeNextRun('0 0 1 * *', new Date())).toThrow(/Unsupported cron pattern/);
    expect(() => computeNextRun('0 0 * 1 *', new Date())).toThrow(/Unsupported cron pattern/);
    expect(() => computeNextRun('invalid', new Date())).toThrow(/Unsupported cron pattern/);
  });

  it('error message names the offending input AND the supported patterns', () => {
    const bad = '0 0 1 * *';
    let caught: unknown;
    try {
      computeNextRun(bad, new Date());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain(`'${bad}'`);
    expect(msg).toContain('*/N * * * *');
    expect(msg).toContain('0 */N * * *');
    expect(msg).toContain('0 N * * *');
    expect(msg).toContain('0 H * * D');
  });

  it('throws on out-of-range values', () => {
    expect(() => computeNextRun('*/0 * * * *', new Date())).toThrow(/Unsupported cron pattern/);
    expect(() => computeNextRun('*/60 * * * *', new Date())).toThrow(/Unsupported cron pattern/);
    expect(() => computeNextRun('0 */24 * * *', new Date())).toThrow(/Unsupported cron pattern/);
    expect(() => computeNextRun('0 24 * * *', new Date())).toThrow(/Unsupported cron pattern/);
    expect(() => computeNextRun('0 9 * * 7', new Date())).toThrow(/Unsupported cron pattern/);
  });
});

describe('Schedule model', () => {
  async function setup() {
    const db = createTestDb();
    setupWorkspace(db, 'team-a');
    await definePlaybook(db, 'team-a', 'alice', {
      name: 'cleanup',
      description: 'nightly cleanup',
      tasks: [{ description: 'do cleanup' }],
    });
    return db;
  }

  it('defineSchedule computes next_run_at ~N minutes from now', async () => {
    const db = await setup();
    const before = Date.now();
    const s = await defineSchedule(db, 'team-a', 'alice', {
      playbook_name: 'cleanup',
      cron_expression: '*/5 * * * *',
    });
    expect(s.enabled).toBe(true);
    expect(s.nextRunAt).not.toBeNull();
    const nextMs = new Date(s.nextRunAt!).getTime();
    // Within the next 6 minutes (cap = 5 min interval + rounding slack)
    expect(nextMs).toBeGreaterThanOrEqual(before);
    expect(nextMs - before).toBeLessThanOrEqual(6 * 60 * 1000);
  });

  it('defineSchedule rejects when playbook does not exist', async () => {
    const db = await setup();
    await expect(
      defineSchedule(db, 'team-a', 'alice', {
        playbook_name: 'does-not-exist',
        cron_expression: '*/5 * * * *',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('defineSchedule rejects invalid cron with ValidationError', async () => {
    const db = await setup();
    await expect(
      defineSchedule(db, 'team-a', 'alice', {
        playbook_name: 'cleanup',
        cron_expression: '* * * * *',
      }),
    ).rejects.toThrow(/Unsupported cron pattern/);
  });

  it('listSchedules returns schedules for the team only', async () => {
    const db = await setup();
    setupWorkspace(db, 'team-b', 'ltk_other_key_12345678901234567890');
    await definePlaybook(db, 'team-b', 'bob', {
      name: 'cleanup',
      description: 'other team',
      tasks: [{ description: 'do it' }],
    });
    await defineSchedule(db, 'team-a', 'alice', {
      playbook_name: 'cleanup',
      cron_expression: '*/5 * * * *',
    });
    await defineSchedule(db, 'team-b', 'bob', {
      playbook_name: 'cleanup',
      cron_expression: '*/10 * * * *',
    });

    const listA = await listSchedules(db, 'team-a');
    expect(listA.total).toBe(1);
    expect(listA.schedules[0].workspaceId).toBe('team-a');
  });

  it('deleteSchedule removes the row', async () => {
    const db = await setup();
    const s = await defineSchedule(db, 'team-a', 'alice', {
      playbook_name: 'cleanup',
      cron_expression: '*/5 * * * *',
    });
    expect((await deleteSchedule(db, 'team-a', s.id)).deleted).toBe(true);
    expect((await listSchedules(db, 'team-a')).total).toBe(0);
    // Second delete returns false
    expect((await deleteSchedule(db, 'team-a', s.id)).deleted).toBe(false);
  });

  it('deleteSchedule is team-scoped', async () => {
    const db = await setup();
    setupWorkspace(db, 'team-b', 'ltk_other_key_12345678901234567890');
    const s = await defineSchedule(db, 'team-a', 'alice', {
      playbook_name: 'cleanup',
      cron_expression: '*/5 * * * *',
    });
    expect((await deleteSchedule(db, 'team-b', s.id)).deleted).toBe(false);
    expect((await listSchedules(db, 'team-a')).total).toBe(1);
  });

  it('getDueSchedules returns only overdue + enabled rows, cross-team', async () => {
    const db = await setup();
    setupWorkspace(db, 'team-b', 'ltk_other_key_12345678901234567890');
    await definePlaybook(db, 'team-b', 'bob', {
      name: 'cleanup',
      description: 'other team',
      tasks: [{ description: 'do it' }],
    });

    // Insert three schedules with hand-crafted next_run_at
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();

    db.prepare(
      `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run('team-a', 'cleanup', '*/5 * * * *', past, 'alice');

    db.prepare(
      `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run('team-b', 'cleanup', '*/10 * * * *', past, 'bob');

    db.prepare(
      `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run('team-a', 'cleanup', '*/15 * * * *', future, 'alice');

    // Disabled but overdue — should NOT be returned
    db.prepare(
      `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run('team-a', 'cleanup', '*/30 * * * *', past, 'alice');

    const due = await getDueSchedules(db);
    expect(due.length).toBe(2);
    const workspaceIds = due.map((d) => d.workspaceId).sort();
    expect(workspaceIds).toEqual(['team-a', 'team-b']);
  });
});

describe('Scheduler worker', () => {
  it('runDueSchedules runs overdue playbooks and advances next_run_at', async () => {
    const db = createTestDb();
    setupWorkspace(db, 'team-a');
    await definePlaybook(db, 'team-a', 'alice', {
      name: 'cleanup',
      description: 'nightly cleanup',
      tasks: [{ description: 'do cleanup' }, { description: 'verify' }],
    });

    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run('team-a', 'cleanup', '*/5 * * * *', past, 'alice');

    const fired = await runDueSchedules(db);
    expect(fired).toBe(1);

    // next_run_at should now be in the future
    const row = db.rawDb
      .prepare('SELECT * FROM schedules WHERE workspace_id = ?')
      .get('team-a') as { next_run_at: string; last_run_at: string | null; last_workflow_run_id: number | null };
    expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(row.last_run_at).not.toBeNull();
    expect(row.last_workflow_run_id).toBeGreaterThan(0);

    // Playbook was run — two tasks were created
    const tasks = db.rawDb.prepare('SELECT * FROM tasks WHERE workspace_id = ?').all('team-a') as unknown[];
    expect(tasks).toHaveLength(2);

    // SCHEDULE_FIRED event broadcast
    const events = db.rawDb
      .prepare(`SELECT * FROM events WHERE workspace_id = ? AND tags LIKE '%schedule_fired%'`)
      .all('team-a') as unknown[];
    expect(events.length).toBeGreaterThan(0);

    // Second pass should not fire again (not due)
    expect(await runDueSchedules(db)).toBe(0);
  });
});

describe('Schedules HTTP API', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestContext();
    // Seed a playbook to reference
    await definePlaybook(ctx.db, ctx.workspaceId, ctx.agentId, {
      name: 'nightly',
      description: 'nightly pipeline',
      tasks: [{ description: 'step 1' }],
    });
  });

  it('POST /api/v1/schedules — defines a schedule', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/schedules', {
      headers: authHeaders(ctx.apiKey),
      body: { playbook_name: 'nightly', cron_expression: '*/5 * * * *' },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.playbookName).toBe('nightly');
    expect(data.cronExpression).toBe('*/5 * * * *');
    expect(data.enabled).toBe(true);
    expect(data.nextRunAt).toBeTruthy();
  });

  it('POST rejects invalid cron with 400', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/schedules', {
      headers: authHeaders(ctx.apiKey),
      body: { playbook_name: 'nightly', cron_expression: '* * * * *' },
    });
    expect(res.status).toBe(400);
  });

  it('POST rejects unknown playbook with 404', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/schedules', {
      headers: authHeaders(ctx.apiKey),
      body: { playbook_name: 'does-not-exist', cron_expression: '*/5 * * * *' },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/schedules — lists schedules', async () => {
    await request(ctx.app, 'POST', '/api/v1/schedules', {
      headers: authHeaders(ctx.apiKey),
      body: { playbook_name: 'nightly', cron_expression: '*/5 * * * *' },
    });
    const res = await request(ctx.app, 'GET', '/api/v1/schedules', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(1);
  });

  it('DELETE /api/v1/schedules/:id — removes a schedule', async () => {
    const defineRes = await request(ctx.app, 'POST', '/api/v1/schedules', {
      headers: authHeaders(ctx.apiKey),
      body: { playbook_name: 'nightly', cron_expression: '*/5 * * * *' },
    });
    const { id } = await defineRes.json();

    const delRes = await request(ctx.app, 'DELETE', `/api/v1/schedules/${id}`, {
      headers: authHeaders(ctx.apiKey),
    });
    expect(delRes.status).toBe(200);
    const delData = await delRes.json();
    expect(delData.deleted).toBe(true);

    const listRes = await request(ctx.app, 'GET', '/api/v1/schedules', {
      headers: authHeaders(ctx.apiKey),
    });
    const listData = await listRes.json();
    expect(listData.total).toBe(0);
  });

  it('DELETE with non-numeric id returns 400', async () => {
    const res = await request(ctx.app, 'DELETE', '/api/v1/schedules/abc', {
      headers: authHeaders(ctx.apiKey),
    });
    expect(res.status).toBe(400);
  });
});
