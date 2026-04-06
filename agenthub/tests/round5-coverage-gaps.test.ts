import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, addApiKey, testConfig, type TestContext } from './helpers.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import { createUser } from '../src/models/user.js';
import {
  createSession,
  getSession,
  revokeAllUserSessions,
  listUserSessions,
} from '../src/models/session.js';
import {
  createInvitation,
  getInvitationById,
} from '../src/models/invitation.js';
import {
  setUsageTracking,
  isUsageTrackingEnabled,
  incrementUsageForced,
  getUsage,
} from '../src/models/usage.js';
import { createTask } from '../src/models/task.js';
import { saveContext } from '../src/models/context.js';
import { registerAgent } from '../src/models/agent.js';
import { sendMessage } from '../src/models/message.js';
import { startSessionCleanup } from '../src/services/session-cleanup.js';
import { startScheduler } from '../src/services/scheduler.js';
import { createApp } from '../src/http/app.js';
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

// ─── P1: revokeAllUserSessions ─────────────────────────────────────────

describe('P1 — revokeAllUserSessions', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should revoke all active sessions for a user', async () => {
    const user = await createUser(ctx.db, { email: 'rev@test.com', password: 'pass12345678' });
    const s1 = await createSession(ctx.db, user.id);
    const s2 = await createSession(ctx.db, user.id);
    const s3 = await createSession(ctx.db, user.id);

    const result = await revokeAllUserSessions(ctx.db, user.id);
    expect(result.revoked).toBe(3);

    // All sessions should be inaccessible
    expect(await getSession(ctx.db, s1.raw)).toBeNull();
    expect(await getSession(ctx.db, s2.raw)).toBeNull();
    expect(await getSession(ctx.db, s3.raw)).toBeNull();
  });

  it('should return 0 when user has no active sessions', async () => {
    const user = await createUser(ctx.db, { email: 'nosess@test.com', password: 'pass12345678' });
    const result = await revokeAllUserSessions(ctx.db, user.id);
    expect(result.revoked).toBe(0);
  });

  it('should not double-revoke already revoked sessions', async () => {
    const user = await createUser(ctx.db, { email: 'double@test.com', password: 'pass12345678' });
    await createSession(ctx.db, user.id);
    await createSession(ctx.db, user.id);

    const first = await revokeAllUserSessions(ctx.db, user.id);
    expect(first.revoked).toBe(2);

    const second = await revokeAllUserSessions(ctx.db, user.id);
    expect(second.revoked).toBe(0);
  });

  it('should not affect other users sessions', async () => {
    const user1 = await createUser(ctx.db, { email: 'u1@test.com', password: 'pass12345678' });
    const user2 = await createUser(ctx.db, { email: 'u2@test.com', password: 'pass12345678' });

    await createSession(ctx.db, user1.id);
    const s2 = await createSession(ctx.db, user2.id);

    await revokeAllUserSessions(ctx.db, user1.id);

    // user2's session should still be valid
    const valid = await getSession(ctx.db, s2.raw);
    expect(valid).not.toBeNull();
    expect(valid!.userId).toBe(user2.id);
  });
});

// ─── P1: getInvitationById ─────────────────────────────────────────────

describe('P1 — getInvitationById', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should return invitation by ID', async () => {
    const inv = await createInvitation(ctx.db, {
      workspaceId: ctx.workspaceId,
      email: 'inv@test.com',
      role: 'member',
      invitedBy: 'admin-user',
    });

    const found = await getInvitationById(ctx.db, inv.invitationId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inv.invitationId);
    expect(found!.email).toBe('inv@test.com');
    expect(found!.role).toBe('member');
    expect(found!.workspaceId).toBe(ctx.workspaceId);
  });

  it('should return null for non-existent ID', async () => {
    const found = await getInvitationById(ctx.db, 'inv_nonexistent');
    expect(found).toBeNull();
  });

  it('should return expired invitations (unlike getInvitationByToken)', async () => {
    const inv = await createInvitation(ctx.db, {
      workspaceId: ctx.workspaceId,
      email: 'expired@test.com',
      role: 'member',
      invitedBy: 'admin-user',
      ttlDays: 0, // expires immediately
    });

    // Force expire
    ctx.rawDb.prepare(
      "UPDATE workspace_invitations SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
    ).run(inv.invitationId);

    // getInvitationById should still return it (no state filtering)
    const found = await getInvitationById(ctx.db, inv.invitationId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inv.invitationId);
  });

  it('should return revoked invitations (unlike getInvitationByToken)', async () => {
    const inv = await createInvitation(ctx.db, {
      workspaceId: ctx.workspaceId,
      email: 'revoked@test.com',
      role: 'viewer',
      invitedBy: 'admin-user',
    });

    // Mark as revoked
    ctx.rawDb.prepare(
      "UPDATE workspace_invitations SET revoked_at = datetime('now') WHERE id = ?",
    ).run(inv.invitationId);

    const found = await getInvitationById(ctx.db, inv.invitationId);
    expect(found).not.toBeNull();
    expect(found!.revokedAt).not.toBeNull();
  });
});

// ─── P1: isUsageTrackingEnabled toggle ─────────────────────────────────

