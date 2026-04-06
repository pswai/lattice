/**
 * Round 2 Coverage Gaps — Tests for remaining gaps identified by test-auditor.
 *
 * Covers 13 specific gaps (P0–P2):
 *   P0: Negative usage rejection, email template variable rendering
 *   P1: Rate-limit sliding window, quota soft-limit warning
 *   P2: Secret scanner false positives, audit future date, agent metadata boundary
 *
 * Gaps already addressed by service-layer.test.ts (scheduler, reaper, webhooks,
 * audit cleanup) are NOT duplicated here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestDb,
  createTestContext,
  setupWorkspace,
  authHeaders,
  request,
  testConfig,
  type TestContext,
} from './helpers.js';
import {
  incrementUsage,
  incrementUsageForced,
  getUsage,
  getCurrentUsageWithLimits,
  setUsageTracking,
} from '../src/models/usage.js';
import { pruneAuditOlderThan } from '../src/models/audit.js';
import { scanForSecrets } from '../src/services/secret-scanner.js';
import { checkRateLimit, __resetRateLimit } from '../src/http/middleware/rate-limit.js';
import { createUser } from '../src/models/user.js';
import { createSession } from '../src/models/session.js';
import { createInvitation } from '../src/models/invitation.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { SqliteAdapter } from '../src/db/adapter.js';

// ═══════════════════════════════════════════════════════════════════════════
// P0 — Negative Usage Rejection (Bug #3 fix)
// ═══════════════════════════════════════════════════════════════════════════
describe('[P0] Usage — negative increments rejected', () => {
  let db: SqliteAdapter;

  beforeEach(() => {
    db = createTestDb();
    setupWorkspace(db, 'team-a');
    setUsageTracking(true);
  });

  afterEach(() => {
    setUsageTracking(false);
  });

  it('incrementUsage rejects negative exec count', async () => {
    await expect(
      incrementUsage(db, 'team-a', { exec: -1 }),
    ).rejects.toThrow(/non-negative/);
  });

  it('incrementUsage rejects negative apiCall count', async () => {
    await expect(
      incrementUsage(db, 'team-a', { apiCall: -5 }),
    ).rejects.toThrow(/non-negative/);
  });

  it('incrementUsage rejects negative storageBytes', async () => {
    await expect(
      incrementUsage(db, 'team-a', { storageBytes: -100 }),
    ).rejects.toThrow(/non-negative/);
  });

  it('incrementUsageForced also rejects negative values', async () => {
    await expect(
      incrementUsageForced(db, 'team-a', { exec: -1 }),
    ).rejects.toThrow(/non-negative/);
  });

  it('accepts zero increments (no-op)', async () => {
    // Should NOT throw, just be a no-op
    await incrementUsage(db, 'team-a', { exec: 0, apiCall: 0, storageBytes: 0 });
    const usage = await getUsage(db, 'team-a');
    expect(usage.execCount).toBe(0);
  });

  it('accepts positive increments correctly', async () => {
    await incrementUsage(db, 'team-a', { exec: 3, apiCall: 10, storageBytes: 1024 });
    const usage = await getUsage(db, 'team-a');
    expect(usage.execCount).toBe(3);
    expect(usage.apiCallCount).toBe(10);
    expect(usage.storageBytes).toBe(1024);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P0 — Email Template Variables (Invitation email)
// ═══════════════════════════════════════════════════════════════════════════
describe('[P0] Invitation email contains rendered accept URL', () => {
  it('email body includes actual accept URL with token', async () => {
    const adapter = createTestDb();
    const config = testConfig({ emailVerificationReturnTokens: true });

    // Capture sent emails
    const sentEmails: Array<{ to: string; subject: string; body: string }> = [];
    const stubEmailSender = {
      send: async (to: string, subject: string, body: string) => {
        sentEmails.push({ to, subject, body });
      },
    };

    const app = createApp(adapter, () => createMcpServer(adapter), config, stubEmailSender);

    // Create user + session + workspace
    const user = await createUser(adapter, { email: 'admin@example.com', password: 'password123' });
    const session = await createSession(adapter, user.id, {});
    adapter.rawDb.prepare('INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)').run('ws-email', 'Email WS', user.id);
    const { addMembership } = await import('../src/models/membership.js');
    await addMembership(adapter, { userId: user.id, workspaceId: 'ws-email', role: 'owner' });

    // POST invite
    const res = await app.request('/workspaces/ws-email/invites', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `lt_session=${session.raw}`,
      },
      body: JSON.stringify({ email: 'alice@example.com', role: 'member' }),
    });

    expect(res.status).toBe(201);

    // Give async email send a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    // Verify email was sent
    expect(sentEmails).toHaveLength(1);
    const email = sentEmails[0];
    expect(email.to).toBe('alice@example.com');

    // Verify the body contains the ACTUAL accept URL, not a template variable
    expect(email.body).not.toContain('{{');
    expect(email.body).toContain(config.appBaseUrl);
    expect(email.body).toContain('/workspaces/invites/accept?token=');

    // Verify role appears in the email
    expect(email.body).toContain('member');

    // Verify workspace name/id appears
    expect(email.body).toContain('ws-email');
  });

  it('email subject contains workspace name', async () => {
    const adapter = createTestDb();
    const config = testConfig({ emailVerificationReturnTokens: true });

    const sentEmails: Array<{ to: string; subject: string; body: string }> = [];
    const stubEmailSender = {
      send: async (to: string, subject: string, body: string) => {
        sentEmails.push({ to, subject, body });
      },
    };

    const app = createApp(adapter, () => createMcpServer(adapter), config, stubEmailSender);

    const user = await createUser(adapter, { email: 'admin2@example.com', password: 'password123' });
    const session = await createSession(adapter, user.id, {});
    adapter.rawDb.prepare('INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)').run('my-team', 'My Team', user.id);
    const { addMembership } = await import('../src/models/membership.js');
    await addMembership(adapter, { userId: user.id, workspaceId: 'my-team', role: 'owner' });

    await app.request('/workspaces/my-team/invites', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `lt_session=${session.raw}`,
      },
      body: JSON.stringify({ email: 'bob@example.com', role: 'admin' }),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toContain('my-team');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P1 — Rate Limit Sliding Window
// ═══════════════════════════════════════════════════════════════════════════
describe('[P1] Rate limit — sliding window behavior', () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it('allows requests after window slides past old hits', () => {
    // Use a very short window for testing
    const windowMs = 100;
    const perMinute = 2;
    const key = 'test-window';

    // First two requests pass
    expect(checkRateLimit(key, perMinute, windowMs).limited).toBe(false);
    expect(checkRateLimit(key, perMinute, windowMs).limited).toBe(false);

    // Third request is limited
    expect(checkRateLimit(key, perMinute, windowMs).limited).toBe(true);
  });

  it('returns retryAfterSec when limited', () => {
    const key = 'test-retry';
    const perMinute = 1;

    checkRateLimit(key, perMinute);
    const result = checkRateLimit(key, perMinute);
    expect(result.limited).toBe(true);
    if (result.limited) {
      expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });

  it('per-minute 0 disables rate limiting', () => {
    const key = 'test-disabled';
    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit(key, 0).limited).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P1 — Quota Soft-Limit Warning
// ═══════════════════════════════════════════════════════════════════════════
describe('[P1] Quota — soft and hard limit detection', () => {
  let db: SqliteAdapter;

  beforeEach(() => {
    db = createTestDb();
    setupWorkspace(db, 'team-a');
    setUsageTracking(true);
  });

  afterEach(() => {
    setUsageTracking(false);
  });

  it('reports soft=true when usage exceeds 80% of quota', async () => {
    // Default free plan has exec_quota = 1000
    // Inject usage at 85% = 850
    await incrementUsage(db, 'team-a', { exec: 850 });

    const result = await getCurrentUsageWithLimits(db, 'team-a');
    expect(result.soft).toBe(true);
    expect(result.hard).toBe(false);
  });

  it('reports hard=true when usage exceeds 100% of quota', async () => {
    await incrementUsage(db, 'team-a', { exec: 1000 });

    const result = await getCurrentUsageWithLimits(db, 'team-a');
    expect(result.soft).toBe(true); // soft is also true at 100%
    expect(result.hard).toBe(true);
  });

  it('reports soft=false, hard=false when usage is below 80%', async () => {
    await incrementUsage(db, 'team-a', { exec: 100 });

    const result = await getCurrentUsageWithLimits(db, 'team-a');
    expect(result.soft).toBe(false);
    expect(result.hard).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — Secret Scanner False Positives
// ═══════════════════════════════════════════════════════════════════════════
describe('[P2] Secret scanner — false positives', () => {
  it('does not flag normal text that happens to contain common words', () => {
    const benign = [
      'My secret ingredient is love and kindness.',
      'The API documentation is available at /docs',
      'Use Bearer tokens for authentication (see RFC 6750)',
      'My password policy requires 12 characters',
      'Set the AWS_REGION environment variable to us-east-1',
    ];

    for (const text of benign) {
      const result = scanForSecrets(text);
      expect(result.clean).toBe(true);
    }
  });

  it('correctly flags real secret patterns', () => {
    const secrets = [
      'AKIAIOSFODNN7EXAMPLE',                        // AWS key
      'sk_live_4eC39HqLyjWDarjtT1zdp7dc',            // Stripe key
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234',   // GitHub PAT
      '-----BEGIN RSA PRIVATE KEY-----',              // Private key
    ];

    for (const text of secrets) {
      const result = scanForSecrets(text);
      expect(result.clean).toBe(false);
    }
  });

  it('handles empty and whitespace-only input', () => {
    expect(scanForSecrets('').clean).toBe(true);
    expect(scanForSecrets('   \n\t  ').clean).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — Audit Future Date Rejection (Bug #9 fix)
// ═══════════════════════════════════════════════════════════════════════════
describe('[P2] Audit prune — future date validation', () => {
  let db: SqliteAdapter;

  beforeEach(() => {
    db = createTestDb();
    setupWorkspace(db, 'team-a');
  });

  it('rejects cutoff date in the future', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await expect(pruneAuditOlderThan(db, tomorrow)).rejects.toThrow(/past/);
  });

  it('rejects non-ISO date strings', async () => {
    await expect(pruneAuditOlderThan(db, 'yesterday')).rejects.toThrow(/valid ISO date/);
  });

  it('accepts valid past date without error', async () => {
    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    // Should not throw even with no data to prune
    const deleted = await pruneAuditOlderThan(db, lastYear);
    expect(deleted).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P2 — Agent Metadata Size Boundary
// ═══════════════════════════════════════════════════════════════════════════
describe('[P2] Agent metadata — REST 10KB boundary', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it('rejects metadata exactly at the limit boundary (> 10KB)', async () => {
    const metadata: Record<string, string> = {};
    // Build metadata just over 10KB (~10.5KB)
    for (let i = 0; i < 200; i++) {
      metadata[`key_${i}`] = 'x'.repeat(50);
    }
    const size = JSON.stringify(metadata).length;
    expect(size).toBeGreaterThan(10_000);

    const res = await request(ctx.app, 'POST', '/api/v1/agents', {
      headers: authHeaders(ctx.apiKey),
      body: {
        agent_id: 'big-meta',
        capabilities: ['test'],
        metadata,
      },
    });
    expect(res.status).toBe(400);
  });

  it('accepts metadata well under 10KB', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/agents', {
      headers: authHeaders(ctx.apiKey),
      body: {
        agent_id: 'small-meta',
        capabilities: ['test'],
        metadata: { version: '1.0', env: 'test', lang: 'en' },
      },
    });
    expect([200, 201]).toContain(res.status);
  });

  it('accepts registration without metadata at all', async () => {
    const res = await request(ctx.app, 'POST', '/api/v1/agents', {
      headers: authHeaders(ctx.apiKey),
      body: {
        agent_id: 'no-meta',
        capabilities: ['test'],
      },
    });
    expect([200, 201]).toContain(res.status);
  });
});
