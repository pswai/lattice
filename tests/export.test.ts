import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, authHeaders, request, setupWorkspace, type TestContext } from './helpers.js';
import { exportWorkspaceData, EVENT_EXPORT_LIMIT, REDACTED } from '../src/models/export.js';
import { saveContext } from '../src/models/context.js';
import { broadcastInternal } from '../src/models/event.js';
import { createTask, updateTask } from '../src/models/task.js';
import { registerAgent } from '../src/models/agent.js';
import { sendMessage } from '../src/models/message.js';
import { saveArtifact } from '../src/models/artifact.js';
import { definePlaybook, runPlaybook } from '../src/models/playbook.js';
import { defineProfile } from '../src/models/profile.js';
import { defineSchedule } from '../src/models/schedule.js';
import { defineInboundEndpoint } from '../src/models/inbound.js';
import { createWebhook } from '../src/models/webhook.js';

describe('Team data export', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  async function populateTeam(): Promise<void> {
    const { db, workspaceId } = ctx;
    const agent = 'alice';

    // context
    await saveContext(db, workspaceId, agent, { key: 'k1', value: 'v1', tags: ['a'] });
    await saveContext(db, workspaceId, agent, { key: 'k2', value: 'v2', tags: ['b'] });

    // events (via broadcastInternal)
    await broadcastInternal(db, workspaceId, 'BROADCAST', 'hello', ['x'], agent);

    // tasks with dependency
    const t1 = await createTask(db, workspaceId, agent, { description: 'first', status: 'open' });
    const t2 = await createTask(db, workspaceId, agent, {
      description: 'second',
      status: 'open',
      depends_on: [t1.task_id],
    });
    expect(t2.task_id).toBeGreaterThan(0);

    // agents
    await registerAgent(db, workspaceId, { agent_id: 'bob', capabilities: ['research'] });

    // messages
    await sendMessage(db, workspaceId, agent, { to: 'bob', message: 'hey', tags: ['intro'] });

    // artifacts
    await saveArtifact(db, workspaceId, agent, {
      key: 'report.md',
      content_type: 'text/markdown',
      content: '# hello\n\nworld',
      metadata: { author: 'alice' },
    });

    // playbooks + workflow runs
    await definePlaybook(db, workspaceId, agent, {
      name: 'pb1',
      description: 'd',
      tasks: [{ description: 'x' }, { description: 'y' }],
    });
    await runPlaybook(db, workspaceId, agent, 'pb1');

    // profiles
    await defineProfile(db, workspaceId, agent, {
      name: 'researcher',
      description: 'r',
      system_prompt: 'you are',
    });

    // schedules
    await defineSchedule(db, workspaceId, agent, {
      playbook_name: 'pb1',
      cron_expression: '*/5 * * * *',
    });

    // inbound endpoints (with and without hmac_secret)
    await defineInboundEndpoint(db, workspaceId, agent, {
      name: 'gh-hook',
      action_type: 'create_task',
      action_config: { description_template: 'Issue: {{title}}' },
      hmac_secret: 'supersecret123',
    });
    await defineInboundEndpoint(db, workspaceId, agent, {
      name: 'no-hmac',
      action_type: 'broadcast_event',
      action_config: {},
    });

    // webhooks
    await createWebhook(db, workspaceId, agent, { url: 'https://example.com/hook' });
  }

  it('exports all sections with data when team has data in every table', async () => {
    await populateTeam();
    const snap = await exportWorkspaceData(ctx.db, ctx.workspaceId);

    expect(snap.version).toBe('1');
    expect(snap.workspace_id).toBe(ctx.workspaceId);
    expect(typeof snap.exported_at).toBe('string');
    expect(new Date(snap.exported_at).toString()).not.toBe('Invalid Date');

    expect(snap.context_entries.length).toBe(2);
    expect(snap.events.length).toBeGreaterThan(0);
    expect(snap.tasks.length).toBe(4); // 2 direct + 2 from playbook
    expect(snap.task_dependencies.length).toBe(1);
    expect(snap.agents.length).toBeGreaterThan(0);
    expect(snap.messages.length).toBe(1);
    expect(snap.artifacts.length).toBe(1);
    expect(snap.playbooks.length).toBe(1);
    expect(snap.workflow_runs.length).toBe(1);
    expect(snap.agent_profiles.length).toBe(1);
    expect(snap.schedules.length).toBe(1);
    expect(snap.inbound_endpoints.length).toBe(2);
    expect(snap.webhooks.length).toBe(1);

    // counts match arrays
    expect(snap.counts.context_entries).toBe(snap.context_entries.length);
    expect(snap.counts.events).toBe(snap.events.length);
    expect(snap.counts.tasks).toBe(snap.tasks.length);
    expect(snap.counts.task_dependencies).toBe(snap.task_dependencies.length);
    expect(snap.counts.agents).toBe(snap.agents.length);
    expect(snap.counts.messages).toBe(snap.messages.length);
    expect(snap.counts.artifacts).toBe(snap.artifacts.length);
    expect(snap.counts.playbooks).toBe(snap.playbooks.length);
    expect(snap.counts.workflow_runs).toBe(snap.workflow_runs.length);
    expect(snap.counts.agent_profiles).toBe(snap.agent_profiles.length);
    expect(snap.counts.schedules).toBe(snap.schedules.length);
    expect(snap.counts.inbound_endpoints).toBe(snap.inbound_endpoints.length);
    expect(snap.counts.webhooks).toBe(snap.webhooks.length);
  });

  it('returns empty arrays and zero counts for an empty team', async () => {
    const snap = await exportWorkspaceData(ctx.db, ctx.workspaceId);

    expect(snap.context_entries).toEqual([]);
    expect(snap.events).toEqual([]);
    expect(snap.tasks).toEqual([]);
    expect(snap.task_dependencies).toEqual([]);
    expect(snap.agents).toEqual([]);
    expect(snap.messages).toEqual([]);
    expect(snap.artifacts).toEqual([]);
    expect(snap.playbooks).toEqual([]);
    expect(snap.workflow_runs).toEqual([]);
    expect(snap.agent_profiles).toEqual([]);
    expect(snap.schedules).toEqual([]);
    expect(snap.inbound_endpoints).toEqual([]);
    expect(snap.webhooks).toEqual([]);

    for (const v of Object.values(snap.counts)) {
      expect(v).toBe(0);
    }
  });

  it('redacts webhook secrets and inbound endpoint keys/hmac', async () => {
    await populateTeam();
    const snap = await exportWorkspaceData(ctx.db, ctx.workspaceId);

    for (const w of snap.webhooks) {
      expect(w.secret).toBe(REDACTED);
    }
    for (const e of snap.inbound_endpoints) {
      expect(e.endpoint_key).toBe(REDACTED);
    }
    const ghHook = snap.inbound_endpoints.find((e) => e.name === 'gh-hook');
    expect(ghHook?.hmac_secret).toBe(REDACTED);
    const noHmac = snap.inbound_endpoints.find((e) => e.name === 'no-hmac');
    expect(noHmac?.hmac_secret).toBeNull();
  });

  it('artifacts include metadata but not content field', async () => {
    await populateTeam();
    const snap = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    expect(snap.artifacts).toHaveLength(1);
    const a = snap.artifacts[0];
    expect(a.key).toBe('report.md');
    expect(a.content_type).toBe('text/markdown');
    expect(a.size).toBeGreaterThan(0);
    expect(a.created_by).toBeDefined();
    expect(a.created_at).toBeDefined();
    expect((a as Record<string, unknown>).content).toBeUndefined();
  });

  it('limits events to the last 1000', async () => {
    const { db, workspaceId } = ctx;
    const total = EVENT_EXPORT_LIMIT + 50;
    for (let i = 0; i < total; i++) {
      await broadcastInternal(db, workspaceId, 'BROADCAST', `msg ${i}`, [], 'bot');
    }
    const snap = await exportWorkspaceData(db, workspaceId);
    expect(snap.events.length).toBe(EVENT_EXPORT_LIMIT);
    // should be the most recent ones, in ascending id order
    const ids = snap.events.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
    // And the last id should be the most recent (highest) event id
    const maxRow = (ctx.rawDb)
      .prepare('SELECT MAX(id) as m FROM events WHERE workspace_id = ?')
      .get(workspaceId) as { m: number };
    expect(ids[ids.length - 1]).toBe(maxRow.m);
  });

  it('only includes data for the requesting team', async () => {
    await populateTeam();
    // Create a second team with its own data
    setupWorkspace(ctx.db, 'other-team', 'ltk_other_key_12345678901234567890');
    await saveContext(ctx.db, 'other-team', 'eve', { key: 'secret', value: 'v', tags: [] });

    const snap = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    for (const e of snap.context_entries) {
      expect(e.workspaceId).toBe(ctx.workspaceId);
    }
    expect(snap.context_entries.find((e) => e.key === 'secret')).toBeUndefined();
  });

  describe('REST: GET /api/v1/export', () => {
    it('returns the snapshot as JSON', async () => {
      await populateTeam();
      const res = await request(ctx.app, 'GET', '/api/v1/export', {
        headers: authHeaders(ctx.apiKey),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe('1');
      expect(body.workspace_id).toBe(ctx.workspaceId);
      expect(body.counts).toBeDefined();
      expect(Array.isArray(body.tasks)).toBe(true);
    });

    it('requires authentication', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/export', {});
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('is team-scoped: tasks/context only belong to caller team', async () => {
      await populateTeam();
      const res = await request(ctx.app, 'GET', '/api/v1/export', {
        headers: authHeaders(ctx.apiKey),
      });
      const body = await res.json();
      for (const t of body.tasks) {
        expect(t.workspaceId).toBe(ctx.workspaceId);
      }
    });
  });
});

// ─── Export incremental / delta behavior (from round3-coverage-p0) ─────

describe('Export — incremental / delta behavior', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should export only entries that exist at export time (snapshot)', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'entry-1', value: 'v1', tags: ['a'],
    });
    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'entry-2', value: 'v2', tags: ['b'],
    });

    const snapshot1 = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    expect(snapshot1.counts.context_entries).toBe(2);

    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'entry-3', value: 'v3', tags: ['c'],
    });

    const snapshot2 = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    expect(snapshot2.counts.context_entries).toBe(3);

    const newKeys = snapshot2.context_entries
      .filter((e) => !snapshot1.context_entries.some((s1) => s1.key === e.key))
      .map((e) => e.key);
    expect(newKeys).toEqual(['entry-3']);
  });

  it('should reflect updates in subsequent exports', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'mutable', value: 'version-1', tags: [],
    });

    const snap1 = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    const entry1 = snap1.context_entries.find((e) => e.key === 'mutable');
    expect(entry1!.value).toBe('version-1');

    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'mutable', value: 'version-2', tags: [],
    });

    const snap2 = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    const entry2 = snap2.context_entries.find((e) => e.key === 'mutable');
    expect(entry2!.value).toBe('version-2');
    expect(snap2.counts.context_entries).toBe(snap1.counts.context_entries);
  });

  it('should cap events to EVENT_EXPORT_LIMIT and return in chronological order', async () => {
    const stmt = ctx.rawDb.prepare(
      `INSERT INTO events (workspace_id, event_type, message, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    );
    const txn = ctx.rawDb.transaction(() => {
      for (let i = 0; i < EVENT_EXPORT_LIMIT + 50; i++) {
        stmt.run(ctx.workspaceId, 'BROADCAST', `event-${i}`, '["bulk"]', 'agent');
      }
    });
    txn();

    const exported = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    expect(exported.events.length).toBeLessThanOrEqual(EVENT_EXPORT_LIMIT);
    if (exported.events.length > 1) {
      expect(exported.events[0].id).toBeLessThan(
        exported.events[exported.events.length - 1].id,
      );
    }
  });

  it('should include version and exported_at metadata', async () => {
    const snap = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    expect(snap.version).toBe('1');
    expect(snap.workspace_id).toBe(ctx.workspaceId);
    expect(snap.exported_at).toBeTruthy();
    expect(new Date(snap.exported_at).getTime()).toBeGreaterThan(0);
  });

  it('should export all entity types even when empty', async () => {
    const snap = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    expect(snap.context_entries).toEqual([]);
    expect(snap.events).toEqual([]);
    expect(snap.tasks).toEqual([]);
    expect(snap.agents).toEqual([]);
    expect(snap.messages).toEqual([]);
    expect(snap.playbooks).toEqual([]);
    expect(snap.workflow_runs).toEqual([]);
    expect(snap.agent_profiles).toEqual([]);
    expect(snap.schedules).toEqual([]);
    expect(snap.inbound_endpoints).toEqual([]);
    expect(snap.webhooks).toEqual([]);
  });
});

// ─── Export context entries bounded to 10000 (from round3-fixes) ──────

describe('Export context entries bounded to 10000', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should cap exported context entries at 10000', async () => {
    const stmt = ctx.rawDb.prepare(
      `INSERT INTO context_entries (workspace_id, key, value, tags, created_by) VALUES (?, ?, ?, ?, ?)`,
    );
    const txn = ctx.rawDb.transaction(() => {
      for (let i = 0; i < 10_002; i++) {
        stmt.run(ctx.workspaceId, `key-${i}`, `value-${i}`, '["bulk"]', 'bulk-agent');
      }
    });
    txn();

    const exported = await exportWorkspaceData(ctx.db, ctx.workspaceId);
    expect(exported.context_entries.length).toBeLessThanOrEqual(10_000);
    expect(exported.counts.context_entries).toBeLessThanOrEqual(10_000);
  });
});

// ─── Webhook export redacts URL (from round8-fixes) ───────────────────

describe('Webhook export redacts URL', () => {
  it('should redact webhook URL in export', async () => {
    const db = createTestDb();
    setupWorkspace(db, 'test-team');

    await createWebhook(db, 'test-team', 'agent', {
      url: 'https://internal.corp.com/hooks/secret-path',
    });

    const exported = await exportWorkspaceData(db, 'test-team');
    expect(exported.webhooks.length).toBe(1);
    expect(exported.webhooks[0].url).toBe(REDACTED);
    expect(exported.webhooks[0].secret).toBe(REDACTED);
  });
});
