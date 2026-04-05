import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';
import { autoRegisterAgent } from '../src/models/agent.js';

describe('MCP Tools — list_tasks & get_task', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  // Helper to create a task via HTTP (shared model layer with MCP)
  async function createTask(description: string, opts: { status?: string; agentId?: string } = {}) {
    const headers = authHeaders(ctx.apiKey, opts.agentId);
    const body: Record<string, unknown> = { description };
    if (opts.status) body.status = opts.status;
    const res = await request(ctx.app, 'POST', '/api/v1/tasks', { headers, body });
    return res.json();
  }

  describe('GET /api/v1/tasks — list_tasks', () => {
    it('should return empty list when no tasks exist', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('should list all tasks for the team', async () => {
      await createTask('Task A');
      await createTask('Task B');
      await createTask('Task C');

      const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tasks).toHaveLength(3);
      expect(data.total).toBe(3);
    });

    it('should filter by status', async () => {
      await createTask('Claimed task');
      await createTask('Open task', { status: 'open' });

      const res = await request(ctx.app, 'GET', '/api/v1/tasks?status=open', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].description).toBe('Open task');
      expect(data.tasks[0].status).toBe('open');
    });

    it('should filter by claimed_by', async () => {
      await createTask('Agent A task', { agentId: 'agent-a' });
      await createTask('Agent B task', { agentId: 'agent-b' });

      const res = await request(ctx.app, 'GET', '/api/v1/tasks?claimed_by=agent-a', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].description).toBe('Agent A task');
    });

    it('should respect limit parameter', async () => {
      await createTask('Task 1');
      await createTask('Task 2');
      await createTask('Task 3');

      const res = await request(ctx.app, 'GET', '/api/v1/tasks?limit=2', {
        headers: authHeaders(ctx.apiKey),
      });

      const data = await res.json();
      expect(data.tasks).toHaveLength(2);
    });
  });

  describe('GET /api/v1/tasks/:id — get_task', () => {
    it('should return a single task by ID', async () => {
      const created = await createTask('Specific task');

      const res = await request(ctx.app, 'GET', `/api/v1/tasks/${created.task_id}`, {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(200);
      const task = await res.json();
      expect(task.id).toBe(created.task_id);
      expect(task.description).toBe('Specific task');
      expect(task.status).toBe('claimed');
      expect(task.version).toBe(1);
    });

    it('should return 404 for non-existent task', async () => {
      const res = await request(ctx.app, 'GET', '/api/v1/tasks/9999', {
        headers: authHeaders(ctx.apiKey),
      });

      expect(res.status).toBe(404);
    });
  });
});

describe('Auto-registration', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('should auto-register an unknown agent on first MCP tool call', () => {
    // Directly test the autoRegisterAgent helper
    autoRegisterAgent(ctx.db, ctx.teamId, 'new-agent');

    const row = ctx.db.prepare(
      'SELECT * FROM agents WHERE team_id = ? AND id = ?',
    ).get(ctx.teamId, 'new-agent') as any;

    expect(row).toBeDefined();
    expect(row.id).toBe('new-agent');
    expect(row.status).toBe('online');
    expect(JSON.parse(row.capabilities)).toEqual([]);
  });

  it('should update last_heartbeat for an already-registered agent', () => {
    // First register with capabilities
    ctx.db.prepare(`
      INSERT INTO agents (id, team_id, capabilities, status, metadata, last_heartbeat)
      VALUES (?, ?, '["python"]', 'busy', '{}', '2020-01-01T00:00:00.000Z')
    `).run('existing-agent', ctx.teamId);

    autoRegisterAgent(ctx.db, ctx.teamId, 'existing-agent');

    const row = ctx.db.prepare(
      'SELECT * FROM agents WHERE team_id = ? AND id = ?',
    ).get(ctx.teamId, 'existing-agent') as any;

    // Should NOT overwrite capabilities or status — only update heartbeat
    expect(JSON.parse(row.capabilities)).toEqual(['python']);
    expect(row.status).toBe('busy');
    expect(row.last_heartbeat).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('should be idempotent — calling multiple times does not error', () => {
    autoRegisterAgent(ctx.db, ctx.teamId, 'repeat-agent');
    autoRegisterAgent(ctx.db, ctx.teamId, 'repeat-agent');
    autoRegisterAgent(ctx.db, ctx.teamId, 'repeat-agent');

    const rows = ctx.db.prepare(
      'SELECT * FROM agents WHERE team_id = ? AND id = ?',
    ).all(ctx.teamId, 'repeat-agent');

    expect(rows).toHaveLength(1);
  });
});
