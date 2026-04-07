/**
 * Tests for: artifact deletion and stale agent detection
 * - deleteArtifact (removes artifact, NotFoundError for missing, does not affect other artifacts)
 * - markStaleAgents (offline after heartbeat timeout, already-offline skip, busy agents marked stale)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupWorkspace, type TestContext } from './helpers.js';
import { saveArtifact, getArtifact, deleteArtifact, listArtifacts } from '../src/models/artifact.js';
import { registerAgent, markStaleAgents, listAgents } from '../src/models/agent.js';
import { createTask } from '../src/models/task.js';
import { sendMessage } from '../src/models/message.js';
import { saveContext } from '../src/models/context.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
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

