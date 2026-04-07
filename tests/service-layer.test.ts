import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, setupWorkspace } from './helpers.js';
import { definePlaybook } from '../src/models/playbook.js';
import { runDueSchedules } from '../src/services/scheduler.js';
import { createTask, updateTask } from '../src/models/task.js';
import {
  createWebhook,
  createDelivery,
  markDeliveryFailure,
  markDeliverySuccess,
  getPendingDeliveries,
  RETRY_SCHEDULE_MS,
  MAX_CONSECUTIVE_FAILURES,
} from '../src/models/webhook.js';
import { broadcastInternal } from '../src/models/event.js';
import { writeAudit, queryAudit, pruneAuditOlderThan } from '../src/models/audit.js';
import type { SqliteAdapter } from '../src/db/adapter.js';

describe('Service Layer — Coverage Gaps Round 2', () => {
  // ─── Scheduler ───────────────────────────────────────────────────────
  describe('Scheduler — failure handling', () => {
    async function setupScheduler() {
      const db = createTestDb();
      setupWorkspace(db, 'team-a');
      await definePlaybook(db, 'team-a', 'alice', {
        name: 'nightly',
        description: 'nightly job',
        tasks: [{ description: 'step 1' }],
      });
      return db;
    }

    it('broadcasts error event when playbook execution fails', async () => {
      const db = await setupScheduler();

      // Create a schedule pointing to a playbook that will be deleted
      const past = new Date(Date.now() - 60_000).toISOString();
      db.rawDb.prepare(
        `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).run('team-a', 'does-not-exist', '*/5 * * * *', past, 'alice');

      const fired = await runDueSchedules(db);
      // runDueSchedules catches the error and returns 0 for failed runs
      expect(fired).toBe(0);

      // Verify an ERROR event was broadcast
      const events = db.rawDb
        .prepare(`SELECT * FROM events WHERE workspace_id = ? AND event_type = 'ERROR'`)
        .all('team-a') as Array<{ message: string; tags: string }>;
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].message).toContain('failed');
      expect(events[0].tags).toContain('error');
    });

    it('advances next_run_at even on failure to avoid tight-loop', async () => {
      const db = await setupScheduler();

      const past = new Date(Date.now() - 60_000).toISOString();
      db.rawDb.prepare(
        `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).run('team-a', 'does-not-exist', '*/5 * * * *', past, 'alice');

      await runDueSchedules(db);

      const row = db.rawDb
        .prepare('SELECT next_run_at FROM schedules WHERE workspace_id = ?')
        .get('team-a') as { next_run_at: string };

      // next_run_at should be advanced to the future
      expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('successful schedule run creates tasks and fires event', async () => {
      const db = await setupScheduler();

      const past = new Date(Date.now() - 60_000).toISOString();
      db.rawDb.prepare(
        `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).run('team-a', 'nightly', '*/5 * * * *', past, 'alice');

      const fired = await runDueSchedules(db);
      expect(fired).toBe(1);

      // Tasks created by playbook
      const tasks = db.rawDb
        .prepare('SELECT * FROM tasks WHERE workspace_id = ?')
        .all('team-a') as unknown[];
      expect(tasks.length).toBe(1);

      // BROADCAST event with schedule_fired tag
      const events = db.rawDb
        .prepare(`SELECT * FROM events WHERE workspace_id = ? AND tags LIKE '%schedule_fired%'`)
        .all('team-a') as unknown[];
      expect(events.length).toBe(1);
    });

    it('does not fire disabled schedules', async () => {
      const db = await setupScheduler();

      const past = new Date(Date.now() - 60_000).toISOString();
      db.rawDb.prepare(
        `INSERT INTO schedules (workspace_id, playbook_name, cron_expression, enabled, next_run_at, created_by)
         VALUES (?, ?, ?, 0, ?, ?)`,
      ).run('team-a', 'nightly', '*/5 * * * *', past, 'alice');

      const fired = await runDueSchedules(db);
      expect(fired).toBe(0);
    });
  });

  // ─── Task Reaper Concurrency ─────────────────────────────────────────
  describe('Task reaper — concurrency handling', () => {
    let db: SqliteAdapter;
    const workspaceId = 'team-a';

    beforeEach(() => {
      db = createTestDb();
      setupWorkspace(db, workspaceId);
    });

    function reapAbandonedTasks(dbArg: SqliteAdapter, timeoutMinutes: number): number {
      const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
      const staleTasks = dbArg.rawDb.prepare(`
        SELECT id, workspace_id, description, claimed_by, version
        FROM tasks
        WHERE status = 'claimed'
          AND claimed_at < ?
      `).all(cutoff) as Array<{ id: number; workspace_id: string; description: string; claimed_by: string; version: number }>;

      let reaped = 0;
      for (const task of staleTasks) {
        const result = dbArg.rawDb.prepare(`
          UPDATE tasks
          SET status = 'abandoned',
              claimed_by = NULL,
              claimed_at = NULL,
              result = 'Auto-released: agent did not complete within timeout',
              version = version + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND version = ?
        `).run(task.id, task.version);
        if (result.changes > 0) reaped++;
      }
      return reaped;
    }

    it('reaper skips task if version changed between SELECT and UPDATE (concurrent claim)', async () => {
      // Create a stale task
      const task = await createTask(db, workspaceId, 'slow-agent', {
        description: 'Long-running task',
      });

      // Backdate claimed_at to make it stale
      const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      db.rawDb.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, task.task_id);

      // Read version like the reaper would (simulating SELECT phase)
      const currentRow = db.rawDb.prepare('SELECT version FROM tasks WHERE id = ?').get(task.task_id) as { version: number };
      const staleVersion = currentRow.version;

      // Simulate concurrent heartbeat AFTER reaper's SELECT but BEFORE its UPDATE
      db.rawDb.prepare('UPDATE tasks SET version = version + 1 WHERE id = ?').run(task.task_id);

      // Now attempt the reaper's UPDATE with the stale version
      const result = db.rawDb.prepare(`
        UPDATE tasks
        SET status = 'abandoned',
            claimed_by = NULL,
            claimed_at = NULL,
            result = 'Auto-released: agent did not complete within timeout',
            version = version + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND version = ?
      `).run(task.task_id, staleVersion);

      // Optimistic lock should prevent the update
      expect(result.changes).toBe(0);

      // Task should still be claimed
      const row = db.rawDb.prepare('SELECT status FROM tasks WHERE id = ?').get(task.task_id) as { status: string };
      expect(row.status).toBe('claimed');
    });

    it('reaper successfully reaps truly abandoned task', async () => {
      const task = await createTask(db, workspaceId, 'dead-agent', {
        description: 'Abandoned task',
      });
      const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      db.rawDb.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, task.task_id);

      const reaped = reapAbandonedTasks(db, 30);
      expect(reaped).toBe(1);

      const row = db.rawDb.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(task.task_id) as { status: string; claimed_by: string | null };
      expect(row.status).toBe('abandoned');
      expect(row.claimed_by).toBeNull();
    });

    it('reaper handles multiple stale tasks in one pass', async () => {
      for (let i = 0; i < 5; i++) {
        const task = await createTask(db, workspaceId, `agent-${i}`, {
          description: `Stale task ${i}`,
        });
        const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        db.rawDb.prepare('UPDATE tasks SET claimed_at = ? WHERE id = ?').run(pastTime, task.task_id);
      }

      const reaped = reapAbandonedTasks(db, 30);
      expect(reaped).toBe(5);
    });
  });

  // ─── Webhook Dispatcher Retry Logic ──────────────────────────────────
  describe('Webhook dispatcher — retry logic', () => {
    let db: SqliteAdapter;
    const workspaceId = 'team-a';

    beforeEach(() => {
      db = createTestDb();
      setupWorkspace(db, workspaceId);
    });

    it('markDeliveryFailure schedules retry with increasing delay', async () => {
      // Create a webhook + event + delivery
      const wh = await createWebhook(db, workspaceId, 'agent', {
        url: 'https://example.com/hook',
      });
      await broadcastInternal(db, workspaceId, 'BROADCAST', 'test event', ['test'], 'agent');
      const events = db.rawDb
        .prepare('SELECT id FROM events WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ id: number }>;
      const delivery = await createDelivery(db, wh.id, events[0].id);

      // First failure — should schedule retry
      const beforeRetry = Date.now();
      await markDeliveryFailure(db, delivery.id, wh.id, 500, 'Server Error', true);

      const row = db.rawDb
        .prepare('SELECT status, attempts, next_retry_at FROM webhook_deliveries WHERE id = ?')
        .get(delivery.id) as { status: string; attempts: number; next_retry_at: string | null };

      expect(row.status).toBe('pending'); // Still retriable
      expect(row.attempts).toBe(1);
      expect(row.next_retry_at).not.toBeNull();

      // Next retry should be approximately RETRY_SCHEDULE_MS[1] from now
      const retryAt = new Date(row.next_retry_at!).getTime();
      expect(retryAt).toBeGreaterThan(beforeRetry);
    });

    it('markDeliveryFailure marks as dead after exhausting retries', async () => {
      const wh = await createWebhook(db, workspaceId, 'agent', {
        url: 'https://example.com/hook',
      });
      await broadcastInternal(db, workspaceId, 'BROADCAST', 'test', ['test'], 'agent');
      const events = db.rawDb
        .prepare('SELECT id FROM events WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ id: number }>;
      const delivery = await createDelivery(db, wh.id, events[0].id);

      // Exhaust all retries
      const maxRetries = RETRY_SCHEDULE_MS.length;
      for (let i = 0; i < maxRetries; i++) {
        // Set attempts to i so next attempt = i+1
        db.rawDb
          .prepare('UPDATE webhook_deliveries SET attempts = ?, status = ? WHERE id = ?')
          .run(i, 'pending', delivery.id);
        await markDeliveryFailure(db, delivery.id, wh.id, 500, `Retry ${i + 1}`, true);
      }

      const row = db.rawDb
        .prepare('SELECT status FROM webhook_deliveries WHERE id = ?')
        .get(delivery.id) as { status: string };
      expect(row.status).toBe('dead');
    });

    it('4xx errors are terminal (no retry)', async () => {
      const wh = await createWebhook(db, workspaceId, 'agent', {
        url: 'https://example.com/hook',
      });
      await broadcastInternal(db, workspaceId, 'BROADCAST', 'test', ['test'], 'agent');
      const events = db.rawDb
        .prepare('SELECT id FROM events WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ id: number }>;
      const delivery = await createDelivery(db, wh.id, events[0].id);

      await markDeliveryFailure(db, delivery.id, wh.id, 404, 'Not Found', false);

      const row = db.rawDb
        .prepare('SELECT status, next_retry_at FROM webhook_deliveries WHERE id = ?')
        .get(delivery.id) as { status: string; next_retry_at: string | null };

      expect(row.status).toBe('failed');
      expect(row.next_retry_at).toBeNull();
    });

    it('successful delivery resets webhook failure_count', async () => {
      const wh = await createWebhook(db, workspaceId, 'agent', {
        url: 'https://example.com/hook',
      });

      // Bump failure count
      db.rawDb.prepare('UPDATE webhooks SET failure_count = 5 WHERE id = ?').run(wh.id);

      await broadcastInternal(db, workspaceId, 'BROADCAST', 'test', ['test'], 'agent');
      const events = db.rawDb
        .prepare('SELECT id FROM events WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ id: number }>;
      const delivery = await createDelivery(db, wh.id, events[0].id);

      await markDeliverySuccess(db, delivery.id, wh.id, 200);

      const whRow = db.rawDb
        .prepare('SELECT failure_count FROM webhooks WHERE id = ?')
        .get(wh.id) as { failure_count: number };
      expect(whRow.failure_count).toBe(0);
    });

    it('webhook is disabled after MAX_CONSECUTIVE_FAILURES', async () => {
      const wh = await createWebhook(db, workspaceId, 'agent', {
        url: 'https://example.com/hook',
      });

      // Set failure_count to threshold - 1
      db.rawDb.prepare('UPDATE webhooks SET failure_count = ? WHERE id = ?')
        .run(MAX_CONSECUTIVE_FAILURES - 1, wh.id);

      await broadcastInternal(db, workspaceId, 'BROADCAST', 'test', ['test'], 'agent');
      const events = db.rawDb
        .prepare('SELECT id FROM events WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ id: number }>;
      const delivery = await createDelivery(db, wh.id, events[0].id);

      await markDeliveryFailure(db, delivery.id, wh.id, 500, 'Error', true);

      const whRow = db.rawDb
        .prepare('SELECT active, failure_count FROM webhooks WHERE id = ?')
        .get(wh.id) as { active: number; failure_count: number };
      expect(whRow.failure_count).toBe(MAX_CONSECUTIVE_FAILURES);
      expect(whRow.active).toBe(0); // Disabled
    });
  });

  // ─── Audit / Event Cleanup ───────────────────────────────────────────
  describe('Audit log cleanup', () => {
    let db: SqliteAdapter;

    beforeEach(() => {
      db = createTestDb();
      setupWorkspace(db, 'team-a');
    });

    it('pruneAuditOlderThan removes old entries', async () => {
      // Insert audit entries with timestamps in the past
      const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year ago
      const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago

      await writeAudit(db, {
        workspaceId: 'team-a',
        actor: 'alice',
        action: 'task.create',
      });

      // Backdate the first entry
      db.rawDb.prepare('UPDATE audit_log SET created_at = ? WHERE id = 1').run(oldDate);

      // Add a recent entry
      await writeAudit(db, {
        workspaceId: 'team-a',
        actor: 'bob',
        action: 'task.update',
      });

      // Prune entries older than 30 days
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const deleted = await pruneAuditOlderThan(db, cutoff);
      expect(deleted).toBe(1);

      // Recent entry should remain
      const remaining = await queryAudit(db, { workspaceId: 'team-a' });
      expect(remaining.length).toBe(1);
      expect(remaining[0].actor).toBe('bob');
    });

    it('pruneAuditOlderThan rejects future dates', async () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await expect(pruneAuditOlderThan(db, future)).rejects.toThrow(/past/);
    });

    it('pruneAuditOlderThan rejects invalid dates', async () => {
      await expect(pruneAuditOlderThan(db, 'not-a-date')).rejects.toThrow(/valid ISO date/);
    });

    it('pruneAuditOlderThan returns 0 when nothing to prune', async () => {
      // No audit entries exist
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const deleted = await pruneAuditOlderThan(db, cutoff);
      expect(deleted).toBe(0);
    });

    it('pruneAuditOlderThan handles large batch of old entries', async () => {
      // Insert many old audit entries
      const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const insertStmt = db.rawDb.prepare(
        `INSERT INTO audit_log (workspace_id, actor, action, metadata, created_at)
         VALUES (?, ?, ?, '{}', ?)`,
      );
      const insertMany = db.rawDb.transaction(() => {
        for (let i = 0; i < 500; i++) {
          insertStmt.run('team-a', `agent-${i % 10}`, 'task.create', oldDate);
        }
      });
      insertMany();

      // Add 5 recent entries
      for (let i = 0; i < 5; i++) {
        await writeAudit(db, {
          workspaceId: 'team-a',
          actor: 'recent-agent',
          action: 'task.update',
        });
      }

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const deleted = await pruneAuditOlderThan(db, cutoff);
      expect(deleted).toBe(500);

      const remaining = await queryAudit(db, { workspaceId: 'team-a' });
      expect(remaining.length).toBe(5);
    });

    it('pruneAuditOlderThan only deletes entries before cutoff, not at cutoff', async () => {
      const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const justBefore = new Date(cutoffDate.getTime() - 1000).toISOString();
      const justAfter = new Date(cutoffDate.getTime() + 1000).toISOString();

      await writeAudit(db, { workspaceId: 'team-a', actor: 'before', action: 'test' });
      db.rawDb.prepare('UPDATE audit_log SET created_at = ? WHERE id = 1').run(justBefore);

      await writeAudit(db, { workspaceId: 'team-a', actor: 'after', action: 'test' });
      db.rawDb.prepare('UPDATE audit_log SET created_at = ? WHERE id = 2').run(justAfter);

      const deleted = await pruneAuditOlderThan(db, cutoffDate.toISOString());
      expect(deleted).toBe(1);

      const remaining = await queryAudit(db, { workspaceId: 'team-a' });
      expect(remaining.length).toBe(1);
      expect(remaining[0].actor).toBe('after');
    });
  });
});
