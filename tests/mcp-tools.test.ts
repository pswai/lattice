import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, addApiKey, authHeaders, request, type TestContext } from './helpers.js';
import { autoRegisterAgent, registerAgent } from '../src/models/agent.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import { createTask } from '../src/models/task.js';
import { saveContext } from '../src/models/context.js';
import { sendMessage } from '../src/models/message.js';
import { definePlaybook } from '../src/models/playbook.js';
import { defineProfile } from '../src/models/profile.js';
import { saveArtifact } from '../src/models/artifact.js';
import { defineInboundEndpoint } from '../src/models/inbound.js';
import type { SqliteAdapter } from '../src/db/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../src/models/types.js';

describe('MCP Tools — list_tasks & get_task', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  // Helper to create a task via HTTP (shared model layer with MCP)
  async function createTask(description: string, opts: { status?: string; agentId?: string } = {}) {
    const headers = authHeaders(ctx.apiKey, opts.agentId);
    const body: Record<string, unknown> = { description };
    if (opts.status) body.status = opts.status;
    const res = await request(ctx.app, 'POST', '/api/v1/tasks', { headers, body });
    return res.json();
  }

  describe('GET /api/v1/tasks — list_tasks', () => {
    it('should return empty list when no tasks exist', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('should list all tasks for the team', async () => {
      await createTask('Task A');
      await createTask('Task B');
      await createTask('Task C');

      const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toHaveLength(3);
      expect(data.total).toBe(3);
    });

    it('should filter by status', async () => {
      await createTask('Claimed task');
      await createTask('Open task', { status: 'open' });

      const res = await request(ctx.app, 'GET', '/api/v1/tasks?status=open', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].description).toBe('Open task');
      expect(data.tasks[0].status).toBe('open');
    });

    it('should filter by claimed_by', async () => {
      await createTask('Agent A task', { agentId: 'agent-a' });
      await createTask('Agent B task', { agentId: 'agent-b' });

      const res = await request(ctx.app, 'GET', '/api/v1/tasks?claimed_by=agent-a', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].description).toBe('Agent A task');
    });

    it('should respect limit parameter', async () => {
      await createTask('Task 1');
      await createTask('Task 2');
      await createTask('Task 3');

      const res = await request(ctx.app, 'GET', '/api/v1/tasks?limit=2', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.tasks).toHaveLength(2);
    });
  });

  describe('GET /api/v1/tasks/:id — get_task', () => {
    it('should return a single task by ID', async () => {
      const created = await createTask('Specific task');

      const res = await request(ctx.app, 'GET', `/api/v1/tasks/${created.task_id}`, {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const task = await res.json();
      expect(task.id).toBe(created.task_id);
      expect(task.description).toBe('Specific task');
      expect(task.status).toBe('claimed');
      expect(task.version).toBe(1);
    });

    it('should return 404 for non-existent task', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/tasks/9999', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(404);
    });
  });
});

describe('Auto-registration', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should auto-register an unknown agent on first MCP tool call', async () => {
    // Directly test the autoRegisterAgent helper
    await autoRegisterAgent(ctx.db, ctx.workspaceId, 'new-agent');

    const row = ctx.rawDb.prepare(
      'SELECT * FROM agents WHERE workspace_id = ? AND id = ?',
    ).get(ctx.workspaceId, 'new-agent') as any;

    expect(row).toBeDefined();
    expect(row.id).toBe('new-agent');
    expect(row.status).toBe('online');
    expect(JSON.parse(row.capabilities)).toEqual([]);
  });

  it('should update last_heartbeat for an already-registered agent', async () => {
    // First register with capabilities
    ctx.rawDb.prepare(`
      INSERT INTO agents (id, workspace_id, capabilities, status, metadata, last_heartbeat)
      VALUES (?, ?, '["python"]', 'busy', '{}', '2020-01-01T00:00:00.000Z')
    `).run('existing-agent', ctx.workspaceId);

    await autoRegisterAgent(ctx.db, ctx.workspaceId, 'existing-agent');

    const row = ctx.rawDb.prepare(
      'SELECT * FROM agents WHERE workspace_id = ? AND id = ?',
    ).get(ctx.workspaceId, 'existing-agent') as any;

    // Should NOT overwrite capabilities or status — only update heartbeat
    expect(JSON.parse(row.capabilities)).toEqual(['python']);
    expect(row.status).toBe('busy');
    expect(row.last_heartbeat).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('should be idempotent — calling multiple times does not error', async () => {
    await autoRegisterAgent(ctx.db, ctx.workspaceId, 'repeat-agent');
    await autoRegisterAgent(ctx.db, ctx.workspaceId, 'repeat-agent');
    await autoRegisterAgent(ctx.db, ctx.workspaceId, 'repeat-agent');

    const rows = ctx.rawDb.prepare(
      'SELECT * FROM agents WHERE workspace_id = ? AND id = ?',
    ).all(ctx.workspaceId, 'repeat-agent');

    expect(rows).toHaveLength(1);
  });
});

