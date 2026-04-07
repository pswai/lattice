import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, setupWorkspace, testConfig } from './helpers.js';
import { createUser } from '../src/models/user.js';
import { createSession } from '../src/models/session.js';
import { exportWorkspaceData, REDACTED } from '../src/models/export.js';
import { defineInboundEndpoint } from '../src/models/inbound.js';
import { createWebhook } from '../src/models/webhook.js';
import { createEmailSender } from '../src/services/email.js';
import type { SqliteAdapter } from '../src/db/adapter.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1 — Session per-user limit
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — Sessions are capped at 10 per user', () => {
  let db: SqliteAdapter;
  let userId: string;

  beforeEach(async () => {
    db = createTestDb();
    userId = (await createUser(db, { email: 'u@test.com', password: 'longenough-pass' })).id;
  });

  it('should keep at most 10 active sessions per user', async () => {
    // Create 12 sessions
    for (let i = 0; i < 12; i++) {
      await createSession(db, userId);
    }

    const rows = await db.all<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
      userId,
    );
    expect(rows.length).toBe(10);
  });

  it('should preserve the newest sessions when trimming', async () => {
    const sessions = [];
    for (let i = 0; i < 12; i++) {
      sessions.push(await createSession(db, userId));
    }

    const remaining = await db.all<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
      userId,
    );
    expect(remaining.length).toBe(10);
    // The most recent session should always survive
    const lastSession = sessions[sessions.length - 1];
    const ids = remaining.map((r) => r.id);
    expect(ids).toContain(lastSession.sessionId);
  });

  it('should not affect other users sessions', async () => {
    const user2 = (await createUser(db, { email: 'u2@test.com', password: 'longenough-pass' })).id;

    // Create 12 for user1, 3 for user2
    for (let i = 0; i < 12; i++) {
      await createSession(db, userId);
    }
    for (let i = 0; i < 3; i++) {
      await createSession(db, user2);
    }

    const u1Count = await db.all<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', userId,
    );
    const u2Count = await db.all<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', user2,
    );
    expect(u1Count.length).toBe(10);
    expect(u2Count.length).toBe(3);
  });
});

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

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Email sender throws on misconfiguration
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — Email sender throws when resend configured without API key', () => {
  it('should throw when emailProvider=resend but no API key', () => {
    expect(() =>
      createEmailSender(testConfig({ emailProvider: 'resend', emailResendApiKey: '' })),
    ).toThrow("emailProvider is 'resend' but RESEND_API_KEY is not set");
  });

  it('should return stub sender when no provider specified', () => {
    const sender = createEmailSender(testConfig({ emailProvider: 'stub' }));
    expect(sender).toBeDefined();
  });

  it('should return stub sender with default config', () => {
    const sender = createEmailSender(testConfig());
    expect(sender).toBeDefined();
  });
});
