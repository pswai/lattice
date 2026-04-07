/**
 * Tests for: webhook export URL redaction and inbound endpoint action_config size limits
 * - Webhook export redacts URL and secret fields (replaced with REDACTED)
 * - Inbound endpoint action_config rejects payloads over 10 KB, accepts under 10 KB
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, setupWorkspace } from './helpers.js';
import { exportWorkspaceData, REDACTED } from '../src/models/export.js';
import { defineInboundEndpoint } from '../src/models/inbound.js';
import { createWebhook } from '../src/models/webhook.js';
import type { SqliteAdapter } from '../src/db/adapter.js';

// ═══════════════════════════════════════════════════════════════════════════
// 2 — Webhook export redacts URL
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — Webhook export redacts URL', () => {
  let db: SqliteAdapter;
  const ws = 'test-team';

  beforeEach(() => {
    db = createTestDb();
    setupWorkspace(db, ws);
  });

  it('should redact webhook URL in export', async () => {
    await createWebhook(db, ws, 'agent', {
      url: 'https://internal.corp.com/hooks/secret-path',
    });

    const exported = await exportWorkspaceData(db, ws);
    expect(exported.webhooks.length).toBe(1);
    expect(exported.webhooks[0].url).toBe(REDACTED);
    expect(exported.webhooks[0].secret).toBe(REDACTED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — Unbounded action_config size
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — action_config size limit enforced', () => {
  let db: SqliteAdapter;
  const ws = 'test-team';

  beforeEach(() => {
    db = createTestDb();
    setupWorkspace(db, ws);
  });

  it('should reject action_config over 10 KB', async () => {
    const bigConfig: Record<string, string> = {};
    // Create a config that exceeds 10KB when serialized
    for (let i = 0; i < 200; i++) {
      bigConfig[`key_${i}`] = 'x'.repeat(100);
    }

    await expect(
      defineInboundEndpoint(db, ws, 'agent', {
        name: 'big-endpoint',
        action_type: 'create_task',
        action_config: bigConfig,
      }),
    ).rejects.toThrow('action_config exceeds maximum size of 10 KB');
  });

  it('should accept action_config under 10 KB', async () => {
    const result = await defineInboundEndpoint(db, ws, 'agent', {
      name: 'small-endpoint',
      action_type: 'create_task',
      action_config: { description_template: 'Task: {{body.title}}' },
    });
    expect(result.id).toBeDefined();
  });
});

