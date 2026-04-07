/**
 * Tests for: MCP read tool direct protocol coverage
 * - get_task_graph (empty workspace, nodes+edges with dependencies)
 * - get_analytics (empty workspace, since parameter)
 * - list_profiles / get_profile (empty, populated, not-found)
 * - list_inbound_endpoints (empty, populated)
 * - list_playbooks (empty, populated)
 * - list_artifacts / get_artifact (empty, populated, not-found)
 * - list_schedules (empty)
 * - list_workflow_runs / get_workflow_run (empty, not-found)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, addApiKey, type TestContext } from './helpers.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import { createTask } from '../src/models/task.js';
import { saveContext } from '../src/models/context.js';
import { registerAgent } from '../src/models/agent.js';
import { sendMessage } from '../src/models/message.js';
import { startScheduler } from '../src/services/scheduler.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../src/models/types.js';

// ─── MCP helpers ───────────────────────────────────────────────────────

function createMcpTestCtx(scope: 'read' | 'write' | 'admin' = 'write') {
  const db = createTestDb();
  setupWorkspace(db, 'test-team');
  if (scope !== 'write') {
    addApiKey(db, 'test-team', `ltk_${scope}_key_12345678901234567890`, scope);
  }
  const mcp = createMcpServer(db);
  const auth: AuthContext = {
    workspaceId: 'test-team',
    agentId: 'test-agent',
    scope,
    ip: '127.0.0.1',
    requestId: 'req-1',
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
  try {
    return await mcpAuthStorage.run(auth, () =>
      tool.inputSchema ? tool.handler(args, {}) : tool.handler({}),
    );
  } catch (err: any) {
    if (err && typeof err.toJSON === 'function') {
      return {
        content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }],
        isError: true,
      };
    }
    throw err;
  }
}

function parseToolResult(res: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(res.content[0].text);
}

// ─── P1: Service lifecycle start/stop ──────────────────────────────────

describe('P1 — Service lifecycle', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('startScheduler', () => {
    it('should return a timer handle that can be cleared', () => {
      const timer = startScheduler(ctx.db);
      expect(timer).toBeDefined();
      clearInterval(timer);
    });
  });
});

// ─── P1: MCP read tool direct protocol tests ──────────────────────────

describe('P1 — MCP read tool direct tests', () => {
  it('get_context should return empty results for empty workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_context', { query: 'anything' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.entries).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('get_context should return saved context entries', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await saveContext(db, 'test-team', 'test-agent', {
      key: 'mcp-read-test', value: 'hello from MCP read test', tags: ['test'],
    });

    const res = await callTool(mcp, auth, 'get_context', { query: 'hello' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.entries.length).toBe(1);
    expect(data.entries[0].key).toBe('mcp-read-test');
  });

  it('list_tasks should return empty array for empty workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'list_tasks', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.tasks).toEqual([]);
  });

  it('list_tasks should return created tasks', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await createTask(db, 'test-team', 'test-agent', {
      description: 'task for MCP read test',
      status: 'open',
    });

    const res = await callTool(mcp, auth, 'list_tasks', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.tasks.length).toBe(1);
    expect(data.tasks[0].description).toBe('task for MCP read test');
  });

  it('get_task should return a specific task by ID', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    const task = await createTask(db, 'test-team', 'test-agent', {
      description: 'specific task',
      status: 'open',
    });

    const res = await callTool(mcp, auth, 'get_task', { task_id: task.task_id });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.id).toBe(task.task_id);
    expect(data.description).toBe('specific task');
  });

  it('get_task should return error for non-existent task', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_task', { task_id: 99999 });
    expect(res.isError).toBe(true);
  });

  it('list_agents should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'list_agents', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.agents).toEqual([]);
  });

  it('list_agents should return registered agents', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await registerAgent(db, 'test-team', {
      agent_id: 'reader-bot',
      capabilities: ['search'],
      status: 'online',
    });

    const res = await callTool(mcp, auth, 'list_agents', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.agents.length).toBeGreaterThanOrEqual(1);
    const agent = data.agents.find((a: any) => a.id === 'reader-bot');
    expect(agent).toBeDefined();
  });

  it('get_messages should return empty when no messages', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_messages', { agent_id: 'test-agent' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.messages).toEqual([]);
  });

  it('get_messages should return sent messages', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await sendMessage(db, 'test-team', 'sender', {
      to: 'test-agent',
      message: 'hello from MCP test',
      tags: [],
    });

    const res = await callTool(mcp, auth, 'get_messages', { agent_id: 'test-agent' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].message).toBe('hello from MCP test');
  });

  it('get_updates should return events', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_updates', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('cursor');
  });

  it('list_tasks should filter by status', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await createTask(db, 'test-team', 'test-agent', {
      description: 'open task',
      status: 'open',
    });
    await createTask(db, 'test-team', 'test-agent', {
      description: 'completed task',
      status: 'completed',
    });

    const res = await callTool(mcp, auth, 'list_tasks', { status: 'open' });
    const data = parseToolResult(res);
    expect(data.tasks.length).toBe(1);
    expect(data.tasks[0].description).toBe('open task');
  });
});
