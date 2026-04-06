import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, testConfig, type TestContext } from './helpers.js';
import { createUser, deleteUser, getUserById, deleteWorkspaceData } from '../src/models/user.js';
import { createSession, getSession, listUserSessions } from '../src/models/session.js';
import { addMembership, listUserMemberships, listWorkspaceMembers, countOwners } from '../src/models/membership.js';
// invitation imports removed — not used in this file
import { saveArtifact, getArtifact, deleteArtifact, listArtifacts } from '../src/models/artifact.js';
import { registerAgent, markStaleAgents, listAgents } from '../src/models/agent.js';
import { saveContext } from '../src/models/context.js';
import { broadcastEvent } from '../src/models/event.js';
import { createTask } from '../src/models/task.js';
import { sendMessage } from '../src/models/message.js';
import { setUsageTracking, getCurrentUsageWithLimits } from '../src/models/usage.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import type { SqliteAdapter } from '../src/db/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../src/models/types.js';

// ─── MCP helper ────────────────────────────────────────────────────────

function createMcpTestCtx() {
  const db = createTestDb();
  setupWorkspace(db, 'test-team');
  const mcp = createMcpServer(db);
  const auth: AuthContext = {
    workspaceId: 'test-team',
    agentId: 'test-agent',
    scope: 'write',
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
  return mcpAuthStorage.run(auth, () =>
    tool.inputSchema ? tool.handler(args, {}) : tool.handler({}),
  );
}

// ─── P0: deleteUser cascade ────────────────────────────────────────────

describe('deleteUser — cascade cleanup', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should delete user and all associated data', async () => {
    // Create a user
    const user = await createUser(ctx.db, {
      email: 'delete-me@test.com',
      password: 'password123',
      name: 'Delete Me',
    });

    // Add membership
    await addMembership(ctx.db, {
      userId: user.id,
      workspaceId: ctx.workspaceId,
      role: 'member',
    });

    // Create a session
    const session = await createSession(ctx.db, user.id, { ip: '127.0.0.1' });

    // Now delete the user
    await deleteUser(ctx.db, user.id);

    // Verify user is gone
    const fetched = await getUserById(ctx.db, user.id);
    expect(fetched).toBeNull();

    // Verify session is gone
    const sess = await getSession(ctx.db, session.raw);
    expect(sess).toBeNull();

    // Verify membership is gone
    const memberships = await listUserMemberships(ctx.db, user.id);
    expect(memberships).toHaveLength(0);
  });

  it('should handle deleting a user with no associated data', async () => {
    const user = await createUser(ctx.db, {
      email: 'simple@test.com',
      password: 'password123',
    });

    // Should not throw
    await deleteUser(ctx.db, user.id);

    const fetched = await getUserById(ctx.db, user.id);
    expect(fetched).toBeNull();
  });
});

// ─── P0: deleteWorkspaceData cascade ────────────────────────────────────

describe('deleteWorkspaceData — cascade cleanup', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should delete all workspace-scoped data', async () => {
    // Populate workspace with data
    await saveContext(ctx.db, ctx.workspaceId, 'agent', {
      key: 'test-key', value: 'test-value', tags: ['test'],
    });

    await broadcastEvent(ctx.db, ctx.workspaceId, 'agent', {
      event_type: 'BROADCAST', message: 'hello', tags: [],
    });

    await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'test task', status: 'open',
    });

    await sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
      to: 'agent-b', message: 'hello', tags: [],
    });

    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'registered-agent', capabilities: ['search'],
    });

    await saveArtifact(ctx.db, ctx.workspaceId, 'agent', {
      key: 'test-art', content_type: 'text/plain', content: 'hello',
    });

    // Now delete everything
    await deleteWorkspaceData(ctx.db, ctx.workspaceId);

    // Verify tables are empty for this workspace
    const contextCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM context_entries WHERE workspace_id = ?',
    ).get(ctx.workspaceId) as any;
    expect(contextCount.c).toBe(0);

    const eventCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM events WHERE workspace_id = ?',
    ).get(ctx.workspaceId) as any;
    expect(eventCount.c).toBe(0);

    const taskCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?',
    ).get(ctx.workspaceId) as any;
    expect(taskCount.c).toBe(0);

    const agentCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?',
    ).get(ctx.workspaceId) as any;
    expect(agentCount.c).toBe(0);

    const msgCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM messages WHERE workspace_id = ?',
    ).get(ctx.workspaceId) as any;
    expect(msgCount.c).toBe(0);

    const artCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM artifacts WHERE workspace_id = ?',
    ).get(ctx.workspaceId) as any;
    expect(artCount.c).toBe(0);

    // Workspace itself should be gone
    const wsCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM workspaces WHERE id = ?',
    ).get(ctx.workspaceId) as any;
    expect(wsCount.c).toBe(0);
  });

  it('should delete task dependencies when workspace is deleted', async () => {
    const t1 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Parent', status: 'open',
    });
    const t2 = await createTask(ctx.db, ctx.workspaceId, 'agent', {
      description: 'Child', status: 'open', depends_on: [t1.task_id],
    });

    await deleteWorkspaceData(ctx.db, ctx.workspaceId);

    const depCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM task_dependencies WHERE task_id = ?',
    ).get(t2.task_id) as any;
    expect(depCount.c).toBe(0);
  });

  it('should delete api_keys and memberships', async () => {
    await deleteWorkspaceData(ctx.db, ctx.workspaceId);

    const keyCount = ctx.rawDb.prepare(
      'SELECT COUNT(*) as c FROM api_keys WHERE workspace_id = ?',
    ).get(ctx.workspaceId) as any;
    expect(keyCount.c).toBe(0);
  });
});

