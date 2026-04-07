import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

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
});
