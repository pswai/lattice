import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, setupWorkspace } from './helpers.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import { queryAudit } from '../src/models/audit.js';
import { getUsage, setUsageTracking } from '../src/models/usage.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SqliteAdapter } from '../src/db/adapter.js';
import type { AuthContext } from '../src/models/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────

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

/**
 * Call an MCP tool by name, running within the auth context.
 * Uses the internal _registeredTools handler — same path the SDK takes.
 */
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

async function getAuditRows(db: SqliteAdapter, workspaceId = 'test-team') {
  return queryAudit(db, { workspaceId });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('MCP Integration — Audit & Usage Tracking', () => {
  let db: SqliteAdapter;
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestContext();
    db = ctx.db;
    mcp = ctx.mcp;
    auth = ctx.auth;
    setUsageTracking(true);
  });

  afterEach(() => {
    setUsageTracking(false);
  });

  // ─── Mutating tools produce audit entries ─────────────────────────

  describe('mutating tools produce audit entries', () => {
    it('save_context audits context.create', async () => {
      await callTool(mcp, auth, 'save_context', {
        agent_id: 'test-agent',
        key: 'test-key',
        value: 'test-value',
        tags: [],
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe('test-agent');
      expect(rows[0].action).toBe('context.create');
      expect(rows[0].resource_type).toBe('context');
      const meta = JSON.parse(rows[0].metadata);
      expect(meta.source).toBe('mcp');
      expect(meta.tool).toBe('save_context');
    });

    it('broadcast audits event.create', async () => {
      await callTool(mcp, auth, 'broadcast', {
        agent_id: 'test-agent',
        event_type: 'BROADCAST',
        message: 'hello world',
        tags: [],
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('event.create');
      expect(rows[0].resource_type).toBe('event');
      const meta = JSON.parse(rows[0].metadata);
      expect(meta.source).toBe('mcp');
      expect(meta.tool).toBe('broadcast');
    });

    it('create_task audits task.create', async () => {
      await callTool(mcp, auth, 'create_task', {
        agent_id: 'test-agent',
        description: 'A test task',
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('task.create');
      expect(rows[0].resource_type).toBe('task');
    });

    it('update_task audits task.update', async () => {
      const createRes = await callTool(mcp, auth, 'create_task', {
        agent_id: 'test-agent',
        description: 'Task to update',
      });
      const created = JSON.parse(createRes.content[0].text);

      await callTool(mcp, auth, 'update_task', {
        agent_id: 'test-agent',
        task_id: created.task_id,
        status: 'completed',
        result: 'done',
        version: 1,
      });
      const rows = await getAuditRows(db);
      // 2 audit entries: create + update
      expect(rows).toHaveLength(2);
      const updateRow = rows.find((r) => r.action === 'task.update');
      expect(updateRow).toBeDefined();
      expect(updateRow!.resource_type).toBe('task');
    });

    it('register_agent audits agent.create', async () => {
      await callTool(mcp, auth, 'register_agent', {
        agent_id: 'new-agent',
        capabilities: ['python'],
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('agent.create');
      expect(rows[0].actor).toBe('new-agent');
    });

    it('send_message audits message.create', async () => {
      // Register recipient first (capabilities required by schema)
      await callTool(mcp, auth, 'register_agent', { agent_id: 'recipient', capabilities: [] });

      await callTool(mcp, auth, 'send_message', {
        agent_id: 'test-agent',
        to: 'recipient',
        message: 'hello',
        tags: [],
      });
      const rows = await getAuditRows(db);
      const msgRow = rows.find((r) => r.action === 'message.create');
      expect(msgRow).toBeDefined();
      expect(msgRow!.resource_type).toBe('message');
    });

    it('define_playbook audits playbook.create', async () => {
      await callTool(mcp, auth, 'define_playbook', {
        agent_id: 'test-agent',
        name: 'test-pb',
        description: 'A test playbook',
        tasks: [{ description: 'Step 1' }],
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('playbook.create');
      expect(rows[0].resource_type).toBe('playbook');
    });

    it('run_playbook audits workflow_run.create', async () => {
      // Define playbook first
      await callTool(mcp, auth, 'define_playbook', {
        agent_id: 'test-agent',
        name: 'run-me',
        description: 'Runnable playbook',
        tasks: [{ description: 'Step 1' }],
      });

      await callTool(mcp, auth, 'run_playbook', {
        agent_id: 'test-agent',
        name: 'run-me',
      });
      const rows = await getAuditRows(db);
      const runRow = rows.find((r) => r.action === 'workflow_run.create');
      expect(runRow).toBeDefined();
      expect(runRow!.resource_type).toBe('workflow_run');
    });

    it('define_schedule audits schedule.create', async () => {
      // Define playbook first (schedule requires one)
      await callTool(mcp, auth, 'define_playbook', {
        agent_id: 'test-agent',
        name: 'sched-pb',
        description: 'Scheduled playbook',
        tasks: [{ description: 'Step 1' }],
      });

      await callTool(mcp, auth, 'define_schedule', {
        agent_id: 'test-agent',
        playbook_name: 'sched-pb',
        cron_expression: '0 9 * * *',
      });
      const rows = await getAuditRows(db);
      const schedRow = rows.find((r) => r.action === 'schedule.create');
      expect(schedRow).toBeDefined();
      expect(schedRow!.resource_type).toBe('schedule');
    });

    it('delete_schedule audits schedule.delete', async () => {
      // Setup: define playbook + schedule
      await callTool(mcp, auth, 'define_playbook', {
        agent_id: 'test-agent',
        name: 'del-sched-pb',
        description: 'Playbook for schedule deletion test',
        tasks: [{ description: 'Step 1' }],
      });
      const schedRes = await callTool(mcp, auth, 'define_schedule', {
        agent_id: 'test-agent',
        playbook_name: 'del-sched-pb',
        cron_expression: '0 9 * * *',
      });
      const sched = JSON.parse(schedRes.content[0].text);

      await callTool(mcp, auth, 'delete_schedule', {
        agent_id: 'test-agent',
        id: sched.id,
      });
      const rows = await getAuditRows(db);
      const delRow = rows.find((r) => r.action === 'schedule.delete');
      expect(delRow).toBeDefined();
    });

    it('save_artifact audits artifact.create', async () => {
      await callTool(mcp, auth, 'save_artifact', {
        agent_id: 'test-agent',
        key: 'test-artifact',
        content_type: 'text/plain',
        content: 'artifact content',
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('artifact.create');
      expect(rows[0].resource_type).toBe('artifact');
    });

    it('define_profile audits profile.create', async () => {
      await callTool(mcp, auth, 'define_profile', {
        agent_id: 'test-agent',
        name: 'test-profile',
        description: 'A test profile',
        system_prompt: 'You are a test agent.',
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('profile.create');
      expect(rows[0].resource_type).toBe('profile');
    });

    it('delete_profile audits profile.delete', async () => {
      // Create profile first
      await callTool(mcp, auth, 'define_profile', {
        agent_id: 'test-agent',
        name: 'delete-me',
        description: 'Will be deleted',
        system_prompt: 'Temporary.',
      });

      await callTool(mcp, auth, 'delete_profile', {
        agent_id: 'test-agent',
        name: 'delete-me',
      });
      const rows = await getAuditRows(db);
      const delRow = rows.find((r) => r.action === 'profile.delete');
      expect(delRow).toBeDefined();
    });

    it('define_inbound_endpoint audits inbound_endpoint.create', async () => {
      await callTool(mcp, auth, 'define_inbound_endpoint', {
        agent_id: 'test-agent',
        name: 'test-endpoint',
        action_type: 'broadcast_event',
        action_config: { event_type: 'BROADCAST' },
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('inbound_endpoint.create');
      expect(rows[0].resource_type).toBe('inbound_endpoint');
    });

    it('delete_inbound_endpoint audits inbound_endpoint.delete', async () => {
      const createRes = await callTool(mcp, auth, 'define_inbound_endpoint', {
        agent_id: 'test-agent',
        name: 'del-endpoint',
        action_type: 'broadcast_event',
        action_config: { event_type: 'BROADCAST' },
      });
      const ep = JSON.parse(createRes.content[0].text);

      await callTool(mcp, auth, 'delete_inbound_endpoint', {
        agent_id: 'test-agent',
        endpoint_id: ep.id,
      });
      const rows = await getAuditRows(db);
      const delRow = rows.find((r) => r.action === 'inbound_endpoint.delete');
      expect(delRow).toBeDefined();
    });
  });

  // ─── Mutating tools increment api_call_count ──────────────────────

  describe('mutating tools increment api_call_count', () => {
    it('save_context increments api_call_count', async () => {
      await callTool(mcp, auth, 'save_context', {
        agent_id: 'test-agent',
        key: 'usage-key',
        value: 'usage-value',
        tags: [],
      });
      const usage = await getUsage(db, 'test-team');
      expect(usage.apiCallCount).toBe(1);
    });

    it('create_task increments api_call_count', async () => {
      await callTool(mcp, auth, 'create_task', {
        agent_id: 'test-agent',
        description: 'Count me',
      });
      const usage = await getUsage(db, 'test-team');
      expect(usage.apiCallCount).toBe(1);
    });

    it('multiple mutating calls accumulate api_call_count', async () => {
      await callTool(mcp, auth, 'save_context', {
        agent_id: 'test-agent',
        key: 'k1',
        value: 'v1',
        tags: [],
      });
      await callTool(mcp, auth, 'broadcast', {
        agent_id: 'test-agent',
        event_type: 'BROADCAST',
        message: 'msg',
        tags: [],
      });
      await callTool(mcp, auth, 'create_task', {
        agent_id: 'test-agent',
        description: 'Task',
      });
      const usage = await getUsage(db, 'test-team');
      expect(usage.apiCallCount).toBe(3);
    });
  });

  // ─── Read-only tools do NOT produce audit entries ─────────────────

  describe('read-only tools do NOT produce audit entries or increment counters', () => {
    it('get_context does not audit', async () => {
      await callTool(mcp, auth, 'get_context', { query: 'test' });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
      const usage = await getUsage(db, 'test-team');
      expect(usage.apiCallCount).toBe(0);
    });

    it('get_updates does not audit', async () => {
      await callTool(mcp, auth, 'get_updates', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('list_tasks does not audit', async () => {
      await callTool(mcp, auth, 'list_tasks', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('get_task does not audit (on valid task)', async () => {
      // Create a task first (produces 1 audit entry)
      const createRes = await callTool(mcp, auth, 'create_task', {
        agent_id: 'test-agent',
        description: 'Read me',
      });
      const created = JSON.parse(createRes.content[0].text);

      // Clear audit table to isolate get_task
      db.rawDb.prepare('DELETE FROM audit_log').run();

      await callTool(mcp, auth, 'get_task', { task_id: created.task_id });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('get_task_graph does not audit', async () => {
      await callTool(mcp, auth, 'get_task_graph', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('list_agents does not audit', async () => {
      await callTool(mcp, auth, 'list_agents', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('heartbeat does not audit', async () => {
      await callTool(mcp, auth, 'heartbeat', {
        agent_id: 'test-agent',
      });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('get_messages does not audit', async () => {
      await callTool(mcp, auth, 'get_messages', { agent_id: 'test-agent' });
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('list_playbooks does not audit', async () => {
      await callTool(mcp, auth, 'list_playbooks', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('list_schedules does not audit', async () => {
      await callTool(mcp, auth, 'list_schedules', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('list_workflow_runs does not audit', async () => {
      await callTool(mcp, auth, 'list_workflow_runs', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('list_artifacts does not audit', async () => {
      await callTool(mcp, auth, 'list_artifacts', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('get_analytics does not audit', async () => {
      await callTool(mcp, auth, 'get_analytics', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('list_profiles does not audit', async () => {
      await callTool(mcp, auth, 'list_profiles', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('list_inbound_endpoints does not audit', async () => {
      await callTool(mcp, auth, 'list_inbound_endpoints', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });

    it('export_workspace_data does not audit', async () => {
      await callTool(mcp, auth, 'export_workspace_data', {});
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });
  });

  // ─── Error paths don't audit ──────────────────────────────────────

  describe('error paths do not produce audit entries', () => {
    it('secret scan blocks save_context — no audit', async () => {
      const result = await callTool(mcp, auth, 'save_context', {
        agent_id: 'test-agent',
        key: 'bad-key',
        value: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        tags: [],
      });
      expect(result.isError).toBe(true);
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
      const usage = await getUsage(db, 'test-team');
      expect(usage.apiCallCount).toBe(0);
    });

    it('secret scan blocks broadcast — no audit', async () => {
      const result = await callTool(mcp, auth, 'broadcast', {
        agent_id: 'test-agent',
        event_type: 'BROADCAST',
        message: 'password=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        tags: [],
      });
      expect(result.isError).toBe(true);
      const rows = await getAuditRows(db);
      expect(rows).toHaveLength(0);
    });
  });

  // ─── Audit metadata correctness ───────────────────────────────────

  describe('audit metadata correctness', () => {
    it('records IP from auth context', async () => {
      await callTool(mcp, auth, 'create_task', {
        agent_id: 'test-agent',
        description: 'IP test',
      });
      const rows = await getAuditRows(db);
      expect(rows[0].ip).toBe('127.0.0.1');
    });

    it('records request ID from auth context', async () => {
      await callTool(mcp, auth, 'create_task', {
        agent_id: 'test-agent',
        description: 'ReqID test',
      });
      const rows = await getAuditRows(db);
      expect(rows[0].request_id).toBe('req-test-1');
    });

    it('uses agent_id from tool params, not header', async () => {
      await callTool(mcp, auth, 'save_context', {
        agent_id: 'param-agent',
        key: 'actor-test',
        value: 'testing actor override',
        tags: [],
      });
      const rows = await getAuditRows(db);
      expect(rows[0].actor).toBe('param-agent');
    });
  });
});
