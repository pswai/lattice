import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { setupTeam } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { testConfig } from './helpers.js';

describe('Agent Profiles API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /api/v1/profiles — define_profile', () => {
    it('should define a researcher profile', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'researcher',
          description: 'Research specialist for web search and synthesis',
          system_prompt: 'You are a researcher. Dig deep, cite sources, synthesize findings.',
          default_capabilities: ['web-search', 'synthesis', 'writing'],
          default_tags: ['research'],
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe('researcher');
      expect(data.description).toContain('Research specialist');
      expect(data.systemPrompt).toContain('You are a researcher');
      expect(data.defaultCapabilities).toEqual(['web-search', 'synthesis', 'writing']);
      expect(data.defaultTags).toEqual(['research']);
      expect(data.createdBy).toBe('test-agent');
    });

    it('should reject missing system_prompt', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'bad',
          description: 'missing prompt',
        },
      });
      expect(res.status).toBe(400);
    });

    it('should default empty arrays when capabilities/tags omitted', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'minimal',
          description: 'bare minimum',
          system_prompt: 'Do the thing.',
        },
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.defaultCapabilities).toEqual([]);
      expect(data.defaultTags).toEqual([]);
    });
  });

  describe('GET /api/v1/profiles — list_profiles', () => {
    it('should list defined profiles', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers,
        body: {
          name: 'researcher',
          description: 'r',
          system_prompt: 'research',
        },
      });
      await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers,
        body: {
          name: 'writer',
          description: 'w',
          system_prompt: 'write',
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/profiles', { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.total).toBe(2);
      expect(data.profiles.map((p: any) => p.name).sort()).toEqual(['researcher', 'writer']);
      expect(data.profiles[0].systemPrompt).toBeTruthy();
    });
  });

  describe('GET /api/v1/profiles/:name — get_profile', () => {
    it('should get profile by name', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers,
        body: {
          name: 'analyst',
          description: 'Data analyst',
          system_prompt: 'Analyze data carefully.',
          default_capabilities: ['sql', 'stats'],
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/profiles/analyst', { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe('analyst');
      expect(data.systemPrompt).toBe('Analyze data carefully.');
      expect(data.defaultCapabilities).toEqual(['sql', 'stats']);
    });

    it('should return 404 for missing profile', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/profiles/nonexistent', {
        headers: authHeaders(ctx.apiKey),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('upsert behavior', () => {
    it('should update existing profile when defined with same name', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers,
        body: {
          name: 'role',
          description: 'v1',
          system_prompt: 'original',
          default_capabilities: ['a'],
        },
      });
      const res2 = await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers,
        body: {
          name: 'role',
          description: 'v2',
          system_prompt: 'updated prompt',
          default_capabilities: ['b', 'c'],
        },
      });
      expect(res2.status).toBe(201);

      const listRes = await request(ctx.app, 'GET', '/api/v1/profiles', { headers });
      const listData = await listRes.json();
      expect(listData.total).toBe(1);
      expect(listData.profiles[0].description).toBe('v2');
      expect(listData.profiles[0].systemPrompt).toBe('updated prompt');
      expect(listData.profiles[0].defaultCapabilities).toEqual(['b', 'c']);
    });
  });

  describe('DELETE /api/v1/profiles/:name — delete_profile', () => {
    it('should delete an existing profile', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers,
        body: {
          name: 'temp',
          description: 'temporary',
          system_prompt: 'temp prompt',
        },
      });

      const delRes = await request(ctx.app, 'DELETE', '/api/v1/profiles/temp', { headers });
      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.deleted).toBe(true);

      const getRes = await request(ctx.app, 'GET', '/api/v1/profiles/temp', { headers });
      expect(getRes.status).toBe(404);
    });

    it('should return 404 when deleting nonexistent profile', async () => {
      const res = await request(ctx.app, 'DELETE', '/api/v1/profiles/ghost', {
        headers: authHeaders(ctx.apiKey),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('team isolation', () => {
    it('should not leak profiles across teams', async () => {
      // ctx has team-a
      const headersA = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: headersA,
        body: {
          name: 'secret-role',
          description: 'team a role',
          system_prompt: 'team a prompt',
        },
      });

      // create team B on the same DB, own app instance
      const teamB = setupTeam(ctx.db, 'team-b', 'ltk_team_b_key_1234567890abcdef');
      const appB = createApp(ctx.db, () => createMcpServer(ctx.db), testConfig());
      const headersB = authHeaders(teamB.apiKey);

      // team B should see nothing
      const listResB = await request(appB, 'GET', '/api/v1/profiles', { headers: headersB });
      const listDataB = await listResB.json();
      expect(listDataB.total).toBe(0);

      // team B should 404 on team A's profile name
      const getResB = await request(appB, 'GET', '/api/v1/profiles/secret-role', { headers: headersB });
      expect(getResB.status).toBe(404);

      // team A still sees it
      const listResA = await request(ctx.app, 'GET', '/api/v1/profiles', { headers: headersA });
      const listDataA = await listResA.json();
      expect(listDataA.total).toBe(1);
    });
  });
});
