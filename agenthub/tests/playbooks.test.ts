import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Playbooks API', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe('POST /api/v1/playbooks — define_playbook', () => {
    it('should define a playbook with 3 task templates', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'research-sprint',
          description: 'Standard 3-phase research workflow',
          tasks: [
            { description: 'Gather sources', role: 'researcher' },
            { description: 'Draft findings', role: 'writer' },
            { description: 'Review and publish', role: 'editor' },
          ],
        },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe('research-sprint');
      expect(data.tasks).toHaveLength(3);
      expect(data.tasks[0].role).toBe('researcher');
      expect(data.createdBy).toBe('test-agent');
    });

    it('should reject invalid depends_on_index (forward reference)', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'bad',
          description: 'bad playbook',
          tasks: [
            { description: 'A', depends_on_index: [1] },
            { description: 'B' },
          ],
        },
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/playbooks — list_playbooks', () => {
    it('should list defined playbooks', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'pb-1',
          description: 'first',
          tasks: [{ description: 'do thing' }],
        },
      });
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'pb-2',
          description: 'second',
          tasks: [{ description: 'another thing' }],
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/playbooks', { headers });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.total).toBe(2);
      expect(data.playbooks.map((p: any) => p.name).sort()).toEqual(['pb-1', 'pb-2']);
    });
  });

  describe('GET /api/v1/playbooks/:name — get_playbook', () => {
    it('should return 404 for missing playbook', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/playbooks/nonexistent', {
        headers: authHeaders(ctx.apiKey),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/playbooks/:name/run — run_playbook', () => {
    it('should create tasks from playbook templates', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'triple',
          description: 'three tasks',
          tasks: [
            { description: 'alpha' },
            { description: 'beta' },
            { description: 'gamma' },
          ],
        },
      });

      const runRes = await request(ctx.app, 'POST', '/api/v1/playbooks/triple/run', {
        headers,
      });
      expect(runRes.status).toBe(201);
      const runData = await runRes.json();
      expect(runData.created_task_ids).toHaveLength(3);

      // Verify tasks exist with open status
      const tasksRes = await request(ctx.app, 'GET', '/api/v1/tasks?status=open', { headers });
      const tasksData = await tasksRes.json();
      const descs = tasksData.tasks.map((t: any) => t.description).sort();
      expect(descs).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('should resolve depends_on_index into real task dependencies', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'chain',
          description: 'dependent tasks',
          tasks: [
            { description: 'first' },
            { description: 'second', depends_on_index: [0] },
          ],
        },
      });

      const runRes = await request(ctx.app, 'POST', '/api/v1/playbooks/chain/run', {
        headers,
      });
      const { created_task_ids } = await runRes.json();
      expect(created_task_ids).toHaveLength(2);
      const [firstId, secondId] = created_task_ids;

      // Second task should be blocked by the first — try to claim it
      const claimRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${secondId}`, {
        headers,
        body: { status: 'claimed', version: 1 },
      });
      expect(claimRes.status).toBe(400);
      const claimErr = await claimRes.json();
      expect(claimErr.message).toContain('blocked');

      // Claim + complete the first one
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${firstId}`, {
        headers,
        body: { status: 'claimed', version: 1 },
      });
      await request(ctx.app, 'PATCH', `/api/v1/tasks/${firstId}`, {
        headers,
        body: { status: 'completed', result: 'done', version: 2 },
      });

      // Now second can be claimed
      const claimAgain = await request(ctx.app, 'PATCH', `/api/v1/tasks/${secondId}`, {
        headers,
        body: { status: 'claimed', version: 1 },
      });
      expect(claimAgain.status).toBe(200);
    });
  });

  describe('template variables — {{vars.KEY}} substitution', () => {
    it('substitutes a single var into task description', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'research-any',
          description: 'research any topic',
          tasks: [{ description: 'Research topic {{vars.topic}}' }],
        },
      });

      const runRes = await request(ctx.app, 'POST', '/api/v1/playbooks/research-any/run', {
        headers,
        body: { vars: { topic: 'webhooks' } },
      });
      expect(runRes.status).toBe(201);

      const tasksRes = await request(ctx.app, 'GET', '/api/v1/tasks?status=open', { headers });
      const tasksData = await tasksRes.json();
      expect(tasksData.tasks[0].description).toContain('webhooks');
      expect(tasksData.tasks[0].description).toBe('Research topic webhooks');
    });

    it('leaves template string intact when no vars passed', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'no-vars',
          description: 'no-vars run',
          tasks: [{ description: 'Research topic {{vars.topic}}' }],
        },
      });

      const runRes = await request(ctx.app, 'POST', '/api/v1/playbooks/no-vars/run', { headers });
      expect(runRes.status).toBe(201);

      const tasksRes = await request(ctx.app, 'GET', '/api/v1/tasks?status=open', { headers });
      const tasksData = await tasksRes.json();
      expect(tasksData.tasks[0].description).toBe('Research topic {{vars.topic}}');
    });

    it('substitutes multiple vars and preserves role prefix', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'incident',
          description: 'incident response',
          tasks: [
            { description: 'Triage {{vars.title}} (sev={{vars.severity}})', role: 'oncall' },
            { description: 'Notify {{vars.stakeholder}}' },
          ],
        },
      });

      const runRes = await request(ctx.app, 'POST', '/api/v1/playbooks/incident/run', {
        headers,
        body: { vars: { title: 'DB down', severity: 'P1', stakeholder: 'eng-leads' } },
      });
      expect(runRes.status).toBe(201);

      const tasksRes = await request(ctx.app, 'GET', '/api/v1/tasks?status=open', { headers });
      const tasksData = await tasksRes.json();
      const descs = tasksData.tasks.map((t: { description: string }) => t.description).sort();
      expect(descs).toEqual([
        '[oncall] Triage DB down (sev=P1)',
        'Notify eng-leads',
      ].sort());
    });

    it('leaves unknown keys intact as template strings', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'partial',
          description: 'partial vars',
          tasks: [{ description: '{{vars.known}} and {{vars.unknown}}' }],
        },
      });

      const runRes = await request(ctx.app, 'POST', '/api/v1/playbooks/partial/run', {
        headers,
        body: { vars: { known: 'yes' } },
      });
      expect(runRes.status).toBe(201);

      const tasksRes = await request(ctx.app, 'GET', '/api/v1/tasks?status=open', { headers });
      const tasksData = await tasksRes.json();
      expect(tasksData.tasks[0].description).toBe('yes and {{vars.unknown}}');
    });
  });

  describe('upsert behavior', () => {
    it('should update existing playbook when defined with same name', async () => {
      const headers = authHeaders(ctx.apiKey);
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'upsert-pb',
          description: 'v1',
          tasks: [{ description: 'original' }],
        },
      });
      const res2 = await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers,
        body: {
          name: 'upsert-pb',
          description: 'v2',
          tasks: [
            { description: 'new-1' },
            { description: 'new-2' },
          ],
        },
      });
      expect(res2.status).toBe(201);

      const listRes = await request(ctx.app, 'GET', '/api/v1/playbooks', { headers });
      const listData = await listRes.json();
      expect(listData.total).toBe(1);
      expect(listData.playbooks[0].description).toBe('v2');
      expect(listData.playbooks[0].tasks).toHaveLength(2);
      expect(listData.playbooks[0].tasks[0].description).toBe('new-1');
    });
  });
});
