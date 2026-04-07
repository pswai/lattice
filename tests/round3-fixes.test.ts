/**
 * Tests for: context update tracking, playbook creator preservation, inbound webhook secret scanning, export caps, scheduler mutex, and MCP playbook vars scanning
 * - Context UPDATE tracks updated_by/updated_at (model + REST + search results)
 * - Playbook created_by preserved when a different agent updates
 * - Inbound webhook payload secret scanning (AWS keys, Stripe keys, nested fields)
 * - Export context entries capped at 10,000
 * - Scheduler runDueSchedules mutex prevents duplicate concurrent runs
 * - MCP run_playbook vars scanned for secrets (AWS, GitHub PAT, clean passthrough)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, authHeaders, request, type TestContext } from './helpers.js';
import { saveContext, getContext } from '../src/models/context.js';
import { definePlaybook, runPlaybook } from '../src/models/playbook.js';
import { processInboundWebhook, defineInboundEndpoint } from '../src/models/inbound.js';
import { exportWorkspaceData } from '../src/models/export.js';
import { runDueSchedules } from '../src/services/scheduler.js';
import { defineSchedule, getDueSchedules } from '../src/models/schedule.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import type { SqliteAdapter } from '../src/db/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../src/models/types.js';

// ─── MCP helper ────────────────────────────────────────────────────────

function createMcpTestContext() {
  const db = createTestDb();
  setupWorkspace(db, 'test-team');
  const mcp = createMcpServer(db);
  const auth: AuthContext = {
    workspaceId: 'test-team',
    agentId: 'test-agent',
    scope: 'write',
    ip: '127.0.0.1',
    requestId: 'req-test-1',
  };
  return { db, mcp, auth };
}

async function callTool(
  mcp: McpServer,
  auth: AuthContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const tool = (mcp as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return mcpAuthStorage.run(auth, () =>
    tool.inputSchema ? tool.handler(args, {}) : tool.handler({}),
  );
}

// ─── H1: Context UPDATE tracks updater ─────────────────────────────────

describe('H1 — Context UPDATE tracks updated_by/updated_at', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should set updated_by and updated_at on context update', async () => {
    // Agent A creates an entry
    await saveContext(ctx.db, ctx.workspaceId, 'agent-a', {
      key: 'shared-key',
      value: 'original value',
      tags: ['test'],
    });

    // Verify initial state: no updater
    const row1 = ctx.rawDb.prepare(
      'SELECT updated_by, updated_at FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'shared-key') as any;
    expect(row1.updated_by).toBeNull();
    expect(row1.updated_at).toBeNull();

    // Agent B updates the same entry
    await saveContext(ctx.db, ctx.workspaceId, 'agent-b', {
      key: 'shared-key',
      value: 'updated value',
      tags: ['test'],
    });

    // Verify updated_by is agent-b and updated_at is set
    const row2 = ctx.rawDb.prepare(
      'SELECT updated_by, updated_at, created_by FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'shared-key') as any;
    expect(row2.updated_by).toBe('agent-b');
    expect(row2.updated_at).toBeTruthy();
    // Original creator is preserved
    expect(row2.created_by).toBe('agent-a');
  });

  it('should not set updated_by on initial insert', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent-a', {
      key: 'new-key',
      value: 'new value',
      tags: [],
    });

    const row = ctx.rawDb.prepare(
      'SELECT updated_by, updated_at FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'new-key') as any;
    expect(row.updated_by).toBeNull();
    expect(row.updated_at).toBeNull();
  });

  it('should expose updatedBy and updatedAt in context search results', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent-a', {
      key: 'search-key',
      value: 'searchable context value here',
      tags: ['test'],
    });
    await saveContext(ctx.db, ctx.workspaceId, 'agent-b', {
      key: 'search-key',
      value: 'updated searchable context value here',
      tags: ['test'],
    });

    const result = await getContext(ctx.db, ctx.workspaceId, { query: 'searchable context', tags: ['test'] });
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].updatedBy).toBe('agent-b');
    expect(result.entries[0].updatedAt).toBeTruthy();
  });

  it('should track updater via REST API', async () => {
    const headers = authHeaders(ctx.apiKey, 'agent-a');
    await request(ctx.app, 'POST', '/api/v1/context', {
      headers,
      body: { key: 'rest-key', value: 'original', tags: ['rest'] },
    });

    const headersB = authHeaders(ctx.apiKey, 'agent-b');
    await request(ctx.app, 'POST', '/api/v1/context', {
      headers: headersB,
      body: { key: 'rest-key', value: 'updated', tags: ['rest'] },
    });

    const row = ctx.rawDb.prepare(
      'SELECT updated_by FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'rest-key') as any;
    expect(row.updated_by).toBe('agent-b');
  });
});

// ─── M1: Playbook created_by preserved on update ───────────────────────

describe('M1 — Playbook created_by preserved on update', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should preserve original created_by when a different agent updates a playbook', async () => {
    // Agent A creates the playbook
    await definePlaybook(ctx.db, ctx.workspaceId, 'agent-a', {
      name: 'deploy-pipeline',
      description: 'Deploy sequence',
      tasks: [{ description: 'Build' }, { description: 'Test', depends_on_index: [0] }],
    });

    // Agent B updates the same playbook
    await definePlaybook(ctx.db, ctx.workspaceId, 'agent-b', {
      name: 'deploy-pipeline',
      description: 'Updated deploy sequence',
      tasks: [{ description: 'Build v2' }, { description: 'Test v2', depends_on_index: [0] }],
    });

    // Verify created_by is still agent-a
    const row = ctx.rawDb.prepare(
      'SELECT created_by, description FROM playbooks WHERE workspace_id = ? AND name = ?',
    ).get(ctx.workspaceId, 'deploy-pipeline') as any;
    expect(row.created_by).toBe('agent-a');
    expect(row.description).toBe('Updated deploy sequence');
  });

  it('should return original created_by from getPlaybook after update', async () => {
    await definePlaybook(ctx.db, ctx.workspaceId, 'creator', {
      name: 'my-pb',
      description: 'original',
      tasks: [{ description: 'step 1' }],
    });

    const updated = await definePlaybook(ctx.db, ctx.workspaceId, 'updater', {
      name: 'my-pb',
      description: 'updated',
      tasks: [{ description: 'step 1 revised' }],
    });

    expect(updated.createdBy).toBe('creator');
    expect(updated.description).toBe('updated');
  });
});

// ─── M2: Inbound webhook secret scanning ───────────────────────────────

describe('M2 — processInboundWebhook rejects payloads with secrets', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should reject payload containing an AWS access key', async () => {
    const endpoint = await defineInboundEndpoint(ctx.db, ctx.workspaceId, 'agent', {
      name: 'test-hook',
      action_type: 'save_context',
      action_config: { key: 'from-webhook' },
    });

    await expect(
      processInboundWebhook(ctx.db, endpoint, {
        value: 'credentials are AKIAIOSFODNN7EXAMPLE',
      }),
    ).rejects.toThrow(/secret/i);
  });

  it('should reject payload containing a Stripe secret key', async () => {
    const endpoint = await defineInboundEndpoint(ctx.db, ctx.workspaceId, 'agent', {
      name: 'stripe-hook',
      action_type: 'broadcast_event',
      action_config: { event_type: 'BROADCAST' },
    });

    await expect(
      processInboundWebhook(ctx.db, endpoint, {
        message: 'sk_live_1234567890abcdefghijklmn',
      }),
    ).rejects.toThrow(/secret/i);
  });

  it('should reject payload with secret in nested fields', async () => {
    const endpoint = await defineInboundEndpoint(ctx.db, ctx.workspaceId, 'agent', {
      name: 'nested-hook',
      action_type: 'create_task',
      action_config: {},
    });

    await expect(
      processInboundWebhook(ctx.db, endpoint, {
        description: 'Deploy task',
        config: { api_key: 'AKIAIOSFODNN7EXAMPLE' },
      }),
    ).rejects.toThrow(/secret/i);
  });

  it('should allow clean payloads through', async () => {
    const endpoint = await defineInboundEndpoint(ctx.db, ctx.workspaceId, 'agent', {
      name: 'clean-hook',
      action_type: 'create_task',
      action_config: {},
    });

    const result = await processInboundWebhook(ctx.db, endpoint, {
      description: 'A normal task from webhook',
    });
    expect(result.action).toBe('create_task');
  });
});

// ─── M3: Export context entries bounded ─────────────────────────────────

describe('M3 — Export context entries bounded to 10000', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should cap exported context entries at 10000', async () => {
    // Insert 10,002 context entries directly via raw SQL for speed
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

// ─── M4: Scheduler mutex ────────────────────────────────────────────────

describe('M4 — Scheduler runDueSchedules mutex prevents duplicate runs', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should not double-fire when called concurrently', async () => {
    // Create a playbook for the schedule to run
    await definePlaybook(ctx.db, ctx.workspaceId, 'agent', {
      name: 'scheduled-pb',
      description: 'A test playbook',
      tasks: [{ description: 'Task 1' }],
    });

    // Create a schedule that is due now
    await defineSchedule(ctx.db, ctx.workspaceId, 'agent', {
      playbook_name: 'scheduled-pb',
      cron_expression: '*/1 * * * *',
      enabled: true,
    });

    // Force next_run_at to the past so it's due
    ctx.rawDb.prepare(
      `UPDATE schedules SET next_run_at = datetime('now', '-1 minute') WHERE workspace_id = ?`,
    ).run(ctx.workspaceId);

    // Fire two concurrent scheduler passes
    const [r1, r2] = await Promise.all([
      runDueSchedules(ctx.db),
      runDueSchedules(ctx.db),
    ]);

    // One should fire 1, the other should fire 0 (mutex)
    const total = r1 + r2;
    expect(total).toBe(1);
  });
});

