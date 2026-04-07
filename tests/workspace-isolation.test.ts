import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestContext,
  authHeaders,
  request,
  setupWorkspace,
  addApiKey,
  type TestContext,
} from './helpers.js';

/**
 * Workspace isolation tests — verify that data NEVER leaks between workspaces.
 *
 * Strategy: create two workspaces (A and B) with separate API keys, then for
 * every resource type assert that workspace B cannot see workspace A's data.
 */

describe('Workspace isolation', () => {
  let ctx: TestContext;
  let keyA: string;
  let keyB: string;

  beforeEach(() => {
    ctx = createTestContext('workspace-a', 'ltk_workspace_a_key_12345678901234');
    keyA = ctx.apiKey;

    // Set up workspace B in the same DB
    const teamB = setupWorkspace(ctx.db, 'workspace-b', 'ltk_workspace_b_key_12345678901234');
    keyB = teamB.apiKey;
  });

  // -----------------------------------------------------------------------
  // Tasks
  // -----------------------------------------------------------------------
  describe('Tasks', () => {
    it('workspace B cannot see workspace A tasks', async () => {
      // Create task in A
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { description: 'Secret task in A' },
      });
      expect(createRes.status).toBe(201);

      // List tasks in B — should be empty
      const listRes = await request(ctx.app, 'GET', '/api/v1/tasks', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { tasks } = await listRes.json();
      expect(tasks).toHaveLength(0);
    });

    it('workspace B cannot update workspace A task', async () => {
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { description: 'Protected task' },
      });
      const { task_id } = await createRes.json();

      const patchRes = await request(ctx.app, 'PATCH', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(keyB, 'agent-b'),
        body: { status: 'completed', result: 'Stolen!', version: 1 },
      });
      expect(patchRes.status).toBe(404);
    });

    it('workspace B cannot get workspace A task by ID', async () => {
      const createRes = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { description: 'Private task' },
      });
      const { task_id } = await createRes.json();

      const getRes = await request(ctx.app, 'GET', `/api/v1/tasks/${task_id}`, {
        headers: authHeaders(keyB, 'agent-b'),
      });
      expect(getRes.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------
  describe('Events', () => {
    it('workspace B cannot see workspace A events', async () => {
      // Broadcast in A
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { event_type: 'BROADCAST', message: 'Secret broadcast from A', tags: ['private'] },
      });

      // Poll events in B
      const res = await request(ctx.app, 'GET', '/api/v1/events', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { events } = await res.json();
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Context
  // -----------------------------------------------------------------------
  describe('Context', () => {
    it('workspace B cannot find workspace A context entries', async () => {
      // Save context in A
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { key: 'secret-finding', value: 'Confidential data from A', tags: ['secret'] },
      });

      // Search in B
      const res = await request(ctx.app, 'GET', '/api/v1/context?query=confidential', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { entries } = await res.json();
      expect(entries).toHaveLength(0);
    });

    it('workspace B cannot find workspace A context by tag', async () => {
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { key: 'tagged-entry', value: 'Some data', tags: ['shared-tag'] },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/context?tags=shared-tag', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { entries } = await res.json();
      expect(entries).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Artifacts
  // -----------------------------------------------------------------------
  describe('Artifacts', () => {
    it('workspace B cannot list workspace A artifacts', async () => {
      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          key: 'report-a',
          content_type: 'text/plain',
          content: 'Confidential report',
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/artifacts', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { artifacts } = await res.json();
      expect(artifacts).toHaveLength(0);
    });

    it('workspace B cannot get workspace A artifact by key', async () => {
      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          key: 'secret-artifact',
          content_type: 'application/json',
          content: '{"secret": true}',
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/artifacts/secret-artifact', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Messages
  // -----------------------------------------------------------------------
  describe('Messages', () => {
    it('workspace B cannot see workspace A messages', async () => {
      // Send message in A
      await request(ctx.app, 'POST', '/api/v1/messages', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { to: 'agent-a2', message: 'Private message in A', tags: [] },
      });

      // Get messages in B (as agent-a2 in B's workspace)
      const res = await request(ctx.app, 'GET', '/api/v1/messages', {
        headers: authHeaders(keyB, 'agent-a2'),
      });
      const data = await res.json();
      expect(data.messages).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Agents
  // -----------------------------------------------------------------------
  describe('Agents', () => {
    it('workspace B cannot see workspace A agents', async () => {
      // Register agent in A
      await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          agent_id: 'agent-a',
          capabilities: ['coding', 'testing'],
          status: 'online',
        },
      });

      // List agents in B
      const res = await request(ctx.app, 'GET', '/api/v1/agents', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { agents } = await res.json();
      const aAgents = agents.filter((a: any) => a.agentId === 'agent-a');
      expect(aAgents).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Playbooks
  // -----------------------------------------------------------------------
  describe('Playbooks', () => {
    it('workspace B cannot see workspace A playbooks', async () => {
      // Define playbook in A
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          name: 'secret-pipeline',
          description: 'A confidential pipeline',
          tasks: [{ description: 'Step 1', role: 'engineer' }],
        },
      });

      // List playbooks in B
      const res = await request(ctx.app, 'GET', '/api/v1/playbooks', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { playbooks } = await res.json();
      expect(playbooks).toHaveLength(0);
    });

    it('workspace B cannot run workspace A playbook', async () => {
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          name: 'private-playbook',
          description: 'Should not be runnable from B',
          tasks: [{ description: 'Do something', role: 'worker' }],
        },
      });

      const res = await request(ctx.app, 'POST', '/api/v1/playbooks/private-playbook/run', {
        headers: authHeaders(keyB, 'agent-b'),
        body: {},
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Profiles
  // -----------------------------------------------------------------------
  describe('Profiles', () => {
    it('workspace B cannot see workspace A profiles', async () => {
      await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          name: 'lead-engineer',
          description: 'Lead engineer role',
          system_prompt: 'You are a lead engineer.',
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/profiles', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { profiles } = await res.json();
      expect(profiles).toHaveLength(0);
    });

    it('workspace B cannot get workspace A profile by name', async () => {
      await request(ctx.app, 'POST', '/api/v1/profiles', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          name: 'secret-role',
          description: 'Confidential',
          system_prompt: 'Secret prompt',
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/profiles/secret-role', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Audit Log (via admin API — workspace-scoped queries)
  // -----------------------------------------------------------------------
  describe('Audit log', () => {
    it('admin audit query scopes results to workspace_id', async () => {
      // Create data in both workspaces to generate audit entries
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { description: 'Audit test task A' },
      });
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(keyB, 'agent-b'),
        body: { description: 'Audit test task B' },
      });

      // Query audit for workspace A only — should not include B's entries
      const res = await request(ctx.app, 'GET', '/admin/audit-log?workspace_id=workspace-a', {
        headers: { Authorization: 'Bearer test-admin-key-secret' },
      });
      expect(res.status).toBe(200);
      const { items } = await res.json();
      for (const item of items) {
        expect(item.workspace_id).toBe('workspace-a');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Inbound endpoint key lookup
  // -----------------------------------------------------------------------
  describe('Inbound endpoint keys', () => {
    it('endpoint_key lookup returns endpoint regardless of workspace (documents bug)', async () => {
      // Define inbound endpoint in workspace A
      const createRes = await request(ctx.app, 'POST', '/api/v1/inbound', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          name: 'github-webhook',
          action_type: 'create_task',
          action_config: { description_template: 'Webhook: {{body.title}}' },
        },
      });
      expect(createRes.status).toBe(201);
      const { endpoint_key } = await createRes.json();

      // The public receiver route uses endpoint_key directly — no workspace check.
      // This means workspace B (or anyone) can trigger workspace A's endpoint
      // if they know the key. This test documents the current behavior.
      const triggerRes = await request(ctx.app, 'POST', `/api/v1/inbound/${endpoint_key}`, {
        headers: { 'Content-Type': 'application/json' },
        body: { title: 'Cross-workspace trigger' },
      });
      // The endpoint is found and processed — this is the current behavior
      expect(triggerRes.status).toBeLessThan(500);
    });

    it('workspace B cannot list workspace A inbound endpoints', async () => {
      await request(ctx.app, 'POST', '/api/v1/inbound', {
        headers: authHeaders(keyA, 'agent-a'),
        body: {
          name: 'private-endpoint',
          action_type: 'broadcast_event',
        },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/inbound', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      const { endpoints } = await res.json();
      expect(endpoints).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // API key scope enforcement
  // -----------------------------------------------------------------------
  describe('API key scope enforcement', () => {
    it('read-only key cannot create tasks', async () => {
      const readKey = 'ltk_readonly_key_123456789012345678';
      addApiKey(ctx.db, 'workspace-a', readKey, 'read');

      const res = await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(readKey, 'agent-readonly'),
        body: { description: 'Should be forbidden' },
      });
      expect(res.status).toBe(403);
    });

    it('read-only key cannot save context', async () => {
      const readKey = 'ltk_readonly_ctx_123456789012345678';
      addApiKey(ctx.db, 'workspace-a', readKey, 'read');

      const res = await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(readKey, 'agent-readonly'),
        body: { key: 'test', value: 'forbidden', tags: [] },
      });
      expect(res.status).toBe(403);
    });

    it('read-only key cannot broadcast events', async () => {
      const readKey = 'ltk_readonly_evt_123456789012345678';
      addApiKey(ctx.db, 'workspace-a', readKey, 'read');

      const res = await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(readKey, 'agent-readonly'),
        body: { event_type: 'BROADCAST', message: 'Forbidden', tags: [] },
      });
      expect(res.status).toBe(403);
    });

    it('read-only key CAN list tasks', async () => {
      const readKey = 'ltk_readonly_get_123456789012345678';
      addApiKey(ctx.db, 'workspace-a', readKey, 'read');

      // Create a task with the write key first
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { description: 'Visible to readers' },
      });

      const res = await request(ctx.app, 'GET', '/api/v1/tasks', {
        headers: authHeaders(readKey, 'agent-readonly'),
      });
      expect(res.status).toBe(200);
      const { tasks } = await res.json();
      expect(tasks.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Export only returns own workspace data
  // -----------------------------------------------------------------------
  describe('Export isolation', () => {
    it('export only returns own workspace data', async () => {
      // Create data in both workspaces
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { description: 'Task in A' },
      });
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(keyB, 'agent-b'),
        body: { description: 'Task in B' },
      });
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(keyA, 'agent-a'),
        body: { key: 'ctx-a', value: 'A data', tags: [] },
      });
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(keyB, 'agent-b'),
        body: { key: 'ctx-b', value: 'B data', tags: [] },
      });

      // Export workspace A
      const resA = await request(ctx.app, 'GET', '/api/v1/export', {
        headers: authHeaders(keyA, 'agent-a'),
      });
      expect(resA.status).toBe(200);
      const exportA = await resA.json();

      // Verify tasks only contain A's
      const taskDescs = exportA.tasks.map((t: any) => t.description);
      expect(taskDescs).toContain('Task in A');
      expect(taskDescs).not.toContain('Task in B');

      // Verify context only contains A's
      const ctxKeys = exportA.context_entries.map((c: any) => c.key);
      expect(ctxKeys).toContain('ctx-a');
      expect(ctxKeys).not.toContain('ctx-b');

      // Export workspace B
      const resB = await request(ctx.app, 'GET', '/api/v1/export', {
        headers: authHeaders(keyB, 'agent-b'),
      });
      expect(resB.status).toBe(200);
      const exportB = await resB.json();

      const taskDescsB = exportB.tasks.map((t: any) => t.description);
      expect(taskDescsB).toContain('Task in B');
      expect(taskDescsB).not.toContain('Task in A');
    });
  });
});
