/**
 * Tests for: model-layer secret scanning (REST + model) and body-limit stream validation
 * - createTask secret scanning at model layer and REST route (422 SECRET_DETECTED)
 * - definePlaybook secret scanning at model layer and REST route
 * - defineProfile secret scanning at model layer and REST route
 * - Body-limit stream validation (Content-Length reject, within-limit allow, GET skip, disabled when 0)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, addApiKey, type TestContext } from './helpers.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import { definePlaybook } from '../src/models/playbook.js';
import { defineProfile } from '../src/models/profile.js';
import { saveArtifact } from '../src/models/artifact.js';
import { defineInboundEndpoint } from '../src/models/inbound.js';
import { createTask } from '../src/models/task.js';
import { saveContext } from '../src/models/context.js';
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

// ─── P1: MCP direct protocol tests for remaining read tools ────────────

describe('P1 — MCP direct tests: get_task_graph', () => {
  it('should return empty graph for empty workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_task_graph', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.nodes).toEqual([]);
    expect(data.edges).toEqual([]);
  });

  it('should return nodes and edges for tasks with dependencies', async () => {
    const { db, mcp, auth } = createMcpTestCtx('write');
    const t1 = await createTask(db, 'test-team', 'test-agent', {
      description: 'parent task', status: 'open',
    });
    const t2 = await createTask(db, 'test-team', 'test-agent', {
      description: 'child task', status: 'open', depends_on: [t1.task_id],
    });

    // Use read scope for the query
    const readAuth: AuthContext = { ...auth, scope: 'read' };
    const res = await callTool(mcp, readAuth, 'get_task_graph', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.nodes.length).toBe(2);
    expect(data.edges.length).toBe(1);
    expect(data.edges[0].from).toBe(t1.task_id);
    expect(data.edges[0].to).toBe(t2.task_id);
  });
});

describe('P1 — MCP direct tests: get_analytics', () => {
  it('should return analytics for empty workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_analytics', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data).toHaveProperty('tasks');
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('agents');
  });

  it('should accept since parameter', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_analytics', { since: '7d' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data).toHaveProperty('tasks');
  });
});

describe('P1 — MCP direct tests: list_profiles / get_profile', () => {
  it('list_profiles should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'list_profiles', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.profiles).toEqual([]);
  });

  it('list_profiles should return defined profiles', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await defineProfile(db, 'test-team', 'test-agent', {
      name: 'researcher',
      description: 'Research role',
      system_prompt: 'You are a researcher.',
    });

    const res = await callTool(mcp, auth, 'list_profiles', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.profiles.length).toBe(1);
    expect(data.profiles[0].name).toBe('researcher');
  });

  it('get_profile should return a specific profile', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await defineProfile(db, 'test-team', 'test-agent', {
      name: 'engineer',
      description: 'Eng role',
      system_prompt: 'You write code.',
    });

    const res = await callTool(mcp, auth, 'get_profile', { name: 'engineer' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.name).toBe('engineer');
    expect(data.systemPrompt).toBe('You write code.');
  });

  it('get_profile should return error for non-existent profile', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_profile', { name: 'nonexistent' });
    expect(res.isError).toBe(true);
  });
});

describe('P1 — MCP direct tests: list_inbound_endpoints', () => {
  it('should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'list_inbound_endpoints', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.endpoints).toEqual([]);
  });

  it('should return defined endpoints', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await defineInboundEndpoint(db, 'test-team', 'test-agent', {
      name: 'github-webhook',
      action_type: 'create_task',
      action_config: { description_template: 'Issue: {{body.title}}' },
    });

    const res = await callTool(mcp, auth, 'list_inbound_endpoints', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.endpoints.length).toBe(1);
    expect(data.endpoints[0].name).toBe('github-webhook');
  });
});

describe('P1 — MCP direct tests: list_playbooks', () => {
  it('should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'list_playbooks', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.playbooks).toEqual([]);
  });

  it('should return defined playbooks', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await definePlaybook(db, 'test-team', 'test-agent', {
      name: 'deploy-pipeline',
      description: 'Deploy steps',
      tasks: [{ description: 'Build' }, { description: 'Test', depends_on_index: [0] }],
    });

    const res = await callTool(mcp, auth, 'list_playbooks', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.playbooks.length).toBe(1);
    expect(data.playbooks[0].name).toBe('deploy-pipeline');
  });
});

describe('P1 — MCP direct tests: list_artifacts / get_artifact', () => {
  it('list_artifacts should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'list_artifacts', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.artifacts).toEqual([]);
  });

  it('list_artifacts should return saved artifacts', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await saveArtifact(db, 'test-team', 'test-agent', {
      key: 'report-v1',
      content: '# Report',
      content_type: 'text/markdown',
    });

    const res = await callTool(mcp, auth, 'list_artifacts', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.artifacts.length).toBe(1);
    expect(data.artifacts[0].key).toBe('report-v1');
  });

  it('get_artifact should return artifact with content', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await saveArtifact(db, 'test-team', 'test-agent', {
      key: 'data-file',
      content: '{"result": 42}',
      content_type: 'application/json',
    });

    const res = await callTool(mcp, auth, 'get_artifact', { key: 'data-file' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.key).toBe('data-file');
    expect(data.content).toBe('{"result": 42}');
  });

  it('get_artifact should return error for non-existent key', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_artifact', { key: 'ghost' });
    expect(res.isError).toBe(true);
  });
});

describe('P1 — MCP direct tests: list_schedules', () => {
  it('should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'list_schedules', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.schedules).toEqual([]);
  });
});

describe('P1 — MCP direct tests: list_workflow_runs / get_workflow_run', () => {
  it('list_workflow_runs should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'list_workflow_runs', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.workflow_runs).toEqual([]);
  });

  it('get_workflow_run should return error for non-existent run', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callTool(mcp, auth, 'get_workflow_run', { id: 99999 });
    expect(res.isError).toBe(true);
  });
});

