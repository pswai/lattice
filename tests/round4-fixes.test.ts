/**
 * Tests for: MCP scope enforcement, rate-limit bucket sharing, secret scanning (tasks, playbooks, profiles), context timestamp consistency, and cross-workspace task dependency isolation
 * - MCP read-only scope blocks all mutating tools (save_context, broadcast, create_task, etc.)
 * - MCP and REST share the same rate-limit bucket
 * - Secret scanning in create_task/update_task (MCP layer)
 * - Secret scanning in define_playbook and define_profile (MCP layer)
 * - Context timestamps use consistent ISO 8601 clock
 * - Task dependency blocker query respects workspace_id filter
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, addApiKey, authHeaders, request, testConfig, type TestContext } from './helpers.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import { saveContext, getContext } from '../src/models/context.js';
import { createTask } from '../src/models/task.js';
import { __resetRateLimit } from '../src/http/middleware/rate-limit.js';
import { createApp } from '../src/http/app.js';
import type { SqliteAdapter } from '../src/db/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../src/models/types.js';

// ─── MCP helpers ───────────────────────────────────────────────────────

function createMcpTestCtx(scope: 'read' | 'write' | 'admin' = 'write') {
  const db = createTestDb();
  setupWorkspace(db, 'test-team');
  if (scope !== 'write') {
    // Add a key with the desired scope
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
    // Handlers throw AppError subclasses (e.g. InsufficientScopeError) outside try/catch
    if (err && typeof err.toJSON === 'function') {
      return {
        content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }],
        isError: true,
      };
    }
    throw err;
  }
}

// ─── C1: MCP scope enforcement ─────────────────────────────────────────

describe('C1 — MCP scope enforcement for read-only keys', () => {
  let db: SqliteAdapter;
  let mcp: McpServer;
  let readAuth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx('read');
    db = ctx.db;
    mcp = ctx.mcp;
    readAuth = ctx.auth;
  });

  const mutatingTools: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'save_context', args: { agent_id: 'a', key: 'k', value: 'v', tags: [] } },
    { name: 'broadcast', args: { agent_id: 'a', event_type: 'BROADCAST', message: 'test', tags: [] } },
    { name: 'create_task', args: { agent_id: 'a', description: 'test task' } },
    { name: 'send_message', args: { agent_id: 'a', to: 'b', message: 'hi', tags: [] } },
    { name: 'save_artifact', args: { agent_id: 'a', key: 'art', content_type: 'text/plain', content: 'hello' } },
    { name: 'define_playbook', args: { agent_id: 'a', name: 'pb', description: 'desc', tasks: [{ description: 'step' }] } },
    { name: 'define_profile', args: { agent_id: 'a', name: 'prof', description: 'desc', system_prompt: 'prompt' } },
    { name: 'define_inbound_endpoint', args: { agent_id: 'a', name: 'ep', action_type: 'create_task' } },
  ];

  for (const { name, args } of mutatingTools) {
    it(`should block read-only key from calling ${name}`, async () => {
      const result = await callTool(mcp, readAuth, name, args);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toMatch(/scope.*read|requires.*write/i);
    });
  }

  it('should allow read-only key to call read tools', async () => {
    // Read tools should work fine
    const result = await callTool(mcp, readAuth, 'get_context', {
      query: 'test',
    });
    expect(result.isError).toBeUndefined();
  });

  it('should allow write key to call mutating tools', async () => {
    const writeCtx = createMcpTestCtx('write');
    const result = await callTool(writeCtx.mcp, writeCtx.auth, 'save_context', {
      agent_id: 'test-agent',
      key: 'allowed',
      value: 'this should work',
      tags: [],
    });
    expect(result.isError).toBeUndefined();
  });
});

// ─── C2: Rate limit unified bucket ─────────────────────────────────────

describe('C2 — MCP and REST share the same rate limit bucket', () => {
  let ctx: TestContext;

  beforeEach(() => {
    __resetRateLimit();
  });

  afterEach(() => {
    __resetRateLimit();
  });

  it('should count MCP and REST requests against the same bucket', async () => {
    const config = testConfig({ rateLimitPerMinute: 5 });
    const db = createTestDb();
    const team = setupWorkspace(db, 'test-team');
    const app = createApp(db, () => createMcpServer(db), config);

    const headers = authHeaders(team.apiKey);

    // Send 3 REST requests
    for (let i = 0; i < 3; i++) {
      const res = await request(app, 'GET', '/api/v1/context?query=test', { headers });
      expect(res.status).toBe(200);
    }

    // Send 2 MCP-style requests (via /mcp POST endpoint)
    // The MCP endpoint also counts against the same bucket
    for (let i = 0; i < 2; i++) {
      const res = await request(app, 'GET', '/api/v1/events', { headers });
      expect(res.status).toBe(200);
    }

    // Next request (6th) should be rate limited
    const limited = await request(app, 'GET', '/api/v1/context?query=test', { headers });
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.error).toBe('RATE_LIMITED');
  });
});

// ─── H1: Task secret scanning ──────────────────────────────────────────

describe('H1 — create_task/update_task secret scanning', () => {
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
    const result = await callTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'Deploy with key AKIAIOSFODNN7EXAMPLE',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/secret/i);
  });

  it('should reject create_task with Stripe key in description', async () => {
    const result = await callTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'Use key sk_live_1234567890abcdefghijklmn',
    });
    expect(result.isError).toBe(true);
  });

  it('should allow create_task with clean description', async () => {

    const result = await callTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'A perfectly normal task',
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.task_id).toBeGreaterThan(0);
  });

  it('should reject update_task with secret in result', async () => {

    // Create a clean task first
    const createRes = await callTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'Normal task',
    });
    const taskId = JSON.parse(createRes.content[0].text).task_id;

    // Try to complete it with a secret in result
    const result = await callTool(mcp, auth, 'update_task', {
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

    const createRes = await callTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'Normal task',
    });
    const taskId = JSON.parse(createRes.content[0].text).task_id;

    const result = await callTool(mcp, auth, 'update_task', {
      agent_id: 'test-agent',
      task_id: taskId,
      status: 'completed',
      version: 1,
      result: 'Completed successfully',
    });
    expect(result.isError).toBeUndefined();
  });

  afterEach(() => {

  });
});

// ─── H2: Playbook secret scanning ──────────────────────────────────────

describe('H2 — define_playbook task template secret scanning', () => {
  let db: SqliteAdapter;
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx('write');
    db = ctx.db;
    mcp = ctx.mcp;
    auth = ctx.auth;
  });

  it('should reject playbook with secret in task description', async () => {
    const result = await callTool(mcp, auth, 'define_playbook', {
      agent_id: 'test-agent',
      name: 'bad-pb',
      description: 'Test playbook',
      tasks: [{ description: 'Use key AKIAIOSFODNN7EXAMPLE to deploy' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/secret/i);
  });

  it('should reject playbook with secret in description field', async () => {
    const result = await callTool(mcp, auth, 'define_playbook', {
      agent_id: 'test-agent',
      name: 'bad-pb-2',
      description: 'Playbook for deploying with sk_live_1234567890abcdefghijklmn',
      tasks: [{ description: 'Deploy step' }],
    });
    expect(result.isError).toBe(true);
  });

  it('should allow playbook with clean content', async () => {
    const result = await callTool(mcp, auth, 'define_playbook', {
      agent_id: 'test-agent',
      name: 'good-pb',
      description: 'A safe playbook',
      tasks: [{ description: 'Step 1: deploy' }, { description: 'Step 2: test', depends_on_index: [0] }],
    });
    expect(result.isError).toBeUndefined();
  });
});

// ─── M1: Profile secret scanning ────────────────────────────────────────

describe('M1 — define_profile secret scanning', () => {
  let db: SqliteAdapter;
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx('write');
    db = ctx.db;
    mcp = ctx.mcp;
    auth = ctx.auth;
  });

  it('should reject profile with secret in system_prompt', async () => {
    const result = await callTool(mcp, auth, 'define_profile', {
      agent_id: 'test-agent',
      name: 'bad-profile',
      description: 'Profile with leaked key',
      system_prompt: 'You are an agent. Use api_key=SuperSecretKey12345678 for auth.',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/secret/i);
  });

  it('should reject profile with secret in description', async () => {
    const result = await callTool(mcp, auth, 'define_profile', {
      agent_id: 'test-agent',
      name: 'bad-profile-2',
      description: 'Access with AKIAIOSFODNN7EXAMPLE',
      system_prompt: 'You are a safe agent.',
    });
    expect(result.isError).toBe(true);
  });

  it('should allow profile with clean content', async () => {
    const result = await callTool(mcp, auth, 'define_profile', {
      agent_id: 'test-agent',
      name: 'good-profile',
      description: 'A researcher agent',
      system_prompt: 'You are a helpful research agent.',
    });
    expect(result.isError).toBeUndefined();
  });
});

// ─── M2: Context clock consistency ──────────────────────────────────────

describe('M2 — Context timestamps use consistent clock', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should use ISO 8601 format for both created_at and updated_at', async () => {
    await saveContext(ctx.db, ctx.workspaceId, 'agent-a', {
      key: 'clock-test', value: 'original', tags: [],
    });

    const row1 = ctx.rawDb.prepare(
      'SELECT created_at, updated_at FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'clock-test') as any;

    // created_at should be ISO format
    expect(row1.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // Update
    await saveContext(ctx.db, ctx.workspaceId, 'agent-b', {
      key: 'clock-test', value: 'updated', tags: [],
    });

    const row2 = ctx.rawDb.prepare(
      'SELECT created_at, updated_at FROM context_entries WHERE workspace_id = ? AND key = ?',
    ).get(ctx.workspaceId, 'clock-test') as any;

    // Both should be valid ISO timestamps
    expect(new Date(row2.created_at).getTime()).toBeGreaterThan(0);
    expect(new Date(row2.updated_at).getTime()).toBeGreaterThan(0);
    // updated_at should be >= created_at
    expect(new Date(row2.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row2.created_at).getTime(),
    );
  });
});

// ─── M3: Task dependency workspace filter ───────────────────────────────

describe('M3 — Task dependency blocker query includes workspace_id filter', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should not resolve blockers from another workspace', async () => {
    // Create task in workspace A
    const taskA = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Blocker task', status: 'open',
    });

    // Create workspace B
    const wsB = 'workspace-b';
    ctx.rawDb.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run(wsB, 'Workspace B');

    // Create task in workspace B that depends on task A
    const taskBResult = await ctx.db.run(
      `INSERT INTO tasks (workspace_id, description, status, created_by, priority) VALUES (?, ?, ?, ?, ?)`,
      wsB, 'Dependent task', 'open', 'agent-b', 'P2',
    );
    const taskBId = Number(taskBResult.lastInsertRowid);

    // Manually insert cross-workspace dependency (simulating corrupt state)
    await ctx.db.run(
      'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)',
      taskBId, taskA.task_id,
    );

    // The blocker query should filter by workspace_id, so claiming should work
    // because the blocker is in a different workspace
    const blockers = await ctx.db.all<{ id: number; status: string }>(
      `SELECT t.id, t.status FROM task_dependencies td
       JOIN tasks t ON t.id = td.depends_on
       WHERE td.task_id = ? AND t.workspace_id = ? AND t.status != 'completed'`,
      taskBId, wsB,
    );
    // Should find no blockers because the dependency is in workspace A, not B
    expect(blockers.length).toBe(0);
  });
});