// ─── M5: MCP run_playbook vars secret scanning ─────────────────────────

describe('M5 — MCP run_playbook vars scanned for secrets', () => {
  let db: SqliteAdapter;
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestContext();
    db = ctx.db;
    mcp = ctx.mcp;
    auth = ctx.auth;

    // Create the playbook first
    db.rawDb.prepare(`
      INSERT INTO playbooks (workspace_id, name, description, tasks_json, created_by)
      VALUES ('test-team', 'var-pb', 'Test', ?, 'agent')
    `).run(JSON.stringify([{ description: 'Deploy {{vars.env}}' }]));
  });

  it('should reject vars containing an AWS key', async () => {
    const result = await callTool(mcp, auth, 'run_playbook', {
      agent_id: 'test-agent',
      name: 'var-pb',
      vars: { env: 'AKIAIOSFODNN7EXAMPLE' },
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/secret/i);
  });

  it('should reject vars containing a GitHub PAT', async () => {
    const result = await callTool(mcp, auth, 'run_playbook', {
      agent_id: 'test-agent',
      name: 'var-pb',
      vars: { token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
    });

    expect(result.isError).toBe(true);
  });

  it('should allow clean vars through', async () => {
    const result = await callTool(mcp, auth, 'run_playbook', {
      agent_id: 'test-agent',
      name: 'var-pb',
      vars: { env: 'production' },
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.workflow_run_id).toBeGreaterThan(0);
    expect(data.created_task_ids.length).toBe(1);
  });
});
