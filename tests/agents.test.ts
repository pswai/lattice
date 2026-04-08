import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { registerAgent, markStaleAgents, listAgents } from '../src/models/agent.js';

describe('Agent Registry API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /api/v1/agents — register_agent', () => {
    it('should register a new agent', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: {
          agent_id: 'researcher',
          capabilities: ['web-search', 'data-analysis'],
          status: 'online',
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe('researcher');
      expect(data.capabilities).toEqual(['web-search', 'data-analysis']);
      expect(data.status).toBe('online');
    });

    it('should update an existing agent on re-register', async () => {
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'researcher', capabilities: ['search'] },
      });

      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'researcher', capabilities: ['search', 'code-review'], status: 'busy' },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.capabilities).toEqual(['search', 'code-review']);
      expect(data.status).toBe('busy');
    });
  });

  describe('GET /api/v1/agents — list_agents', () => {
    it('should list all agents for the team', async () => {
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'agent-a', capabilities: ['python'] },
      });
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'agent-b', capabilities: ['javascript'] },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.agents).toHaveLength(2);
    });

    it('should filter by capability', async () => {
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'py-agent', capabilities: ['python', 'data-analysis'] },
      });
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'js-agent', capabilities: ['javascript'] },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/agents?capability=python', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('py-agent');
    });

    it('should filter by status', async () => {
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'online-agent', capabilities: [], status: 'online' },
      });
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'busy-agent', capabilities: [], status: 'busy' },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/agents?status=busy', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('busy-agent');
    });
  });

  describe('POST /api/v1/agents/:id/heartbeat', () => {
    it('should update heartbeat timestamp', async () => {
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'worker', capabilities: ['tasks'] },
      });

      const res = await request(ctx.app, 'POST', '/api/v1/agents/worker/heartbeat', {
        headers: authHeaders(ctx.apiKey),
        body: {},
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });

    it('should optionally update status', async () => {
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: { agent_id: 'worker', capabilities: [], status: 'online' },
      });

      await request(ctx.app, 'POST', '/api/v1/agents/worker/heartbeat', {
        headers: authHeaders(ctx.apiKey),
        body: { status: 'busy' },
      });

      const listRes = await request(ctx.app, 'GET', '/api/v1/agents?status=busy', {
        headers: authHeaders(ctx.apiKey),
      });
      const data = await listRes.json();
      expect(data.agents).toHaveLength(1);
      expect(data.agents[0].id).toBe('worker');
    });
  });

  // ─── Agent metadata REST 10KB boundary (from round2) ──────────────

  describe('Agent metadata — REST 10KB boundary', () => {
    it('rejects metadata exactly at the limit boundary (> 10KB)', async () => {
      const metadata: Record<string, string> = {};
      for (let i = 0; i < 200; i++) {
        metadata[`key_${i}`] = 'x'.repeat(50);
      }
      const size = JSON.stringify(metadata).length;
      expect(size).toBeGreaterThan(10_000);

      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: {
          agent_id: 'big-meta',
          capabilities: ['test'],
          metadata,
        },
      });
      expect(res.status).toBe(400);
    });

    it('accepts metadata well under 10KB', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: {
          agent_id: 'small-meta',
          capabilities: ['test'],
          metadata: { version: '1.0', env: 'test', lang: 'en' },
        },
      });
      expect([200, 201]).toContain(res.status);
    });

    it('accepts registration without metadata at all', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: {
          agent_id: 'no-meta',
          capabilities: ['test'],
        },
      });
      expect([200, 201]).toContain(res.status);
    });
  });

  // ─── markStaleAgents (from round4-coverage-gaps) ────────────────────

  describe('markStaleAgents', () => {
    it('should mark agents offline whose heartbeat is older than timeout', async () => {
      await registerAgent(ctx.db, ctx.workspaceId, {
        agent_id: 'fresh-agent', capabilities: [],
      });
      await registerAgent(ctx.db, ctx.workspaceId, {
        agent_id: 'stale-agent', capabilities: [],
      });

      const oldTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      ctx.rawDb.prepare(
        'UPDATE agents SET last_heartbeat = ? WHERE id = ? AND workspace_id = ?',
      ).run(oldTime, 'stale-agent', ctx.workspaceId);

      const changed = await markStaleAgents(ctx.db, 10);
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
      expect(changed).toBe(0);
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
});
