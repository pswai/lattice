import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, request, TEST_ADMIN_KEY, type TestContext } from './helpers.js';

function adminHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_ADMIN_KEY}`,
    'Content-Type': 'application/json',
  };
}

describe('Admin API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /admin/teams', () => {
    it('should create a new team with auto-generated API key', async () => {
      const res = await request(ctx.app, 'POST', '/admin/teams', {
        headers: adminHeaders(),
        body: { id: 'new-team', name: 'New Team' },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.team_id).toBe('new-team');
      expect(data.api_key).toMatch(/^lt_/);
    });

    it('should reject duplicate team IDs', async () => {
      await request(ctx.app, 'POST', '/admin/teams', {
        headers: adminHeaders(),
        body: { id: 'dup-team', name: 'First' },
      });

      const res = await request(ctx.app, 'POST', '/admin/teams', {
        headers: adminHeaders(),
        body: { id: 'dup-team', name: 'Second' },
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid team ID format', async () => {
      const res = await request(ctx.app, 'POST', '/admin/teams', {
        headers: adminHeaders(),
        body: { id: 'Invalid Team!', name: 'Bad' },
      });

      expect(res.status).toBe(400);
    });

    it('should reject requests without admin key', async () => {
      const res = await request(ctx.app, 'POST', '/admin/teams', {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' },
        body: { id: 'sneaky', name: 'Sneaky' },
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/teams', () => {
    it('should list all teams', async () => {
      const res = await request(ctx.app, 'GET', '/admin/teams', {
        headers: adminHeaders(),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      // Should have at least the test team
      expect(data.teams.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /admin/teams/:id/keys', () => {
    it('should create a new API key for an existing team', async () => {
      const res = await request(ctx.app, 'POST', `/admin/teams/${ctx.teamId}/keys`, {
        headers: adminHeaders(),
        body: { label: 'ci-key' },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.api_key).toMatch(/^lt_/);
      expect(data.label).toBe('ci-key');
    });

    it('should 404 for non-existent team', async () => {
      const res = await request(ctx.app, 'POST', '/admin/teams/nonexistent/keys', {
        headers: adminHeaders(),
        body: {},
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/stats', () => {
    it('should return system stats', async () => {
      const res = await request(ctx.app, 'GET', '/admin/stats', {
        headers: adminHeaders(),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('teams');
      expect(data).toHaveProperty('active_agents');
      expect(data).toHaveProperty('context_entries');
      expect(data).toHaveProperty('events');
      expect(data).toHaveProperty('tasks');
    });
  });
});
