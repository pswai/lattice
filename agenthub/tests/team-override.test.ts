import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, setupTeam, type TestContext } from './helpers.js';

describe('X-Team-Override', () => {
  let ctx: TestContext;
  const TEAM_B_KEY = 'ahk_teamb_override_key_1234567890abcd';

  beforeEach(() => {
    ctx = createTestContext();
    setupTeam(ctx.db, 'team-b', TEAM_B_KEY);
  });

  describe('REST routes', () => {
    it('operates on the base team when no override is set', async () => {
      // Post an event on base team
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: { event_type: 'BROADCAST', message: 'base team event', tags: [] },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
      });
      const data = await res.json();
      expect(data.events.some((e: any) => e.message === 'base team event')).toBe(true);
    });

    it('routes the request to the override team when X-Team-Override is a valid key', async () => {
      // Broadcast against team-b using base credentials + override header
      const headers = {
        ...authHeaders(ctx.apiKey, 'agent-a'),
        'X-Team-Override': TEAM_B_KEY,
      };
      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers,
        body: { event_type: 'BROADCAST', message: 'override event', tags: [] },
      });
      expect(res.status).toBe(201);

      // Should appear in team-b, NOT in the base team
      const baseRes = await request(ctx.app, 'GET', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
      });
      const baseData = await baseRes.json();
      expect(baseData.events.some((e: any) => e.message === 'override event')).toBe(false);

      const overrideRes = await request(ctx.app, 'GET', '/api/v1/events', {
        headers: authHeaders(TEAM_B_KEY),
      });
      const overrideData = await overrideRes.json();
      expect(overrideData.events.some((e: any) => e.message === 'override event')).toBe(true);
    });

    it('returns 401 when X-Team-Override is not a valid API key', async () => {
      const headers = {
        ...authHeaders(ctx.apiKey, 'agent-a'),
        'X-Team-Override': 'ahk_not_a_real_key_xxxxxxxxxxxxxxxxxxxx',
      };
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=test', { headers });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('UNAUTHORIZED');
      expect(data.message).toMatch(/X-Team-Override/);
    });

    it('ignores an empty X-Team-Override header', async () => {
      const headers = {
        ...authHeaders(ctx.apiKey, 'agent-a'),
        'X-Team-Override': '',
      };
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=test', { headers });
      expect(res.status).toBe(200);
    });

    it('still 401s when the base Authorization header is invalid even if override is valid', async () => {
      const headers = {
        Authorization: 'Bearer ahk_invalid_base_key_xxxxxxxxxxxxxxxx',
        'X-Agent-ID': 'agent-a',
        'Content-Type': 'application/json',
        'X-Team-Override': TEAM_B_KEY,
      };
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=test', { headers });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/teams/mine', () => {
    it('returns the base team when no override is applied', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/teams/mine', {
        headers: authHeaders(ctx.apiKey),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.teamId).toBe(ctx.teamId);
      expect(data.baseTeamId).toBe(ctx.teamId);
      expect(data.overrideApplied).toBe(false);
      expect(data.accessibleTeams).toEqual([
        { teamId: ctx.teamId, via: 'authorization' },
      ]);
    });

    it('returns the override team as effective with both teams accessible', async () => {
      const headers = {
        ...authHeaders(ctx.apiKey),
        'X-Team-Override': TEAM_B_KEY,
      };
      const res = await request(ctx.app, 'GET', '/api/v1/teams/mine', { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.teamId).toBe('team-b');
      expect(data.baseTeamId).toBe(ctx.teamId);
      expect(data.overrideApplied).toBe(true);
      expect(data.accessibleTeams).toEqual(
        expect.arrayContaining([
          { teamId: ctx.teamId, via: 'authorization' },
          { teamId: 'team-b', via: 'x-team-override' },
        ]),
      );
    });
  });

  describe('/mcp endpoint', () => {
    it('returns 401 when X-Team-Override is invalid on /mcp', async () => {
      const res = await request(ctx.app, 'POST', '/mcp', {
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'X-Team-Override': 'ahk_not_a_real_key_xxxxxxxxxxxxxxxxxxxx',
          'Content-Type': 'application/json',
        },
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 on /mcp without Authorization', async () => {
      const res = await request(ctx.app, 'POST', '/mcp', {
        headers: { 'Content-Type': 'application/json' },
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(res.status).toBe(401);
    });

    it('accepts a valid X-Team-Override on /mcp (does not 401)', async () => {
      // /mcp shares resolveTeamFromRequest with REST routes, so the
      // team-resolution behaviour is covered by the REST tests above.
      // Here we verify only that the override is accepted by the auth
      // layer and the request is passed to the MCP transport.
      const res = await request(ctx.app, 'POST', '/mcp', {
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'X-Team-Override': TEAM_B_KEY,
          'X-Agent-ID': 'cross-team-agent',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        },
      });
      expect(res.status).not.toBe(401);
    });
  });
});
