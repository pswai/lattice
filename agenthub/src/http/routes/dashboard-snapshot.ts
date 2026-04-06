import { Hono } from 'hono';
import type { DbAdapter } from '../../db/adapter.js';
import { getWorkspaceAnalytics, parseSinceDuration } from '../../models/analytics.js';

export function createDashboardSnapshotRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  /**
   * GET /dashboard-snapshot — single request combining agents, tasks, analytics,
   * recent events, workspace info, members, recent audit entries, usage/quota,
   * and API keys into one payload. Designed to replace the multiple
   * parallel requests the dashboard fires on page load.
   */
  router.get('/', async (c) => {
    const { workspaceId, scope } = c.get('auth');
    const sinceIso = parseSinceDuration('24h');

    const [agents, tasks, events, analytics, workspace, members, auditRows, apiKeys] = await Promise.all([
      db.all<{
        id: string;
        workspace_id: string;
        capabilities: string;
        status: string;
        metadata: string;
        last_heartbeat: string;
        registered_at: string;
      }>('SELECT * FROM agents WHERE workspace_id = ? ORDER BY registered_at DESC', workspaceId),

      db.all<{
        id: number;
        workspace_id: string;
        description: string;
        status: string;
        result: string | null;
        created_by: string;
        claimed_by: string | null;
        claimed_at: string | null;
        version: number;
        priority: string;
        assigned_to: string | null;
        created_at: string;
        updated_at: string;
      }>('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY id DESC LIMIT 100', workspaceId),

      db.all<{
        id: number;
        workspace_id: string;
        event_type: string;
        message: string;
        tags: string;
        created_by: string;
        created_at: string;
      }>('SELECT * FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 50', workspaceId),

      getWorkspaceAnalytics(db, workspaceId, sinceIso),

      db.get<{ id: string; name: string; plan_id: string | null }>(
        `SELECT w.id, w.name, ws.plan_id
         FROM workspaces w
         LEFT JOIN workspace_subscriptions ws ON ws.workspace_id = w.id
         WHERE w.id = ?`,
        workspaceId,
      ).catch(() => null as { id: string; name: string; plan_id: string | null } | null),

      db.all<{
        user_id: string;
        email: string | null;
        name: string | null;
        role: string;
        joined_at: string;
      }>(
        `SELECT wm.user_id, u.email, u.name, wm.role, wm.joined_at
         FROM workspace_memberships wm
         LEFT JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ?
         ORDER BY wm.joined_at`,
        workspaceId,
      ).catch(() => [] as Array<{ user_id: string; email: string | null; name: string | null; role: string; joined_at: string }>),

      db.all<{
        id: number;
        actor: string;
        action: string;
        resource_type: string | null;
        resource_id: string | null;
        metadata: string;
        ip: string | null;
        created_at: string;
      }>(
        `SELECT id, actor, action, resource_type, resource_id, metadata, ip, created_at
         FROM audit_log WHERE workspace_id = ? ORDER BY id DESC LIMIT 50`,
        workspaceId,
      ).catch(() => [] as Array<{ id: number; actor: string; action: string; resource_type: string | null; resource_id: string | null; metadata: string; ip: string | null; created_at: string }>),

      db.all<{
        id: number;
        label: string;
        scope: string;
        created_at: string;
        last_used_at: string | null;
        expires_at: string | null;
        revoked_at: string | null;
      }>(
        `SELECT id, label, scope, created_at, last_used_at, expires_at, revoked_at
         FROM api_keys WHERE workspace_id = ? ORDER BY id`,
        workspaceId,
      ).catch(() => [] as Array<{ id: number; label: string; scope: string; created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null }>),
    ]);

    // Usage counters (best-effort — table may not exist in all setups)
    let usage: {
      exec_count: number;
      api_call_count: number;
      storage_bytes: number;
    } | null = null;
    let limits: {
      plan_id: string;
      plan_name: string;
      exec_quota: number;
      api_call_quota: number;
      storage_bytes_quota: number;
      seat_quota: number;
    } | null = null;

    try {
      const now = new Date();
      const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const usageRow = await db.get<{
        exec_count: number;
        api_call_count: number;
        storage_bytes: number;
      }>(
        'SELECT exec_count, api_call_count, storage_bytes FROM usage_counters WHERE workspace_id = ? AND period = ?',
        workspaceId, period,
      );
      if (usageRow) {
        usage = usageRow;
      } else {
        usage = { exec_count: 0, api_call_count: 0, storage_bytes: 0 };
      }

      // Try to fetch workspace plan for limits
      const planId = workspace?.plan_id || 'free';
      // Provide defaults based on common plan structure
      limits = {
        plan_id: planId,
        plan_name: planId.charAt(0).toUpperCase() + planId.slice(1),
        exec_quota: planId === 'free' ? 1000 : planId === 'pro' ? 50000 : 999999,
        api_call_quota: planId === 'free' ? 10000 : planId === 'pro' ? 500000 : 9999999,
        storage_bytes_quota: planId === 'free' ? 100 * 1024 * 1024 : planId === 'pro' ? 10 * 1024 * 1024 * 1024 : 100 * 1024 * 1024 * 1024,
        seat_quota: planId === 'free' ? 3 : planId === 'pro' ? 25 : 999,
      };
    } catch {
      // usage tables may not exist
    }

    return c.json({
      workspace: workspace ? { id: workspace.id, name: workspace.name, planId: workspace.plan_id } : { id: workspaceId, name: workspaceId, planId: null },
      scope,
      agents: agents.map((a) => ({
        id: a.id,
        workspaceId: a.workspace_id,
        capabilities: JSON.parse(a.capabilities),
        status: a.status,
        metadata: JSON.parse(a.metadata),
        lastHeartbeat: a.last_heartbeat,
        registeredAt: a.registered_at,
      })),
      tasks: tasks.map((t) => ({
        id: t.id,
        workspaceId: t.workspace_id,
        description: t.description,
        status: t.status,
        result: t.result,
        createdBy: t.created_by,
        claimedBy: t.claimed_by,
        claimedAt: t.claimed_at,
        version: t.version,
        priority: t.priority,
        assignedTo: t.assigned_to,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
      recentEvents: events.map((e) => ({
        id: e.id,
        workspaceId: e.workspace_id,
        eventType: e.event_type,
        message: e.message,
        tags: JSON.parse(e.tags),
        createdBy: e.created_by,
        createdAt: e.created_at,
      })),
      analytics,
      members: members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        name: m.name,
        role: m.role,
        joinedAt: m.joined_at,
      })),
      auditLog: auditRows.map((r) => {
        let metadata: unknown = {};
        try { metadata = JSON.parse(r.metadata); } catch { metadata = {}; }
        const resource = r.resource_type
          ? (r.resource_id ? `${r.resource_type}:${r.resource_id}` : r.resource_type)
          : null;
        return { id: r.id, actor: r.actor, action: r.action, resource, metadata, ip: r.ip, createdAt: r.created_at };
      }),
      usage,
      limits,
      apiKeys: apiKeys.map((k) => ({
        id: k.id,
        label: k.label,
        scope: k.scope,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at,
        expiresAt: k.expires_at,
        revokedAt: k.revoked_at,
      })),
    });
  });

  return router;
}