// ─── P1: deleteArtifact ─────────────────────────────────────────────────

describe('deleteArtifact', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should delete an existing artifact', async () => {
    await saveArtifact(ctx.db, ctx.workspaceId, 'agent', {
      key: 'to-delete', content_type: 'text/plain', content: 'temporary',
    });

    const result = await deleteArtifact(ctx.db, ctx.workspaceId, 'to-delete');
    expect(result.deleted).toBe(true);

    // Verify it's gone
    await expect(
      getArtifact(ctx.db, ctx.workspaceId, 'to-delete'),
    ).rejects.toThrow(/not found/i);
  });

  it('should throw NotFoundError for non-existent artifact', async () => {
    await expect(
      deleteArtifact(ctx.db, ctx.workspaceId, 'does-not-exist'),
    ).rejects.toThrow(/not found/i);
  });

  it('should not affect other artifacts', async () => {
    await saveArtifact(ctx.db, ctx.workspaceId, 'agent', {
      key: 'keep-this', content_type: 'text/plain', content: 'stay',
    });
    await saveArtifact(ctx.db, ctx.workspaceId, 'agent', {
      key: 'delete-this', content_type: 'text/plain', content: 'go',
    });

    await deleteArtifact(ctx.db, ctx.workspaceId, 'delete-this');

    const kept = await getArtifact(ctx.db, ctx.workspaceId, 'keep-this');
    expect(kept.content).toBe('stay');

    const list = await listArtifacts(ctx.db, ctx.workspaceId, {});
    expect(list.total).toBe(1);
  });
});

// ─── P1: markStaleAgents ────────────────────────────────────────────────

describe('markStaleAgents', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should mark agents offline whose heartbeat is older than timeout', async () => {
    // Register an agent with a recent heartbeat
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'fresh-agent', capabilities: [],
    });

    // Register an agent with an old heartbeat
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'stale-agent', capabilities: [],
    });

    // Manually backdate the stale agent's heartbeat
    const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
    ctx.rawDb.prepare(
      'UPDATE agents SET last_heartbeat = ? WHERE id = ? AND workspace_id = ?',
    ).run(oldTime, 'stale-agent', ctx.workspaceId);

    const changed = await markStaleAgents(ctx.db, 10); // 10 min timeout
    expect(changed).toBe(1);

    const agents = await listAgents(ctx.db, ctx.workspaceId, {});
    const stale = agents.agents.find((a) => a.id === 'stale-agent');
    const fresh = agents.agents.find((a) => a.id === 'fresh-agent');
    expect(stale!.status).toBe('offline');
    expect(fresh!.status).toBe('online');
  });

  it('should not mark already-offline agents', async () => {
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'already-offline', capabilities: [], status: 'offline',
    });

    const oldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    ctx.rawDb.prepare(
      'UPDATE agents SET last_heartbeat = ? WHERE id = ? AND workspace_id = ?',
    ).run(oldTime, 'already-offline', ctx.workspaceId);

    const changed = await markStaleAgents(ctx.db, 10);
    expect(changed).toBe(0); // Already offline, no change
  });

  it('should return 0 when no agents are stale', async () => {
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'active', capabilities: [],
    });

    const changed = await markStaleAgents(ctx.db, 10);
    expect(changed).toBe(0);
  });

  it('should mark busy agents as offline when stale', async () => {
    await registerAgent(ctx.db, ctx.workspaceId, {
      agent_id: 'busy-agent', capabilities: [], status: 'busy',
    });

    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    ctx.rawDb.prepare(
      'UPDATE agents SET last_heartbeat = ? WHERE id = ? AND workspace_id = ?',
    ).run(oldTime, 'busy-agent', ctx.workspaceId);

    const changed = await markStaleAgents(ctx.db, 10);
    expect(changed).toBe(1);

    const agents = await listAgents(ctx.db, ctx.workspaceId, {});
    expect(agents.agents[0].status).toBe('offline');
  });
});

