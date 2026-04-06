import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, createTestDb, setupTeam, authHeaders, request, type TestContext } from './helpers.js';
import { autoRegisterAgent, listAgents } from '../src/models/agent.js';

/**
 * Auto-registration is triggered by MCP tool calls (server.ts), not REST routes.
 * These tests verify the autoRegisterAgent model function and its integration
 * with the agent registry, plus REST-level auto-reg via the MCP save_context path.
 */
describe('Auto-Registration — Model Layer', () => {
  let db: ReturnType<typeof createTestDb>;
  const teamId = 'test-team';

  beforeEach(() => {
    db = createTestDb();
    setupTeam(db, teamId);
  });

  it('should create a new agent with online status and empty capabilities', async () => {
    await autoRegisterAgent(db, teamId, 'new-agent');

    const { agents } = await listAgents(db, teamId, {});
    const agent = agents.find(a => a.id === 'new-agent');
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('online');
    expect(agent!.capabilities).toEqual([]);
  });

  it('should not overwrite capabilities or status on re-registration', async () => {
    // Register with explicit capabilities
    db.rawDb.prepare(`
      INSERT INTO agents (id, team_id, capabilities, status, metadata, last_heartbeat)
      VALUES (?, ?, '["python","testing"]', 'busy', '{}', '2020-01-01T00:00:00.000Z')
    `).run('skilled-agent', teamId);

    // Auto-register again (simulating MCP call)
    await autoRegisterAgent(db, teamId, 'skilled-agent');

    const { agents } = await listAgents(db, teamId, {});
    const agent = agents.find(a => a.id === 'skilled-agent');
    expect(agent!.capabilities).toEqual(['python', 'testing']);
    expect(agent!.status).toBe('busy');
  });

  it('should update last_heartbeat on subsequent auto-registration calls', async () => {
    // Insert with old heartbeat
    db.rawDb.prepare(`
      INSERT INTO agents (id, team_id, capabilities, status, metadata, last_heartbeat)
      VALUES (?, ?, '[]', 'online', '{}', '2020-01-01T00:00:00.000Z')
    `).run('heartbeat-agent', teamId);

    await autoRegisterAgent(db, teamId, 'heartbeat-agent');

    const row = db.rawDb.prepare(
      'SELECT last_heartbeat FROM agents WHERE team_id = ? AND id = ?',
    ).get(teamId, 'heartbeat-agent') as any;

    expect(row.last_heartbeat).not.toBe('2020-01-01T00:00:00.000Z');
    // Should be a recent timestamp
    const hbTime = new Date(row.last_heartbeat).getTime();
    expect(hbTime).toBeGreaterThan(Date.now() - 5000);
  });

  it('should be idempotent — multiple calls do not create duplicates', async () => {
    await autoRegisterAgent(db, teamId, 'repeat-agent');
    await autoRegisterAgent(db, teamId, 'repeat-agent');
    await autoRegisterAgent(db, teamId, 'repeat-agent');

    const rows = db.rawDb.prepare(
      'SELECT * FROM agents WHERE team_id = ? AND id = ?',
    ).all(teamId, 'repeat-agent');
    expect(rows).toHaveLength(1);
  });

  it('should auto-register multiple different agents independently', async () => {
    await autoRegisterAgent(db, teamId, 'agent-x');
    await autoRegisterAgent(db, teamId, 'agent-y');
    await autoRegisterAgent(db, teamId, 'agent-z');

    const { agents } = await listAgents(db, teamId, {});
    expect(agents).toHaveLength(3);
    expect(agents.map(a => a.id).sort()).toEqual(['agent-x', 'agent-y', 'agent-z']);
  });
});

describe('Auto-Registration — Visible in REST list_agents', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should show auto-registered agents in GET /api/v1/agents', async () => {
    // Auto-register directly via model (simulates MCP tool call)
    await autoRegisterAgent(ctx.db, ctx.teamId, 'mcp-agent');

    // Verify visible through REST API
    const res = await request(ctx.app, 'GET', '/api/v1/agents', {
      headers: authHeaders(ctx.apiKey),
    });
    const data = await res.json();
    const agent = data.agents.find((a: any) => a.id === 'mcp-agent');
    expect(agent).toBeDefined();
    expect(agent.status).toBe('online');
  });

  it('should filter auto-registered agents by status', async () => {
    await autoRegisterAgent(ctx.db, ctx.teamId, 'online-agent');

    const res = await request(ctx.app, 'GET', '/api/v1/agents?status=online', {
      headers: authHeaders(ctx.apiKey),
    });
    const data = await res.json();
    expect(data.agents.some((a: any) => a.id === 'online-agent')).toBe(true);
  });

  it('should preserve explicit registration over auto-registration', async () => {
    // Explicitly register with capabilities
    await request(ctx.app, 'POST', '/api/v1/agents', {
      headers: authHeaders(ctx.apiKey, 'full-agent'),
      body: {
        agent_id: 'full-agent',
        capabilities: ['code-review', 'testing'],
        status: 'busy',
      },
    });

    // Auto-register same agent (like an MCP tool call would)
    await autoRegisterAgent(ctx.db, ctx.teamId, 'full-agent');

    // Capabilities and status should be preserved
    const res = await request(ctx.app, 'GET', '/api/v1/agents', {
      headers: authHeaders(ctx.apiKey),
    });
    const data = await res.json();
    const agent = data.agents.find((a: any) => a.id === 'full-agent');
    expect(agent.capabilities).toEqual(['code-review', 'testing']);
    expect(agent.status).toBe('busy');
  });
});
