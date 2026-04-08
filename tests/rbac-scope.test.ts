import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestContext,
  createTestDb,
  setupWorkspace,
  authHeaders,
  request,
  addApiKey,
  TEST_ADMIN_KEY,
  type TestContext,
} from './helpers.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../src/models/types.js';

describe('RBAC scoped API keys', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('read-scoped key', () => {
    let readKey: string;
    beforeEach(() => {
      readKey = 'ltk_read_key_1234567890123456789012';
      addApiKey(ctx.db, ctx.workspaceId, readKey, 'read');
    });

    it('allows GET /api/v1/context', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=x', {
        headers: authHeaders(readKey),
      });
      expect(res.status).toBe(200);
    });

    it('blocks POST /api/v1/context with 403 INSUFFICIENT_SCOPE', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(readKey),
        body: { key: 'x', value: 'v', tags: [] },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('INSUFFICIENT_SCOPE');
      expect(body.message).toContain("scope 'read'");
      expect(body.message).toContain("requires 'write'");
    });

    it('blocks PATCH with 403', async () => {
      // Need a task to patch — create it with write key first
      const writeKey = 'ltk_write_key_234567890123456789012';
      addApiKey(ctx.db, ctx.workspaceId, writeKey, 'write');
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(writeKey),
        body: { description: 'task' },
      });
      const { task_id } = await createRes.json();

      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(readKey),
        body: { status: 'completed', result: 'ok', version: 1 },
      });
      expect(res.status).toBe(403);
    });

    it('blocks DELETE with 403', async () => {
      const res = await request(ctx.app, 'DELETE', '/api/v1/artifacts/anykey', {
        headers: authHeaders(readKey),
      });
      expect(res.status).toBe(403);
    });

    it('reports scope in /teams/mine', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/teams/mine', {
        headers: authHeaders(readKey),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scope).toBe('read');
    });
  });

  describe('write-scoped key', () => {
    // Default test key is 'write' scope
    it('allows GET', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=x', {
        headers: authHeaders(ctx.apiKey),
      });
      expect(res.status).toBe(200);
    });

    it('allows POST /api/v1/context', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'hello', value: 'world', tags: ['t'] },
      });
      expect(res.status).toBe(201);
    });

    it('allows POST /api/v1/tasks', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'do it' },
      });
      expect(res.status).toBe(201);
    });

    it('allows PATCH and DELETE', async () => {
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 't' },
      });
      const { task_id } = await createRes.json();
      const patchRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'completed', result: 'ok', version: 1 },
      });
      expect(patchRes.status).toBe(200);
    });

    it('cannot access /admin/* (admin routes still gated by ADMIN_KEY env)', async () => {
      // Write-scoped key used as Bearer against /admin is not a valid ADMIN_KEY
      const res = await request(ctx.app, 'GET', '/admin/stats', {
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      expect(res.status).toBe(401);
    });

    it('reports scope=write in /teams/mine', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/teams/mine', {
        headers: authHeaders(ctx.apiKey),
      });
      const body = await res.json();
      expect(body.scope).toBe('write');
    });
  });

  describe('admin-scoped key', () => {
    let adminKey: string;
    beforeEach(() => {
      adminKey = 'ltk_admin_key_34567890123456789012';
      addApiKey(ctx.db, ctx.workspaceId, adminKey, 'admin');
    });

    it('allows GET and POST on /api/v1/*', async () => {
      const getRes = await request(ctx.app, 'GET', '/api/v1/context?query=x', {
        headers: authHeaders(adminKey),
      });
      expect(getRes.status).toBe(200);

      const postRes = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(adminKey),
        body: { event_type: 'BROADCAST', message: 'hi', tags: [] },
      });
      expect(postRes.status).toBe(201);
    });

    it('still cannot access /admin/* without matching ADMIN_KEY env', async () => {
      const res = await request(ctx.app, 'GET', '/admin/stats', {
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json',
        },
      });
      expect(res.status).toBe(401);
    });

    it('reports scope=admin in /teams/mine', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/teams/mine', {
        headers: authHeaders(adminKey),
      });
      const body = await res.json();
      expect(body.scope).toBe('admin');
    });
  });

  describe('admin endpoint key creation with scope', () => {
    it('POST /admin/teams/:id/keys accepts scope param', async () => {
      const res = await request(ctx.app, 'POST', `/admin/teams/${ctx.workspaceId}/keys`, {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_KEY}`,
          'Content-Type': 'application/json',
        },
        body: { label: 'readonly', scope: 'read' },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.scope).toBe('read');
      expect(body.api_key).toMatch(/^lt_/);

      // The new key should only allow GET
      const postRes = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(body.api_key),
        body: { key: 'x', value: 'v', tags: [] },
      });
      expect(postRes.status).toBe(403);
    });

    it('POST /admin/teams/:id/keys defaults scope to write when omitted', async () => {
      const res = await request(ctx.app, 'POST', `/admin/teams/${ctx.workspaceId}/keys`, {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_KEY}`,
          'Content-Type': 'application/json',
        },
        body: { label: 'default-scope' },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.scope).toBe('write');
    });

    it('POST /admin/teams auto-generates a write-scoped key', async () => {
      const res = await request(ctx.app, 'POST', '/admin/teams', {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_KEY}`,
          'Content-Type': 'application/json',
        },
        body: { id: 'new-team-rbac', name: 'New Team RBAC' },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.scope).toBe('write');

      // The generated key should permit POST
      const postRes = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(body.api_key),
        body: { key: 'hello', value: 'w', tags: [] },
      });
      expect(postRes.status).toBe(201);
    });

    it('rejects invalid scope value', async () => {
      const res = await request(ctx.app, 'POST', `/admin/teams/${ctx.workspaceId}/keys`, {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_KEY}`,
          'Content-Type': 'application/json',
        },
        body: { scope: 'superuser' },
      });
      expect(res.status).toBe(400);
    });
  });
});

