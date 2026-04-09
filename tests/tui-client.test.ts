/**
 * TUI REST client — unit tests with mocked fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LatticeClient } from '../src/tui/client.js';

// ── Helpers ──────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('LatticeClient', () => {
  const originalFetch = globalThis.fetch;
  let client: LatticeClient;

  beforeEach(() => {
    client = new LatticeClient({ baseUrl: 'http://localhost:3000', apiKey: 'lt_test123' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', () => {
      const c = new LatticeClient({ baseUrl: 'http://host:3000/', apiKey: 'k' });
      expect(c.sseUrl()).toBe('http://host:3000/api/v1/events/stream');
    });

    it('preserves baseUrl without trailing slash', () => {
      expect(client.sseUrl()).toBe('http://localhost:3000/api/v1/events/stream');
    });
  });

  describe('authHeaders', () => {
    it('includes Bearer token', () => {
      expect(client.authHeaders['Authorization']).toBe('Bearer lt_test123');
    });

    it('includes Content-Type', () => {
      expect(client.authHeaders['Content-Type']).toBe('application/json');
    });
  });

  describe('health', () => {
    it('returns true on 200', async () => {
      globalThis.fetch = mockFetch({ status: 'ok' });
      expect(await client.health()).toBe(true);
    });

    it('returns false on non-200', async () => {
      globalThis.fetch = mockFetch({}, 500);
      expect(await client.health()).toBe(false);
    });

    it('returns false on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await client.health()).toBe(false);
    });
  });

  describe('listTasks', () => {
    it('calls GET /tasks with no params when no filters', async () => {
      const body = { tasks: [], total: 0 };
      globalThis.fetch = mockFetch(body);

      const result = await client.listTasks();
      expect(result).toEqual(body);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/tasks',
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    it('appends query params from filters', async () => {
      globalThis.fetch = mockFetch({ tasks: [], total: 0 });

      await client.listTasks({ status: 'open', limit: 10 });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('status=open');
      expect(url).toContain('limit=10');
    });

    it('omits undefined filter values', async () => {
      globalThis.fetch = mockFetch({ tasks: [], total: 0 });

      await client.listTasks({ status: 'claimed', claimed_by: undefined });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('status=claimed');
      expect(url).not.toContain('claimed_by');
    });
  });

  describe('getTask', () => {
    it('calls GET /tasks/:id', async () => {
      const task = { id: 42, description: 'test', status: 'open' };
      globalThis.fetch = mockFetch(task);

      const result = await client.getTask(42);
      expect(result).toEqual(task);
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toBe('http://localhost:3000/api/v1/tasks/42');
    });
  });

  describe('createTask', () => {
    it('calls POST /tasks with description', async () => {
      globalThis.fetch = mockFetch({ task_id: 1, status: 'claimed', claimed_by: 'tui' });

      const result = await client.createTask('Fix bug');
      expect(result.task_id).toBe(1);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/tasks',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Fix bug'),
        }),
      );
    });

    it('includes optional parameters', async () => {
      globalThis.fetch = mockFetch({ task_id: 2, status: 'open', claimed_by: null });

      await client.createTask('Task', { priority: 'P0', status: 'open', assigned_to: 'agent-1' });
      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.priority).toBe('P0');
      expect(body.status).toBe('open');
      expect(body.assigned_to).toBe('agent-1');
    });
  });

  describe('updateTask', () => {
    it('calls PATCH /tasks/:id', async () => {
      globalThis.fetch = mockFetch({ task_id: 5, status: 'completed', version: 3 });

      const result = await client.updateTask(5, 'completed', 2, { result: 'done' });
      expect(result.version).toBe(3);

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('http://localhost:3000/api/v1/tasks/5');
      expect(opts.method).toBe('PATCH');
      const body = JSON.parse(opts.body);
      expect(body.status).toBe('completed');
      expect(body.version).toBe(2);
      expect(body.result).toBe('done');
    });
  });

  describe('listEvents', () => {
    it('calls GET /events with filters', async () => {
      globalThis.fetch = mockFetch({ events: [], cursor: 0 });

      await client.listEvents({ event_type: 'ERROR', limit: 50 });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('event_type=ERROR');
      expect(url).toContain('limit=50');
    });
  });

  describe('listAgents', () => {
    it('calls GET /agents', async () => {
      const data = { agents: [{ id: 'a1', status: 'online' }] };
      globalThis.fetch = mockFetch(data);

      const result = await client.listAgents();
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].id).toBe('a1');
    });

    it('passes capability filter', async () => {
      globalThis.fetch = mockFetch({ agents: [] });

      await client.listAgents({ capability: 'code-review' });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('capability=code-review');
    });
  });

  describe('searchContext', () => {
    it('includes query in params', async () => {
      globalThis.fetch = mockFetch({ entries: [], total: 0 });

      await client.searchContext('auth bug');
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('query=auth+bug');
    });

    it('includes tags and limit', async () => {
      globalThis.fetch = mockFetch({ entries: [], total: 0 });

      await client.searchContext('test', { tags: ['a', 'b'], limit: 10 });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('tags=a%2Cb');
      expect(url).toContain('limit=10');
    });
  });

  describe('getAnalytics', () => {
    it('passes window param', async () => {
      globalThis.fetch = mockFetch({ tasks: {}, events: {}, agents: {}, context: {} });

      await client.getAnalytics('7d');
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('window=7d');
    });

    it('omits window when not provided', async () => {
      globalThis.fetch = mockFetch({ tasks: {}, events: {}, agents: {}, context: {} });

      await client.getAnalytics();
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toBe('http://localhost:3000/api/v1/analytics');
    });
  });

  describe('error handling', () => {
    it('throws on non-2xx GET responses', async () => {
      globalThis.fetch = mockFetch({ error: 'not found' }, 404);

      await expect(client.listTasks()).rejects.toThrow('GET /tasks: 404');
    });

    it('throws on non-2xx POST responses', async () => {
      globalThis.fetch = mockFetch({ error: 'bad request' }, 400);

      await expect(client.createTask('test')).rejects.toThrow('POST /tasks: 400');
    });

    it('throws on non-2xx PATCH responses', async () => {
      globalThis.fetch = mockFetch({ error: 'conflict' }, 409);

      await expect(client.updateTask(1, 'completed', 1)).rejects.toThrow('PATCH /tasks/1: 409');
    });
  });

  describe('listPlaybooks', () => {
    it('calls GET /playbooks', async () => {
      const data = { playbooks: [{ id: 1, name: 'deploy', taskCount: 3 }] };
      globalThis.fetch = mockFetch(data);

      const result = await client.listPlaybooks();
      expect(result.playbooks[0].name).toBe('deploy');
    });
  });

  describe('runPlaybook', () => {
    it('calls POST /playbooks/run with name and variables', async () => {
      globalThis.fetch = mockFetch({ workflow_run_id: 1, task_ids: [10, 11] });

      const result = await client.runPlaybook('deploy', { ENV: 'prod' });
      expect(result.workflow_run_id).toBe(1);

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.name).toBe('deploy');
      expect(body.variables.ENV).toBe('prod');
    });
  });

  describe('listWorkflowRuns', () => {
    it('passes limit', async () => {
      globalThis.fetch = mockFetch({ runs: [] });

      await client.listWorkflowRuns({ limit: 5 });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('limit=5');
    });
  });

  describe('listArtifacts', () => {
    it('passes content_type filter', async () => {
      globalThis.fetch = mockFetch({ artifacts: [], total: 0 });

      await client.listArtifacts({ content_type: 'text/markdown' });
      const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('content_type=text%2Fmarkdown');
    });
  });
});