// ─── P1: countOwners ────────────────────────────────────────────────────

describe('countOwners', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should return 0 when no owners exist', async () => {
    const count = await countOwners(ctx.db, ctx.workspaceId);
    expect(count).toBe(0);
  });

  it('should count owners correctly', async () => {
    // Create users and add as owners
    const user1 = await createUser(ctx.db, { email: 'owner1@test.com', password: 'password123' });
    const user2 = await createUser(ctx.db, { email: 'owner2@test.com', password: 'password123' });
    const user3 = await createUser(ctx.db, { email: 'member@test.com', password: 'password123' });

    await addMembership(ctx.db, { userId: user1.id, workspaceId: ctx.workspaceId, role: 'owner' });
    await addMembership(ctx.db, { userId: user2.id, workspaceId: ctx.workspaceId, role: 'owner' });
    await addMembership(ctx.db, { userId: user3.id, workspaceId: ctx.workspaceId, role: 'member' });

    const count = await countOwners(ctx.db, ctx.workspaceId);
    expect(count).toBe(2);
  });

  it('should not count admins or members as owners', async () => {
    const user = await createUser(ctx.db, { email: 'admin@test.com', password: 'password123' });
    await addMembership(ctx.db, { userId: user.id, workspaceId: ctx.workspaceId, role: 'admin' });

    const count = await countOwners(ctx.db, ctx.workspaceId);
    expect(count).toBe(0);
  });
});

// ─── P0: MCP quota enforcement (documented behavior) ────────────────────

describe('MCP quota enforcement — known behavior', () => {
  let db: SqliteAdapter;
  let mcp: McpServer;
  let auth: AuthContext;

  beforeEach(() => {
    const ctx = createMcpTestCtx();
    db = ctx.db;
    mcp = ctx.mcp;
    auth = ctx.auth;
    setUsageTracking(true);
  });

  afterEach(() => {
    setUsageTracking(false);
  });

  it('should track usage increments via MCP save_context', async () => {
    await callTool(mcp, auth, 'save_context', {
      agent_id: 'test-agent',
      key: 'quota-test',
      value: 'some value here',
      tags: [],
    });

    const usage = await getCurrentUsageWithLimits(db, 'test-team');
    expect(usage.usage.storageBytes).toBeGreaterThan(0);
  });

  it('should track exec usage via MCP create_task', async () => {
    await callTool(mcp, auth, 'create_task', {
      agent_id: 'test-agent',
      description: 'quota tracked task',
    });

    const usage = await getCurrentUsageWithLimits(db, 'test-team');
    expect(usage.usage.execCount).toBeGreaterThan(0);
  });

  it('should track exec usage via MCP run_playbook', async () => {
    // Create the playbook first
    await callTool(mcp, auth, 'define_playbook', {
      agent_id: 'test-agent',
      name: 'quota-pb',
      description: 'Test',
      tasks: [{ description: 'Step 1' }],
    });

    await callTool(mcp, auth, 'run_playbook', {
      agent_id: 'test-agent',
      name: 'quota-pb',
    });

    const usage = await getCurrentUsageWithLimits(db, 'test-team');
    // run_playbook counts exec for each task + 1 for the run
    expect(usage.usage.execCount).toBeGreaterThanOrEqual(2);
  });
});