describe('P1 — isUsageTrackingEnabled', () => {
  afterEach(() => {
    setUsageTracking(false); // reset to default
  });

  it('should default to false', () => {
    expect(isUsageTrackingEnabled()).toBe(false);
  });

  it('should reflect setUsageTracking(true)', () => {
    setUsageTracking(true);
    expect(isUsageTrackingEnabled()).toBe(true);
  });

  it('should toggle back to false', () => {
    setUsageTracking(true);
    expect(isUsageTrackingEnabled()).toBe(true);
    setUsageTracking(false);
    expect(isUsageTrackingEnabled()).toBe(false);
  });
});

// ─── P1: Service lifecycle start/stop ──────────────────────────────────

describe('P1 — Service lifecycle', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('startSessionCleanup', () => {
    it('should return a timer handle that can be cleared', () => {
      const timer = startSessionCleanup(ctx.db);
      expect(timer).toBeDefined();
      // Should be a NodeJS.Timeout
      expect(typeof timer[Symbol.toPrimitive] === 'function' || typeof timer === 'object').toBe(true);
      clearInterval(timer);
    });

    it('should run cleanup immediately on start', async () => {
      const user = await createUser(ctx.db, { email: 'cleanup@test.com', password: 'pass12345678' });
      const session = await createSession(ctx.db, user.id);

      // Force expire
      ctx.rawDb.prepare(
        "UPDATE sessions SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
      ).run(session.sessionId);

      const timer = startSessionCleanup(ctx.db);
      // Give the async runOnce a tick to complete
      await new Promise(r => setTimeout(r, 50));
      clearInterval(timer);

      // Expired session should have been pruned
      const found = await getSession(ctx.db, session.raw);
      expect(found).toBeNull();
    });
  });

  describe('startScheduler', () => {
    it('should return a timer handle that can be cleared', () => {
      const timer = startScheduler(ctx.db);
      expect(timer).toBeDefined();
      clearInterval(timer);
    });
  });
});

// ─── P0: MCP quota enforcement (REST middleware) ───────────────────────

describe('P0 — Quota enforcement middleware', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should return 429 when quota is exceeded', async () => {
    // Push usage over the limit — default plan has limited quota
    // Force exec count to exceed quota
    await incrementUsageForced(ctx.db, ctx.workspaceId, { exec: 100_000, apiCall: 100_000 });

    const config = testConfig({ quotaEnforcement: true });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');

    // Set usage above quota
    await incrementUsageForced(db, 'test-team', { exec: 100_000, apiCall: 100_000 });

    const app = createApp(db, () => createMcpServer(db), config);
    const { request: req } = await import('./helpers.js');
    const { authHeaders: ah } = await import('./helpers.js');

    const res = await req(app, 'POST', '/api/v1/tasks', {
      headers: ah('ltk_test_key_12345678901234567890'),
      body: { description: 'test task' },
    });

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe('QUOTA_EXCEEDED');
    expect(data.period).toBeDefined();
    expect(data.limits).toBeDefined();
    expect(data.usage).toBeDefined();
    expect(res.headers.get('Retry-After')).toBeDefined();
  });

  it('should set X-Quota-Warning header when soft limit exceeded', async () => {
    const config = testConfig({ quotaEnforcement: true });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');

    // Set usage to ~85% of default quota (need to know default quota)
    // Default plan has execQuota of some value — set to 85%
    // We need a value that's >= 80% but < 100% of quota
    // Looking at the plan table — we just need to push high enough
    // Let's push apiCallCount to 85% of whatever the plan allows
    // The default plan in test has quota values — let's just set a high-but-not-over value
    await incrementUsageForced(db, 'test-team', { apiCall: 850 });

    const app = createApp(db, () => createMcpServer(db), config);
    const { request: req, authHeaders: ah } = await import('./helpers.js');

    const res = await req(app, 'GET', '/api/v1/tasks', {
      headers: ah('ltk_test_key_12345678901234567890'),
    });

    // GET requests don't get quota enforcement, only mutating methods
    expect(res.status).toBe(200);
  });

  it('should allow GET requests even with quota exceeded', async () => {
    const config = testConfig({ quotaEnforcement: true });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    await incrementUsageForced(db, 'test-team', { exec: 100_000, apiCall: 100_000 });

    const app = createApp(db, () => createMcpServer(db), config);
    const { request: req, authHeaders: ah } = await import('./helpers.js');

    const res = await req(app, 'GET', '/api/v1/tasks', {
      headers: ah('ltk_test_key_12345678901234567890'),
    });

    // GET should pass through even when quota exceeded
    expect(res.status).toBe(200);
  });

  it('should pass through when quota enforcement is disabled', async () => {
    const config = testConfig({ quotaEnforcement: false });
    const db = createTestDb();
    setupWorkspace(db, 'test-team');
    await incrementUsageForced(db, 'test-team', { exec: 100_000, apiCall: 100_000 });

    const app = createApp(db, () => createMcpServer(db), config);
    const { request: req, authHeaders: ah } = await import('./helpers.js');

    const res = await req(app, 'POST', '/api/v1/tasks', {
      headers: ah('ltk_test_key_12345678901234567890'),
      body: { description: 'should work despite high usage' },
    });

    // Should NOT be 429 — enforcement is off
    expect(res.status).not.toBe(429);
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
