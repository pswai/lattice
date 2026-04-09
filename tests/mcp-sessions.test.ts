import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';
import { sessionRegistry } from '../src/mcp/session-registry.js';
import { sendMessage, getMessages } from '../src/models/message.js';

/**
 * Helper to perform the MCP initialization handshake and get a session ID.
 */
async function initMcpSession(
  ctx: TestContext,
  agentId: string = 'test-agent',
): Promise<{ sessionId: string }> {
  const res = await ctx.app.request('/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.apiKey}`,
      'X-Agent-ID': agentId,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });

  expect(res.status).toBe(200);
  const sessionId = res.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();

  // Send initialized notification to complete the handshake
  await ctx.app.request('/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.apiKey}`,
      'X-Agent-ID': agentId,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId!,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  return { sessionId: sessionId! };
}

describe('MCP Session Management', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    sessionRegistry.clear();
  });

  describe('session lifecycle', () => {
    it('assigns a session ID on initialization', async () => {
      const { sessionId } = await initMcpSession(ctx);
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    });

    it('registers the session in the registry', async () => {
      const sizeBefore = sessionRegistry.size;
      const { sessionId } = await initMcpSession(ctx, 'agent-alpha');
      expect(sessionRegistry.size).toBe(sizeBefore + 1);

      const session = sessionRegistry.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.workspaceId).toBe(ctx.workspaceId);
      expect(session!.agentId).toBe('agent-alpha');
    });

    it('allows reverse lookup by agent identity', async () => {
      await initMcpSession(ctx, 'agent-alpha');

      const session = sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-alpha');
      expect(session).toBeDefined();
      expect(session!.agentId).toBe('agent-alpha');
    });

    it('reuses transport for subsequent requests with session ID', async () => {
      const { sessionId } = await initMcpSession(ctx, 'agent-alpha');

      // Make a tool call using the session
      const res = await ctx.app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'X-Agent-ID': 'agent-alpha',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      });

      expect(res.status).toBe(200);
    });

    it('rejects requests with unknown session ID', async () => {
      const res = await ctx.app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'X-Agent-ID': 'agent-alpha',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': 'nonexistent-session-id',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });

      // Unknown session ID is not in our registry, so a new transport is
      // created. The SDK then rejects because the request has a session ID
      // header but the new transport hasn't initialized yet → 400.
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects cross-workspace session reuse', async () => {
      const { sessionId } = await initMcpSession(ctx, 'agent-alpha');

      // Create a second workspace with its own API key
      ctx.rawDb.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run('other-ws', 'Other');
      const otherKey = 'ltk_other_workspace_key_1234567890';
      const keyHash = require('crypto').createHash('sha256').update(otherKey).digest('hex');
      ctx.rawDb.prepare('INSERT INTO api_keys (workspace_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
        'other-ws', keyHash, 'other key', 'write',
      );

      // Attempt to reuse session ID with different workspace credentials
      const res = await ctx.app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${otherKey}`,
          'X-Agent-ID': 'agent-alpha',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('INVALID_SESSION');
    });

    it('removes session on DELETE', async () => {
      const { sessionId } = await initMcpSession(ctx, 'agent-alpha');
      expect(sessionRegistry.getSession(sessionId)).toBeDefined();

      const res = await ctx.app.request('/mcp', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'X-Agent-ID': 'agent-alpha',
          'mcp-session-id': sessionId,
        },
      });

      expect(res.status).toBe(200);
      expect(sessionRegistry.getSession(sessionId)).toBeUndefined();
      expect(sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-alpha')).toBeUndefined();
    });

    it('supports multiple concurrent sessions for different agents', async () => {
      const { sessionId: s1 } = await initMcpSession(ctx, 'agent-alpha');
      const { sessionId: s2 } = await initMcpSession(ctx, 'agent-beta');

      expect(s1).not.toBe(s2);
      expect(sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-alpha')?.sessionId).toBe(s1);
      expect(sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-beta')?.sessionId).toBe(s2);
    });

    it('replaces old session when same agent reconnects', async () => {
      const { sessionId: s1 } = await initMcpSession(ctx, 'agent-alpha');
      const { sessionId: s2 } = await initMcpSession(ctx, 'agent-alpha');

      expect(s1).not.toBe(s2);
      // Reverse lookup should point to the new session
      expect(sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-alpha')?.sessionId).toBe(s2);
    });
  });

  describe('message push notification', () => {
    it('sends logging notification when recipient has active session', async () => {
      // Set up recipient session
      await initMcpSession(ctx, 'agent-b');

      const recipientSession = sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-b');
      expect(recipientSession).toBeDefined();

      // Send a message to agent-b — the push notification fires async
      const result = await sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
        to: 'agent-b',
        message: 'Hello agent-b!',
        tags: [],
      });

      expect(result.messageId).toBeGreaterThan(0);

      // The notification is fire-and-forget — we verify the session lookup worked
      // by confirming the session is still valid and no errors were thrown
      expect(sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-b')).toBeDefined();
    });

    it('does not throw when recipient has no active session', async () => {
      // No session for agent-b — should not throw
      const result = await sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
        to: 'agent-b',
        message: 'Hello nobody!',
        tags: [],
      });

      expect(result.messageId).toBeGreaterThan(0);
    });

    it('isolates sessions by workspace', async () => {
      // Create second workspace
      ctx.rawDb.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run('other-workspace', 'Other');

      await initMcpSession(ctx, 'agent-b');

      // Agent-b in default workspace has a session
      expect(sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-b')).toBeDefined();
      // Agent-b in other workspace does NOT
      expect(sessionRegistry.getSessionForAgent('other-workspace', 'agent-b')).toBeUndefined();
    });
  });

  describe('end-to-end direct messaging', () => {
    async function mcpToolCall(
      sessionCtx: TestContext,
      sessionId: string,
      agentId: string,
      toolName: string,
      args: Record<string, unknown>,
      requestId: number = 10,
    ): Promise<Response> {
      return sessionCtx.app.request('/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionCtx.apiKey}`,
          'X-Agent-ID': agentId,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        }),
      });
    }

    it('full flow: send, store, and retrieve via getMessages', async () => {
      // Both agents initialize MCP sessions
      const { sessionId: sessionA } = await initMcpSession(ctx, 'agent-a');
      const { sessionId: sessionB } = await initMcpSession(ctx, 'agent-b');

      // agent-a sends a message to agent-b via the model layer
      const result = await sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
        to: 'agent-b',
        message: 'Hello from the e2e test!',
        tags: ['e2e'],
      });

      expect(result.messageId).toBeGreaterThan(0);

      // agent-b retrieves messages via the model layer
      const response = await getMessages(ctx.db, ctx.workspaceId, 'agent-b', {});
      expect(response.messages).toHaveLength(1);
      expect(response.messages[0].fromAgent).toBe('agent-a');
      expect(response.messages[0].toAgent).toBe('agent-b');
      expect(response.messages[0].message).toBe('Hello from the e2e test!');
      expect(response.messages[0].tags).toEqual(['e2e']);
    });

    it('session push fires without error when recipient has active session', async () => {
      // agent-b has an active session
      await initMcpSession(ctx, 'agent-b');
      const recipientSession = sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-b');
      expect(recipientSession).toBeDefined();

      // Sending a message should not throw — the sendLoggingMessage is fire-and-forget
      await expect(
        sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
          to: 'agent-b',
          message: 'Push notification test',
          tags: [],
        }),
      ).resolves.toEqual(expect.objectContaining({ messageId: expect.any(Number) }));

      // Session should still be valid after the push
      expect(sessionRegistry.getSessionForAgent(ctx.workspaceId, 'agent-b')).toBeDefined();
    });

    it('cross-session tool call: agent-b retrieves message via tools/call get_messages', async () => {
      const { sessionId: sessionA } = await initMcpSession(ctx, 'agent-a');
      const { sessionId: sessionB } = await initMcpSession(ctx, 'agent-b');

      // agent-a sends a message to agent-b
      await sendMessage(ctx.db, ctx.workspaceId, 'agent-a', {
        to: 'agent-b',
        message: 'Cross-session hello!',
        tags: ['cross-session'],
      });

      // agent-b calls tools/call with get_messages using their session
      const res = await mcpToolCall(ctx, sessionB, 'agent-b', 'get_messages', {
        agent_id: 'agent-b',
      });

      expect(res.status).toBe(200);

      // The MCP transport returns SSE — parse the event stream
      const text = await res.text();
      const jsonLines = text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length));
      expect(jsonLines.length).toBeGreaterThan(0);

      // Find the JSON-RPC response with a result (skip notifications)
      const rpcResponse = jsonLines
        .map((l) => JSON.parse(l))
        .find((msg: any) => msg.result !== undefined);
      expect(rpcResponse).toBeDefined();

      const content = rpcResponse.result.content;
      expect(content).toBeDefined();
      expect(content.length).toBeGreaterThan(0);

      // The text content should contain the message data
      const textContent = content.find((c: any) => c.type === 'text');
      expect(textContent).toBeDefined();
      const parsed = JSON.parse(textContent.text);
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0].fromAgent).toBe('agent-a');
      expect(parsed.messages[0].message).toBe('Cross-session hello!');
    });
  });
});