// ─── MCP helpers ──────────────────────────────────────────────────────

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

async function callMcpTool(
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

// ─── MCP task/playbook/profile secret scanning (from round4-fixes) ────

describe('MCP create_task/update_task secret scanning', () => {
  let db: SqliteAdapter;
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx('write');
    db = ctx.db;
    mcp = ctx.mcp;
    auth = ctx.auth;
  });

  it('should reject create_task with API key in description', async () => {
    const result = await callMcpTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'Deploy with key AKIAIOSFODNN7EXAMPLE',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/secret/i);
  });

  it('should reject create_task with Stripe key in description', async () => {
    const result = await callMcpTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'Use key sk_live_1234567890abcdefghijklmn',
    });
    expect(result.isError).toBe(true);
  });

  it('should allow create_task with clean description', async () => {
    const result = await callMcpTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'A perfectly normal task',
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.task_id).toBeGreaterThan(0);
  });

  it('should reject update_task with secret in result', async () => {
    const createRes = await callMcpTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'Normal task',
    });
    const taskId = JSON.parse(createRes.content[0].text).task_id;

    const result = await callMcpTool(mcp, auth, 'update_task', {
      agent_id: 'test-agent',
      task_id: taskId,
      status: 'completed',
      version: 1,
      result: 'Found password: password=SuperSecret123! in config',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/secret/i);
  });

  it('should allow update_task with clean result', async () => {
    const createRes = await callMcpTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'Normal task',
    });
    const taskId = JSON.parse(createRes.content[0].text).task_id;

    const result = await callMcpTool(mcp, auth, 'update_task', {
      agent_id: 'test-agent',
      task_id: taskId,
      status: 'completed',
      version: 1,
      result: 'Completed successfully',
    });
    expect(result.isError).toBeUndefined();
  });
});

describe('MCP define_playbook task template secret scanning', () => {
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx('write');
    mcp = ctx.mcp;
    auth = ctx.auth;
  });

  it('should reject playbook with secret in task description', async () => {
    const result = await callMcpTool(mcp, auth, 'define_playbook', {
      agent_id: 'test-agent',
      name: 'bad-pb',
      description: 'Test playbook',
      tasks: [{ description: 'Use key AKIAIOSFODNN7EXAMPLE to deploy' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/secret/i);
  });

  it('should reject playbook with secret in description field', async () => {
    const result = await callMcpTool(mcp, auth, 'define_playbook', {
      agent_id: 'test-agent',
      name: 'bad-pb-2',
      description: 'Playbook for deploying with sk_live_1234567890abcdefghijklmn',
      tasks: [{ description: 'Deploy step' }],
    });
    expect(result.isError).toBe(true);
  });

  it('should allow playbook with clean content', async () => {
    const result = await callMcpTool(mcp, auth, 'define_playbook', {
      agent_id: 'test-agent',
      name: 'good-pb',
      description: 'A safe playbook',
      tasks: [{ description: 'Step 1: deploy' }, { description: 'Step 2: test', depends_on_index: [0] }],
    });
    expect(result.isError).toBeUndefined();
  });
});

describe('MCP define_profile secret scanning', () => {
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx('write');
    mcp = ctx.mcp;
    auth = ctx.auth;
  });

  it('should reject profile with secret in system_prompt', async () => {
    const result = await callMcpTool(mcp, auth, 'define_profile', {
      agent_id: 'test-agent',
      name: 'bad-profile',
      description: 'Profile with leaked key',
      system_prompt: 'You are an agent. Use api_key=SuperSecretKey12345678 for auth.',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/secret/i);
  });

  it('should reject profile with secret in description', async () => {
    const result = await callMcpTool(mcp, auth, 'define_profile', {
      agent_id: 'test-agent',
      name: 'bad-profile-2',
      description: 'Access with AKIAIOSFODNN7EXAMPLE',
      system_prompt: 'You are a safe agent.',
    });
    expect(result.isError).toBe(true);
  });

  it('should allow profile with clean content', async () => {
    const result = await callMcpTool(mcp, auth, 'define_profile', {
      agent_id: 'test-agent',
      name: 'good-profile',
      description: 'A researcher agent',
      system_prompt: 'You are a helpful research agent.',
    });
    expect(result.isError).toBeUndefined();
  });
});

