import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, setupTeam, testConfig, request } from './helpers.js';
import { seedDefaultPlans, listPlans, getPlan } from '../src/models/plan.js';
import { getTeamPlan, upsertTeamSubscription } from '../src/models/subscription.js';
import {
  incrementUsage,
  incrementUsageForced,
  getUsage,
  getCurrentUsageWithLimits,
  currentPeriodYm,
  setUsageTracking,
} from '../src/models/usage.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createUser } from '../src/models/user.js';
import { createSession } from '../src/models/session.js';
import { addMembership } from '../src/models/membership.js';
import type Database from 'better-sqlite3';
import type { Hono } from 'hono';

describe('quota foundation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    setupTeam(db, 'test-team');
  });

  afterEach(() => {
    setUsageTracking(false);
  });

  describe('plans', () => {
    it('should seed 3 default plans idempotently', () => {
      seedDefaultPlans(db); // already called in createTestDb
      const plans = listPlans(db);
      expect(plans).toHaveLength(3);
      expect(plans.map((p) => p.id)).toEqual(['free', 'pro', 'business']);
    });

    it('should return correct free plan values', () => {
      const plan = getPlan(db, 'free')!;
      expect(plan.priceCents).toBe(0);
      expect(plan.execQuota).toBe(1000);
      expect(plan.seatQuota).toBe(3);
    });
  });

  describe('subscriptions', () => {
    it('should fall back to free plan when no subscription', () => {
      const plan = getTeamPlan(db, 'test-team');
      expect(plan.id).toBe('free');
    });

    it('should return real plan when subscribed', () => {
      upsertTeamSubscription(db, {
        teamId: 'test-team',
        planId: 'pro',
        status: 'active',
      });
      const plan = getTeamPlan(db, 'test-team');
      expect(plan.id).toBe('pro');
      expect(plan.execQuota).toBe(15000);
    });
  });

  describe('usage counters', () => {
    it('should return zeros for empty period', () => {
      const usage = getUsage(db, 'test-team');
      expect(usage.execCount).toBe(0);
      expect(usage.apiCallCount).toBe(0);
    });

    it('should not track when disabled (default)', () => {
      incrementUsage(db, 'test-team', { exec: 1 });
      expect(getUsage(db, 'test-team').execCount).toBe(0);
    });

    it('should track when enabled', () => {
      setUsageTracking(true);
      incrementUsage(db, 'test-team', { exec: 5 });
      expect(getUsage(db, 'test-team').execCount).toBe(5);
    });

    it('should increment additively', () => {
      setUsageTracking(true);
      incrementUsage(db, 'test-team', { exec: 3 });
      incrementUsage(db, 'test-team', { exec: 2, apiCall: 10 });
      const u = getUsage(db, 'test-team');
      expect(u.execCount).toBe(5);
      expect(u.apiCallCount).toBe(10);
    });

    it('incrementUsageForced works regardless of flag', () => {
      incrementUsageForced(db, 'test-team', { exec: 1 });
      expect(getUsage(db, 'test-team').execCount).toBe(1);
    });

    it('should detect soft/hard thresholds', () => {
      incrementUsageForced(db, 'test-team', { exec: 800 }); // 80% of free 1000
      const result = getCurrentUsageWithLimits(db, 'test-team');
      expect(result.soft).toBe(true);
      expect(result.hard).toBe(false);
    });

    it('should detect hard exceeded', () => {
      incrementUsageForced(db, 'test-team', { exec: 1000 }); // 100%
      const result = getCurrentUsageWithLimits(db, 'test-team');
      expect(result.hard).toBe(true);
    });
  });

  describe('quota middleware', () => {
    let app: Hono;
    let apiKey: string;

    beforeEach(() => {
      const team = setupTeam(db, 'quota-team', 'ahk_quota_key_123456789012345678');
      apiKey = team.apiKey;
      app = createApp(
        db,
        () => createMcpServer(db),
        testConfig({ quotaEnforcement: true }),
      );
    });

    it('should return 429 when hard exceeded', async () => {
      incrementUsageForced(db, 'quota-team', { exec: 1001 });
      const res = await request(app, 'POST', '/api/v1/context', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Agent-ID': 'test',
          'Content-Type': 'application/json',
        },
        body: { agent_id: 'test', key: 'foo', value: 'bar', tags: [] },
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe('QUOTA_EXCEEDED');
    });

    it('should add X-Quota-Warning at 80%', async () => {
      incrementUsageForced(db, 'quota-team', { exec: 801 });
      const res = await request(app, 'POST', '/api/v1/context', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Agent-ID': 'test',
          'Content-Type': 'application/json',
        },
        body: { agent_id: 'test', key: 'warn-test', value: 'bar', tags: [] },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('X-Quota-Warning')).toBeTruthy();
    });

    it('should not block GET even at hard cap', async () => {
      incrementUsageForced(db, 'quota-team', { exec: 2000 });
      const res = await request(app, 'GET', '/api/v1/agents', {
        headers: { Authorization: `Bearer ${apiKey}`, 'X-Agent-ID': 'test' },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /workspaces/:id/usage', () => {
    let app: Hono;
    let sessionCookie: string;

    beforeEach(() => {
      const user = createUser(db, { email: 'usage@test.com', password: 'password123' });
      const session = createSession(db, user.id, {});
      sessionCookie = `ah_session=${session.raw}`;
      db.prepare('INSERT INTO teams (id, name, owner_user_id) VALUES (?, ?, ?)').run(
        'usage-team',
        'Usage Team',
        user.id,
      );
      addMembership(db, { userId: user.id, teamId: 'usage-team', role: 'owner' });
      // Seed a default API key so the team infra is complete
      const keyHash = require('crypto').createHash('sha256').update('ak_usage').digest('hex');
      db.prepare('INSERT INTO api_keys (team_id, key_hash, label, scope) VALUES (?, ?, ?, ?)').run(
        'usage-team',
        keyHash,
        'default',
        'write',
      );
      app = createApp(db, () => createMcpServer(db), testConfig());
    });

    it('should return usage + free plan for new workspace', async () => {
      const res = await app.request('/workspaces/usage-team/usage', {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.limits.plan_id).toBe('free');
      expect(body.usage.exec_count).toBe(0);
      expect(body.soft_warning).toBe(false);
      expect(body.hard_exceeded).toBe(false);
    });

    it('should require session', async () => {
      const res = await app.request('/workspaces/usage-team/usage');
      expect(res.status).toBe(401);
    });

    it('should require membership', async () => {
      const other = createUser(db, { email: 'other@test.com', password: 'password123' });
      const otherSession = createSession(db, other.id, {});
      const res = await app.request('/workspaces/usage-team/usage', {
        headers: { Cookie: `ah_session=${otherSession.raw}` },
      });
      expect(res.status).toBe(404);
    });
  });
});