// ─── MCP helpers for scope tests ──────────────────────────────────────

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

// ─── MCP scope enforcement for read-only keys (from round4-fixes) ─────

describe('MCP scope enforcement for read-only keys', () => {
  let mcp: McpServer;
  let readAuth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx('read');
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
      const result = await callMcpTool(mcp, readAuth, name, args);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toMatch(/scope.*read|requires.*write/i);
    });
  }

  it('should allow read-only key to call read tools', async () => {
    const result = await callMcpTool(mcp, readAuth, 'get_context', {
      query: 'test',
    });
    expect(result.isError).toBeUndefined();
  });

  it('should allow write key to call mutating tools', async () => {
    const writeCtx = createMcpTestCtx('write');
    const result = await callMcpTool(writeCtx.mcp, writeCtx.auth, 'save_context', {
      agent_id: 'test-agent',
      key: 'allowed',
      value: 'this should work',
      tags: [],
    });
    expect(result.isError).toBeUndefined();
  });
});

// ─── Heartbeat MCP tool requires write scope (from round7-fixes) ──────

describe('heartbeat MCP tool requires write scope', () => {
  it('should block read-only key from calling heartbeat', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const result = await callMcpTool(mcp, auth, 'heartbeat', {
      agent_id: 'test-agent',
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/scope.*read|requires.*write/i);
  });

  it('should allow write key to call heartbeat', async () => {
    const { mcp, auth } = createMcpTestCtx('write');
    const result = await callMcpTool(mcp, auth, 'heartbeat', {
      agent_id: 'test-agent',
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
  });

  it('should block read-only key even with status parameter', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const result = await callMcpTool(mcp, auth, 'heartbeat', {
      agent_id: 'test-agent',
      status: 'online',
    });
    expect(result.isError).toBe(true);
  });
});