// ─── MCP run_playbook vars scanned for secrets (from round3-fixes) ────

describe('MCP run_playbook vars scanned for secrets', () => {
  let db: SqliteAdapter;
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx('write');
    db = ctx.db;
    mcp = ctx.mcp;
    auth = ctx.auth;

    db.rawDb.prepare(`
      INSERT INTO playbooks (workspace_id, name, description, tasks_json, created_by)
      VALUES ('test-team', 'var-pb', 'Test', ?, 'agent')
    `).run(JSON.stringify([{ description: 'Deploy {{vars.env}}' }]));
  });

  it('should reject vars containing an AWS key', async () => {
    const result = await callMcpTool(mcp, auth, 'run_playbook', {
      agent_id: 'test-agent',
      name: 'var-pb',
      vars: { env: 'AKIAIOSFODNN7EXAMPLE' },
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/secret/i);
  });

  it('should reject vars containing a GitHub PAT', async () => {
    const result = await callMcpTool(mcp, auth, 'run_playbook', {
      agent_id: 'test-agent',
      name: 'var-pb',
      vars: { token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
    });

    expect(result.isError).toBe(true);
  });

  it('should allow clean vars through', async () => {
    const result = await callMcpTool(mcp, auth, 'run_playbook', {
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

// ─── MCP read tool direct tests (from round5-coverage-gaps & round6-coverage-gaps) ─

describe('MCP direct tests: get_task_graph', () => {
  it('should return empty graph for empty workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_task_graph', {});
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

    const readAuth: AuthContext = { ...auth, scope: 'read' };
    const res = await callMcpTool(mcp, readAuth, 'get_task_graph', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.nodes.length).toBe(2);
    expect(data.edges.length).toBe(1);
    expect(data.edges[0].from).toBe(t1.task_id);
    expect(data.edges[0].to).toBe(t2.task_id);
  });
});

describe('MCP direct tests: get_analytics', () => {
  it('should return analytics for empty workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_analytics', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data).toHaveProperty('tasks');
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('agents');
  });

  it('should accept since parameter', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_analytics', { since: '7d' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data).toHaveProperty('tasks');
  });
});

describe('MCP direct tests: list_profiles / get_profile', () => {
  it('list_profiles should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'list_profiles', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.profiles).toEqual([]);
  });

  it('list_profiles should return defined profiles', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await defineProfile(db, 'test-team', 'test-agent', {
      name: 'researcher', description: 'Research role', system_prompt: 'You are a researcher.',
    });
    const res = await callMcpTool(mcp, auth, 'list_profiles', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.profiles.length).toBe(1);
    expect(data.profiles[0].name).toBe('researcher');
  });

  it('get_profile should return a specific profile', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await defineProfile(db, 'test-team', 'test-agent', {
      name: 'engineer', description: 'Eng role', system_prompt: 'You write code.',
    });
    const res = await callMcpTool(mcp, auth, 'get_profile', { name: 'engineer' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.name).toBe('engineer');
    expect(data.systemPrompt).toBe('You write code.');
  });

  it('get_profile should return error for non-existent profile', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_profile', { name: 'nonexistent' });
    expect(res.isError).toBe(true);
  });
});

describe('MCP direct tests: list_inbound_endpoints', () => {
  it('should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'list_inbound_endpoints', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.endpoints).toEqual([]);
  });

  it('should return defined endpoints', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await defineInboundEndpoint(db, 'test-team', 'test-agent', {
      name: 'github-webhook', action_type: 'create_task',
      action_config: { description_template: 'Issue: {{body.title}}' },
    });
    const res = await callMcpTool(mcp, auth, 'list_inbound_endpoints', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.endpoints.length).toBe(1);
    expect(data.endpoints[0].name).toBe('github-webhook');
  });
});

describe('MCP direct tests: list_playbooks', () => {
  it('should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'list_playbooks', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.playbooks).toEqual([]);
  });

  it('should return defined playbooks', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await definePlaybook(db, 'test-team', 'test-agent', {
      name: 'deploy-pipeline', description: 'Deploy steps',
      tasks: [{ description: 'Build' }, { description: 'Test', depends_on_index: [0] }],
    });
    const res = await callMcpTool(mcp, auth, 'list_playbooks', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.playbooks.length).toBe(1);
    expect(data.playbooks[0].name).toBe('deploy-pipeline');
  });
});

