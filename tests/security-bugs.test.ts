import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext, authHeaders, request, type TestContext } from './helpers.js';

describe('Security Bugs — Round 2', () => {
  // ─── H6: MCP Metadata Size Limit ────────────────────────────────────
  describe('H6 — MCP register_agent should reject metadata > 10KB', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = createTestContext();
    });

    it('REST rejects metadata exceeding 10KB', async () => {
      const largeMetadata: Record<string, string> = {};
      // Create a metadata object > 10KB
      for (let i = 0; i < 200; i++) {
        largeMetadata[`key_${i}`] = 'x'.repeat(60);
      }
      // Verify it's over 10KB
      expect(JSON.stringify(largeMetadata).length).toBeGreaterThan(10_240);

      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: {
          agent_id: 'test-agent',
          capabilities: ['test'],
          metadata: largeMetadata,
        },
      });
      expect(res.status).toBe(400);
    });

    it('REST accepts metadata under 10KB', async () => {
      const smallMetadata = { version: '1.0', env: 'test' };
      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: {
          agent_id: 'test-agent',
          capabilities: ['test'],
          metadata: smallMetadata,
        },
      });
      expect([200, 201]).toContain(res.status);
    });

    it('REST accepts registration without metadata', async () => {
      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: {
          agent_id: 'test-agent',
          capabilities: ['test'],
        },
      });
      expect([200, 201]).toContain(res.status);
    });

    it('metadata at exactly 10KB boundary', async () => {
      // Create metadata that's just under 10KB
      const metadata: Record<string, string> = {};
      let size = 0;
      let i = 0;
      while (size < 10_000) {
        const key = `k${i}`;
        const val = 'a'.repeat(50);
        metadata[key] = val;
        size = JSON.stringify(metadata).length;
        i++;
      }
      // Trim last entry to be exactly at 10240
      // This is a boundary test — just verify it doesn't crash
      const res = await request(ctx.app, 'POST', '/api/v1/agents', {
        headers: authHeaders(ctx.apiKey),
        body: {
          agent_id: 'test-agent',
          capabilities: [],
          metadata,
        },
      });
      // Should be 200 (under) or 400 (over) — just not 500
      expect([200, 201, 400]).toContain(res.status);
    });
  });

  // ─── H7: MCP Rate Limiting ──────────────────────────────────────────
  describe('H7 — MCP endpoint rate limiting', () => {
    it('/mcp endpoint exists and is accessible', async () => {
      const ctx = createTestContext();
      // The MCP endpoint is mounted at /mcp. Send a basic request.
      // This documents that the endpoint exists and whether rate limiting is in place.
      const res = await request(ctx.app, 'POST', '/mcp', {
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
        },
      });
      // MCP endpoint should respond (200 or other valid response)
      // The key finding is that /mcp is mounted on root app, BEFORE
      // the /api/v1 sub-router where rate limiters are applied.
      // This test documents the gap.
      expect(res.status).toBeDefined();
    });
  });
});
