import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, setupTeam, type TestContext } from './helpers.js';

describe('Authentication', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should return 200 with valid API key', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=test', {
      headers: authHeaders(ctx.apiKey),
    });

    expect(res.status).toBe(200);
  });

  it('should return 401 with invalid API key', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=test', {
      headers: authHeaders('ltk_invalid_key_12345678901234567890'),
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('UNAUTHORIZED');
  });

  it('should return 401 with missing Authorization header', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=test', {
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(401);
  });

  it('should return 401 with non-Bearer auth scheme', async () => {
    const res = await request(ctx.app, 'GET', '/api/v1/context?query=test', {
      headers: {
        Authorization: `Basic ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    expect(res.status).toBe(401);
  });

  it('should default agent ID to anonymous when X-Agent-ID is missing', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/events', {
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        event_type: 'BROADCAST',
        message: 'Test event without agent id',
        tags: [],
      },
    });

    expect(res.status).toBe(201);

    // Check the event was created with 'anonymous' agent
    const eventsRes = await request(ctx.app, 'GET', '/api/v1/events', {
      headers: authHeaders(ctx.apiKey),
    });
    const data = await eventsRes.json();
    const event = data.events.find((e: any) => e.message === 'Test event without agent id');
    expect(event.createdBy).toBe('anonymous');
  });

  it('should not require auth for health check', async () => {
    const res = await request(ctx.app, 'GET', '/health');

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  describe('Team isolation', () => {
    it('should prevent team A from seeing team B data', async () => {
      // Set up team B
      const teamBKey = 'ltk_teamb_key_12345678901234567890';
      setupTeam(ctx.db, 'team-b', teamBKey);

      // Team A saves context
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: { key: 'team-a-secret', value: 'Team A data', tags: ['private'] },
      });

      // Team B tries to search for it
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=team', {
        headers: authHeaders(teamBKey, 'agent-b'),
      });

      const data = await res.json();
      expect(data.entries).toHaveLength(0);
    });

    it('should prevent team A from seeing team B events', async () => {
      const teamBKey = 'ltk_teamb_key_12345678901234567890';
      setupTeam(ctx.db, 'team-b', teamBKey);

      // Team A broadcasts event
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: { event_type: 'BROADCAST', message: 'Team A event', tags: [] },
      });

      // Team B polls events
      const res = await request(ctx.app, 'GET', '/api/v1/events', {
        headers: authHeaders(teamBKey, 'agent-b'),
      });

      const data = await res.json();
      expect(data.events).toHaveLength(0);
    });

    it('should prevent team A from seeing team B tasks', async () => {
      const teamBKey = 'ltk_teamb_key_12345678901234567890';
      setupTeam(ctx.db, 'team-b', teamBKey);

      // Team A creates task
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey, 'agent-a'),
        body: { description: 'Team A task' },
      });
      const { task_id } = await createRes.json();

      // Team B tries to update the task
      const res = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(teamBKey, 'agent-b'),
        body: { status: 'completed', result: 'Stolen', version: 1 },
      });

      expect(res.status).toBe(404);
    });
  });
});