describe('MCP direct tests: list_artifacts / get_artifact', () => {
  it('list_artifacts should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'list_artifacts', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.artifacts).toEqual([]);
  });

  it('list_artifacts should return saved artifacts', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await saveArtifact(db, 'test-team', 'test-agent', {
      key: 'report-v1', content: '# Report', content_type: 'text/markdown',
    });
    const res = await callMcpTool(mcp, auth, 'list_artifacts', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.artifacts.length).toBe(1);
    expect(data.artifacts[0].key).toBe('report-v1');
  });

  it('get_artifact should return artifact with content', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await saveArtifact(db, 'test-team', 'test-agent', {
      key: 'data-file', content: '{"result": 42}', content_type: 'application/json',
    });
    const res = await callMcpTool(mcp, auth, 'get_artifact', { key: 'data-file' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.key).toBe('data-file');
    expect(data.content).toBe('{"result": 42}');
  });

  it('get_artifact should return error for non-existent key', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_artifact', { key: 'ghost' });
    expect(res.isError).toBe(true);
  });
});

describe('MCP direct tests: list_schedules', () => {
  it('should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'list_schedules', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.schedules).toEqual([]);
  });
});

describe('MCP direct tests: list_workflow_runs / get_workflow_run', () => {
  it('list_workflow_runs should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'list_workflow_runs', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.workflow_runs).toEqual([]);
  });

  it('get_workflow_run should return error for non-existent run', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_workflow_run', { id: 99999 });
    expect(res.isError).toBe(true);
  });
});

describe('MCP read tool direct tests (context, tasks, agents, messages)', () => {
  it('get_context should return empty results for empty workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_context', { query: 'anything' });
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
    const res = await callMcpTool(mcp, auth, 'get_context', { query: 'hello' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.entries.length).toBe(1);
    expect(data.entries[0].key).toBe('mcp-read-test');
  });

  it('list_tasks should return empty array for empty workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'list_tasks', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.tasks).toEqual([]);
  });

  it('list_tasks should return created tasks', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await createTask(db, 'test-team', 'test-agent', {
      description: 'task for MCP read test', status: 'open',
    });
    const res = await callMcpTool(mcp, auth, 'list_tasks', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.tasks.length).toBe(1);
    expect(data.tasks[0].description).toBe('task for MCP read test');
  });

  it('get_task should return a specific task by ID', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    const task = await createTask(db, 'test-team', 'test-agent', {
      description: 'specific task', status: 'open',
    });
    const res = await callMcpTool(mcp, auth, 'get_task', { task_id: task.task_id });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.id).toBe(task.task_id);
    expect(data.description).toBe('specific task');
  });

  it('get_task should return error for non-existent task', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_task', { task_id: 99999 });
    expect(res.isError).toBe(true);
  });

  it('list_agents should return empty for fresh workspace', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'list_agents', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.agents).toEqual([]);
  });

  it('list_agents should return registered agents', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await registerAgent(db, 'test-team', {
      agent_id: 'reader-bot', capabilities: ['search'], status: 'online',
    });
    const res = await callMcpTool(mcp, auth, 'list_agents', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.agents.length).toBeGreaterThanOrEqual(1);
    const agent = data.agents.find((a: any) => a.id === 'reader-bot');
    expect(agent).toBeDefined();
  });

  it('get_messages should return empty when no messages', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_messages', { agent_id: 'test-agent' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.messages).toEqual([]);
  });

  it('get_messages should return sent messages', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await sendMessage(db, 'test-team', 'sender', {
      to: 'test-agent', message: 'hello from MCP test', tags: [],
    });
    const res = await callMcpTool(mcp, auth, 'get_messages', { agent_id: 'test-agent' });
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].message).toBe('hello from MCP test');
  });

  it('get_updates should return events', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const res = await callMcpTool(mcp, auth, 'get_updates', {});
    expect(res.isError).toBeFalsy();
    const data = parseToolResult(res);
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('cursor');
  });

  it('list_tasks should filter by status', async () => {
    const { db, mcp, auth } = createMcpTestCtx('read');
    await createTask(db, 'test-team', 'test-agent', { description: 'open task', status: 'open' });
    await createTask(db, 'test-team', 'test-agent', { description: 'completed task', status: 'completed' });
    const res = await callMcpTool(mcp, auth, 'list_tasks', { status: 'open' });
    const data = parseToolResult(res);
    expect(data.tasks.length).toBe(1);
    expect(data.tasks[0].description).toBe('open task');
  });
});
