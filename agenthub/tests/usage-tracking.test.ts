import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestContext,
  createTestAdapter,
  setupWorkspace,
  authHeaders,
  request,
  testConfig,
} from './helpers.js';
import {
  setUsageTracking,
  getUsage,
  incrementUsageForced,
} from '../src/models/usage.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { TestContext } from './helpers.js';
import type { Hono } from 'hono';

/**
 * Usage tracking and quota enforcement tests.
 *
 * Covers: storage byte tracking for context/artifacts, exec counting,
 * API call counting on REST, quota soft/hard enforcement, and the
 * documented MCP quota bypass.
 */

describe('Usage tracking', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    setUsageTracking(true);
  });

  afterEach(() => {
    setUsageTracking(false);
  });

  // -----------------------------------------------------------------------
  // Storage tracking — context
  // -----------------------------------------------------------------------
  describe('Storage tracking (context)', () => {
    it('save_context with new key increases storage_bytes', async () => {
      const value = 'Hello, this is a test context value';
      const expectedBytes = Buffer.byteLength(value, 'utf8');

      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'storage-test', value, tags: [] },
      });

      const usage = await getUsage(ctx.db, ctx.workspaceId);
      expect(usage.storageBytes).toBe(expectedBytes);
    });

    it('update with larger value increases storage_bytes by delta', async () => {
      const smallValue = 'small';
      const largeValue = 'this is a much larger value than before';
      const smallBytes = Buffer.byteLength(smallValue, 'utf8');
      const largeBytes = Buffer.byteLength(largeValue, 'utf8');
      const expectedDelta = largeBytes - smallBytes;

      // Save initial
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'delta-test', value: smallValue, tags: [] },
      });

      const usageAfterFirst = await getUsage(ctx.db, ctx.workspaceId);
      expect(usageAfterFirst.storageBytes).toBe(smallBytes);

      // Update with larger value
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'delta-test', value: largeValue, tags: [] },
      });

      const usageAfterUpdate = await getUsage(ctx.db, ctx.workspaceId);
      expect(usageAfterUpdate.storageBytes).toBe(smallBytes + expectedDelta);
    });

    it('update with smaller value does NOT decrease storage_bytes (delta <= 0 skipped)', async () => {
      const largeValue = 'this is a large value for the first save';
      const smallValue = 'tiny';
      const largeBytes = Buffer.byteLength(largeValue, 'utf8');

      // Save large value first
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'shrink-test', value: largeValue, tags: [] },
      });

      const usageAfterFirst = await getUsage(ctx.db, ctx.workspaceId);
      expect(usageAfterFirst.storageBytes).toBe(largeBytes);

      // Update with smaller value — storage should NOT decrease
      await request(ctx.app, 'POST', '/api/v1/context', {
        headers: authHeaders(ctx.apiKey),
        body: { key: 'shrink-test', value: smallValue, tags: [] },
      });

      const usageAfterShrink = await getUsage(ctx.db, ctx.workspaceId);
      expect(usageAfterShrink.storageBytes).toBe(largeBytes);
    });
  });

  // -----------------------------------------------------------------------
  // Storage tracking — artifacts
  // -----------------------------------------------------------------------
  describe('Storage tracking (artifacts)', () => {
    it('save_artifact increases storage_bytes by content size', async () => {
      const content = '{"report": "quarterly results", "data": [1, 2, 3]}';
      const expectedBytes = Buffer.byteLength(content, 'utf8');

      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'artifact-storage-test',
          content_type: 'application/json',
          content,
        },
      });

      const usage = await getUsage(ctx.db, ctx.workspaceId);
      expect(usage.storageBytes).toBe(expectedBytes);
    });

    it('update artifact tracks delta correctly', async () => {
      const smallContent = '{"v": 1}';
      const largeContent = '{"v": 2, "extra": "lots of additional data here"}';
      const smallBytes = Buffer.byteLength(smallContent, 'utf8');
      const largeBytes = Buffer.byteLength(largeContent, 'utf8');

      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'artifact-delta',
          content_type: 'application/json',
          content: smallContent,
        },
      });

      const usageFirst = await getUsage(ctx.db, ctx.workspaceId);
      expect(usageFirst.storageBytes).toBe(smallBytes);

      // Update with larger content
      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'artifact-delta',
          content_type: 'application/json',
          content: largeContent,
        },
      });

      const usageSecond = await getUsage(ctx.db, ctx.workspaceId);
      expect(usageSecond.storageBytes).toBe(smallBytes + (largeBytes - smallBytes));
    });

    it('update artifact with smaller content does NOT decrease storage', async () => {
      const largeContent = 'A'.repeat(1000);
      const smallContent = 'B';
      const largeBytes = Buffer.byteLength(largeContent, 'utf8');

      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'artifact-shrink',
          content_type: 'text/plain',
          content: largeContent,
        },
      });

      await request(ctx.app, 'POST', '/api/v1/artifacts', {
        headers: authHeaders(ctx.apiKey),
        body: {
          key: 'artifact-shrink',
          content_type: 'text/plain',
          content: smallContent,
        },
      });

      const usage = await getUsage(ctx.db, ctx.workspaceId);
      expect(usage.storageBytes).toBe(largeBytes);
    });
  });

  // -----------------------------------------------------------------------
  // Exec counting
  // -----------------------------------------------------------------------
  describe('Exec counting', () => {
    it('create_task increments exec_count', async () => {
      await request(ctx.app, 'POST', '/api/v1/tasks', {
        headers: authHeaders(ctx.apiKey),
        body: { description: 'Exec count test' },
      });

      const usage = await getUsage(ctx.db, ctx.workspaceId);
      expect(usage.execCount).toBeGreaterThan(0);
    });

    it('broadcast increments exec_count', async () => {
      await request(ctx.app, 'POST', '/api/v1/events', {
        headers: authHeaders(ctx.apiKey),
        body: { event_type: 'BROADCAST', message: 'Exec test', tags: [] },
      });

      const usage = await getUsage(ctx.db, ctx.workspaceId);
      expect(usage.execCount).toBeGreaterThan(0);
    });

    it('run_playbook increments exec_count', async () => {
      // Define playbook first
      await request(ctx.app, 'POST', '/api/v1/playbooks', {
        headers: authHeaders(ctx.apiKey),
        body: {
          name: 'exec-test-pb',
          description: 'Test playbook',
          tasks: [{ description: 'Task 1', role: 'worker' }],
        },
      });

      const usageBefore = await getUsage(ctx.db, ctx.workspaceId);

      // Run playbook
      await request(ctx.app, 'POST', '/api/v1/playbooks/exec-test-pb/run', {
        headers: authHeaders(ctx.apiKey),
        body: {},
      });

      const usageAfter = await getUsage(ctx.db, ctx.workspaceId);
      expect(usageAfter.execCount).toBeGreaterThan(usageBefore.execCount);
    });
  });

  // -----------------------------------------------------------------------
  // API call counting on REST
  // -----------------------------------------------------------------------
  describe('API call counting (REST)', () => {
    let quotaApp: Hono;
    let quotaKey: string;
    const quotaWorkspaceId = 'api-count-team';

    beforeEach(() => {
      const team = setupWorkspace(ctx.db, quotaWorkspaceId, 'ltk_api_count_key_1234567890123456');
      quotaKey = team.apiKey;
      quotaApp = createApp(
        ctx.db,
        () => createMcpServer(ctx.db),
        testConfig({ quotaEnforcement: true }),
      );
    });

    it('POST request increments api_call_count', async () => {
      await request(quotaApp, 'POST', '/api/v1/context', {
        headers: authHeaders(quotaKey, 'agent'),
        body: { key: 'api-count-test', value: 'value', tags: [] },
      });

      // api_call_count is bumped via incrementUsageForced (fire-and-forget)
      // Give it a tick to resolve
      await new Promise((r) => setTimeout(r, 50));

      const usage = await getUsage(ctx.db, quotaWorkspaceId);
      expect(usage.apiCallCount).toBe(1);
    });

    it('GET request does NOT increment api_call_count', async () => {
      await request(quotaApp, 'GET', '/api/v1/tasks', {
        headers: authHeaders(quotaKey, 'agent'),
      });

      await new Promise((r) => setTimeout(r, 50));

      const usage = await getUsage(ctx.db, quotaWorkspaceId);
      expect(usage.apiCallCount).toBe(0);
    });

    it('multiple POSTs accumulate api_call_count', async () => {
      for (let i = 0; i < 3; i++) {
        await request(quotaApp, 'POST', '/api/v1/context', {
          headers: authHeaders(quotaKey, 'agent'),
          body: { key: `multi-${i}`, value: `val-${i}`, tags: [] },
        });
      }

      await new Promise((r) => setTimeout(r, 50));

      const usage = await getUsage(ctx.db, quotaWorkspaceId);
      expect(usage.apiCallCount).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Quota enforcement
  // -----------------------------------------------------------------------
  describe('Quota enforcement', () => {
    let quotaApp: Hono;
    let quotaKey: string;
    const quotaWorkspaceId = 'quota-test-team';

    beforeEach(() => {
      const team = setupWorkspace(ctx.db, quotaWorkspaceId, 'ltk_quota_test_key_123456789012345');
      quotaKey = team.apiKey;
      quotaApp = createApp(
        ctx.db,
        () => createMcpServer(ctx.db),
        testConfig({ quotaEnforcement: true }),
      );
    });

    it('below 80% — request succeeds with no warning header', async () => {
      // Free plan has 1000 exec. 79% = 790
      await incrementUsageForced(ctx.db, quotaWorkspaceId, { exec: 790 });

      const res = await request(quotaApp, 'POST', '/api/v1/context', {
        headers: authHeaders(quotaKey, 'agent'),
        body: { key: 'under-80', value: 'test', tags: [] },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('X-Quota-Warning')).toBeNull();
    });

    it('at 80% — request succeeds with X-Quota-Warning header', async () => {
      await incrementUsageForced(ctx.db, quotaWorkspaceId, { exec: 800 });

      const res = await request(quotaApp, 'POST', '/api/v1/context', {
        headers: authHeaders(quotaKey, 'agent'),
        body: { key: 'at-80', value: 'test', tags: [] },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('X-Quota-Warning')).toBeTruthy();
    });

    it('at 100% — request returns 429 QUOTA_EXCEEDED', async () => {
      await incrementUsageForced(ctx.db, quotaWorkspaceId, { exec: 1000 });

      const res = await request(quotaApp, 'POST', '/api/v1/context', {
        headers: authHeaders(quotaKey, 'agent'),
        body: { key: 'over-limit', value: 'blocked', tags: [] },
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe('QUOTA_EXCEEDED');
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('at 100% — GET requests still work (not blocked)', async () => {
      await incrementUsageForced(ctx.db, quotaWorkspaceId, { exec: 2000 });

      const res = await request(quotaApp, 'GET', '/api/v1/tasks', {
        headers: authHeaders(quotaKey, 'agent'),
      });
      expect(res.status).toBe(200);
    });

    it('429 response includes period and usage details', async () => {
      await incrementUsageForced(ctx.db, quotaWorkspaceId, { exec: 1001 });

      const res = await request(quotaApp, 'POST', '/api/v1/tasks', {
        headers: authHeaders(quotaKey, 'agent'),
        body: { description: 'Should be blocked' },
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.period).toBeDefined();
      expect(body.limits).toBeDefined();
      expect(body.limits.exec_quota).toBe(1000);
      expect(body.usage).toBeDefined();
      expect(body.usage.exec_count).toBeGreaterThanOrEqual(1001);
    });
  });

  // -----------------------------------------------------------------------
  // Quota enforcement NOT on MCP (documents current bug)
  // -----------------------------------------------------------------------
  describe('Quota enforcement NOT on MCP (known gap)', () => {
    it('MCP tools work even when REST would return 429', async () => {
      // Set up workspace and exceed quota
      const adapter = createTestAdapter();
      const team = setupWorkspace(adapter, 'mcp-bypass-team', 'ltk_mcp_bypass_key_12345678901234');
      await incrementUsageForced(adapter, 'mcp-bypass-team', { exec: 2000 });

      const quotaApp = createApp(
        adapter,
        () => createMcpServer(adapter),
        testConfig({ quotaEnforcement: true }),
      );

      // REST should be blocked
      const restRes = await request(quotaApp, 'POST', '/api/v1/context', {
        headers: authHeaders(team.apiKey, 'agent'),
        body: { key: 'rest-blocked', value: 'should fail', tags: [] },
      });
      expect(restRes.status).toBe(429);

      // MCP endpoint does NOT go through the quota middleware.
      // The MCP server is mounted separately and does not enforce quotas.
      // This documents the current behavior — MCP bypasses quota enforcement.
      // We verify this by checking the MCP endpoint responds (not 429).
      const mcpRes = await quotaApp.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${team.apiKey}`,
          'X-Agent-ID': 'mcp-agent',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });

      // MCP should respond — it does NOT enforce quota
      // It may return 200, or the SSE transport might return differently,
      // but it should NOT be 429.
      expect(mcpRes.status).not.toBe(429);
    });
  });
});
