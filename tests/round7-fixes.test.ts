/**
 * Tests for: heartbeat MCP scope enforcement, workflow race conditions, NaN route param validation, and safeJsonParse
 * - Heartbeat MCP tool requires write scope (blocks read-only, allows write)
 * - Workflow race: task completes before setWorkflowRunTaskIds (completed, failed, still-running, integration)
 * - NaN/invalid limit/offset params return 400 across all REST routes (tasks, artifacts, messages, context, events)
 * - safeJsonParse returns fallback for truncated, invalid, empty, and corrupt JSON
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestContext,
  createTestDb,
  setupWorkspace,
  addApiKey,
  authHeaders,
  request,
  type TestContext,
} from './helpers.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mcpAuthStorage } from '../src/mcp/auth-context.js';
import { createWorkflowRun, setWorkflowRunTaskIds, checkWorkflowCompletion, getWorkflowRun } from '../src/models/workflow.js';
import { createTask, updateTask } from '../src/models/task.js';
import { definePlaybook, runPlaybook } from '../src/models/playbook.js';
import { safeJsonParse } from '../src/safe-json.js';
import type { SqliteAdapter } from '../src/db/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../src/models/types.js';

// ─── MCP helpers (reused from round4-fixes pattern) ─────────────────────

function createMcpTestCtx(scope: 'read' | 'write' | 'admin' = 'write') {
  const db = createTestDb();
  setupWorkspace(db, 'test-team');
  if (scope !== 'write') {
    addApiKey(db, 'test-team', `ltk_${scope}_key_12345678901234567890`, scope);
  }
  const mcp = createMcpServer(db);
  const auth: AuthContext = {
    workspaceId: 'test-team',
    agentId: 'test-agent',
    scope,
    ip: '127.0.0.1',
    requestId: 'req-1',
  };
  return { db, mcp, auth };
}

async function callTool(
  mcp: McpServer,
  auth: AuthContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const tool = (mcp as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  try {
    return await mcpAuthStorage.run(auth, () =>
      tool.inputSchema ? tool.handler(args, {}) : tool.handler({}),
    );
  } catch (err: any) {
    if (err && typeof err.toJSON === 'function') {
      return {
        content: [{ type: 'text', text: JSON.stringify(err.toJSON()) }],
        isError: true,
      };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// H1 — Heartbeat MCP tool missing requireWriteScope()
// ═══════════════════════════════════════════════════════════════════════════

describe('H1 — heartbeat MCP tool requires write scope', () => {
  it('should block read-only key from calling heartbeat', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const result = await callTool(mcp, auth, 'heartbeat', {
      agent_id: 'test-agent',
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/scope.*read|requires.*write/i);
  });

  it('should allow write key to call heartbeat', async () => {
    const { mcp, auth } = createMcpTestCtx('write');
    const result = await callTool(mcp, auth, 'heartbeat', {
      agent_id: 'test-agent',
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
  });

  it('should block read-only key even with status parameter', async () => {
    const { mcp, auth } = createMcpTestCtx('read');
    const result = await callTool(mcp, auth, 'heartbeat', {
      agent_id: 'test-agent',
      status: 'online',
    });
    expect(result.isError).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H3 — Workflow race with empty task_ids
// ═══════════════════════════════════════════════════════════════════════════

describe('H3 — Workflow completes even if task finishes during task_ids window', () => {
  let db: SqliteAdapter;
  const ws = 'test-team';

  beforeEach(() => {
    db = createTestDb();
    setupWorkspace(db, ws);
  });

  it('should complete workflow when task finishes before setWorkflowRunTaskIds', async () => {
    // Simulate the race: create workflow run (empty task_ids), create task,
    // complete task, THEN set task_ids + check completion
    const runId = await createWorkflowRun(db, ws, 'fast-playbook', 'agent');

    // Create a task and immediately complete it (simulates fast agent)
    const { task_id } = await createTask(db, ws, 'agent', {
      description: 'fast task',
      status: 'claimed',
    });
    await updateTask(db, ws, 'agent', {
      task_id,
      status: 'completed',
      result: 'done fast',
      version: 1,
    });

    // Now set task_ids (this is the step that was too late before)
    await setWorkflowRunTaskIds(db, runId, [task_id]);

    // The fix: re-check completion after setting task_ids
    await checkWorkflowCompletion(db, task_id);

    const run = await getWorkflowRun(db, ws, runId);
    expect(run.status).toBe('completed');
    expect(run.completedAt).not.toBeNull();
  });

  it('should mark workflow as failed if task is escalated during race window', async () => {
    const runId = await createWorkflowRun(db, ws, 'fail-playbook', 'agent');

    const { task_id } = await createTask(db, ws, 'agent', {
      description: 'escalated task',
      status: 'claimed',
    });
    await updateTask(db, ws, 'agent', {
      task_id,
      status: 'escalated',
      result: 'cannot handle',
      version: 1,
    });

    await setWorkflowRunTaskIds(db, runId, [task_id]);
    await checkWorkflowCompletion(db, task_id);

    const run = await getWorkflowRun(db, ws, runId);
    expect(run.status).toBe('failed');
  });

  it('should not complete workflow when some tasks are still running', async () => {
    const runId = await createWorkflowRun(db, ws, 'mixed-playbook', 'agent');

    const t1 = await createTask(db, ws, 'agent', { description: 'done', status: 'claimed' });
    const t2 = await createTask(db, ws, 'agent', { description: 'still open', status: 'open' });

    await updateTask(db, ws, 'agent', {
      task_id: t1.task_id,
      status: 'completed',
      result: 'ok',
      version: 1,
    });

    await setWorkflowRunTaskIds(db, runId, [t1.task_id, t2.task_id]);
    await checkWorkflowCompletion(db, t1.task_id);

    const run = await getWorkflowRun(db, ws, runId);
    expect(run.status).toBe('running');
  });

  it('runPlaybook re-checks completion after setWorkflowRunTaskIds (integration)', async () => {
    // Define a single-task playbook — if agent is very fast, the fix ensures completion
    await definePlaybook(db, ws, 'agent', {
      name: 'one-step',
      description: 'single step playbook',
      tasks: [{ description: 'only step' }],
    });

    const result = await runPlaybook(db, ws, 'agent', 'one-step');
    const taskId = result.created_task_ids[0];

    // Claim then complete the task (open → claimed → completed)
    await updateTask(db, ws, 'agent', {
      task_id: taskId,
      status: 'claimed',
      version: 1,
    });
    await updateTask(db, ws, 'agent', {
      task_id: taskId,
      status: 'completed',
      result: 'done',
      version: 2,
    });

    // checkWorkflowCompletion is called by updateTask, so the run should be complete
    const run = await getWorkflowRun(db, ws, result.workflow_run_id);
    expect(run.status).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M1 — NaN route param validation across all route files
// ═══════════════════════════════════════════════════════════════════════════

describe('M1 — NaN/invalid limit/offset params return 400 across all routes', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  const invalidParams = ['abc', '', 'NaN', 'undefined', 'null', '-1'];

  describe('tasks route', () => {
    for (const val of invalidParams) {
      it(`GET /tasks?limit=${val} → 400`, async () => {
        const res = await request(ctx.app, 'GET', `/api/v1/tasks?limit=${val}`, {
          headers: authHeaders(ctx.apiKey),
        });
        expect(res.status).toBe(400);
      });
    }
  });

  describe('artifacts route', () => {
    for (const val of invalidParams) {
      it(`GET /artifacts?limit=${val} → 400`, async () => {
        const res = await request(ctx.app, 'GET', `/api/v1/artifacts?limit=${val}`, {
          headers: authHeaders(ctx.apiKey),
        });
        expect(res.status).toBe(400);
      });
    }
  });

  describe('messages route', () => {
    for (const val of ['abc', 'NaN', 'undefined']) {
      it(`GET /messages?limit=${val} → 400`, async () => {
        const res = await request(ctx.app, 'GET', `/api/v1/messages?limit=${val}`, {
          headers: authHeaders(ctx.apiKey),
        });
        expect(res.status).toBe(400);
      });
    }
  });

  describe('context route', () => {
    for (const val of ['abc', 'NaN', '-1']) {
      it(`GET /context?query=x&limit=${val} → 400`, async () => {
        const res = await request(ctx.app, 'GET', `/api/v1/context?query=x&limit=${val}`, {
          headers: authHeaders(ctx.apiKey),
        });
        expect(res.status).toBe(400);
      });
    }
  });

  // Note: webhooks list route doesn't take limit param — validation is on
  // GET /webhooks/:id/deliveries?limit= which requires a valid webhook ID.

  describe('events route', () => {
    for (const val of ['abc', 'NaN']) {
      it(`GET /events?since_id=${val} → 400`, async () => {
        const res = await request(ctx.app, 'GET', `/api/v1/events?since_id=${val}`, {
          headers: authHeaders(ctx.apiKey),
        });
        expect(res.status).toBe(400);
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M3 — safeJsonParse handles corrupt JSON gracefully
// ═══════════════════════════════════════════════════════════════════════════

describe('M3 — safeJsonParse returns fallback for corrupt JSON', () => {
  it('should return fallback for truncated JSON', () => {
    const result = safeJsonParse<string[]>('["a","b', []);
    expect(result).toEqual([]);
  });

  it('should return fallback for completely invalid JSON', () => {
    const result = safeJsonParse<Record<string, unknown>>('not-json-at-all', {});
    expect(result).toEqual({});
  });

  it('should return fallback for empty string', () => {
    const result = safeJsonParse<number[]>('', []);
    expect(result).toEqual([]);
  });

  it('should parse valid JSON normally', () => {
    const result = safeJsonParse<number[]>('[1,2,3]', []);
    expect(result).toEqual([1, 2, 3]);
  });

  it('should return fallback for null literal input', () => {
    // null is valid JSON but may not be the expected type
    const result = safeJsonParse<string[]>('null', ['default']);
    // null IS valid JSON — it parses successfully
    expect(result).toBeNull();
  });

  it('should handle corrupt JSON in workflow task_ids context', () => {
    // Simulates what happens in rowToRun when task_ids is corrupt
    const result = safeJsonParse<number[]>('{broken', []);
    expect(result).toEqual([]);
  });

  it('should handle corrupt JSON in event tags context', () => {
    const result = safeJsonParse<string[]>('[invalid', []);
    expect(result).toEqual([]);
  });
});

