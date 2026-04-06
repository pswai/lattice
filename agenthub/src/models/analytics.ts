import type { DbAdapter } from '../db/adapter.js';

export interface TaskAnalytics {
  total: number;
  by_status: {
    open: number;
    claimed: number;
    completed: number;
    escalated: number;
    abandoned: number;
  };
  completion_rate: number;
  avg_completion_ms: number | null;
  median_completion_ms: number | null;
}

export interface EventAnalytics {
  total: number;
  by_type: {
    LEARNING: number;
    BROADCAST: number;
    ESCALATION: number;
    ERROR: number;
    TASK_UPDATE: number;
  };
  per_hour_last_24h: number[];
}

export interface TopProducer {
  agent_id: string;
  events: number;
  tasks_completed: number;
}

export interface AgentAnalytics {
  total: number;
  online: number;
  top_producers: TopProducer[];
}

export interface TopAuthor {
  agent_id: string;
  count: number;
}

export interface ContextAnalytics {
  total_entries: number;
  entries_since: number;
  top_authors: TopAuthor[];
}

export interface MessageAnalytics {
  total: number;
  since: number;
}

export interface WorkspaceAnalytics {
  tasks: TaskAnalytics;
  events: EventAnalytics;
  agents: AgentAnalytics;
  context: ContextAnalytics;
  messages: MessageAnalytics;
}

const TASK_STATUSES = ['open', 'claimed', 'completed', 'escalated', 'abandoned'] as const;
const EVENT_TYPES = ['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE'] as const;

/**
 * Parse a duration string like "24h", "7d", "30d" into an ISO timestamp
 * representing that duration ago from now.
 */
export function parseSinceDuration(since: string | undefined): string {
  const value = since ?? '24h';
  const match = /^(\d+)([hdm])$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration: "${value}". Expected formats: "24h", "7d", "30d".`);
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms =
    unit === 'h' ? amount * 60 * 60 * 1000 :
    unit === 'd' ? amount * 24 * 60 * 60 * 1000 :
    amount * 60 * 1000; // 'm' minutes
  return new Date(Date.now() - ms).toISOString();
}

export async function getWorkspaceAnalytics(
  db: DbAdapter,
  workspaceId: string,
  sinceIso: string,
): Promise<WorkspaceAnalytics> {
  // ── Tasks ────────────────────────────────────────────────────────
  const taskStatusRows = await db.all<{ status: string; cnt: number }>(`
    SELECT status, COUNT(*) as cnt FROM tasks
    WHERE workspace_id = ? AND created_at >= ?
    GROUP BY status
  `, workspaceId, sinceIso);

  const byStatus = {
    open: 0, claimed: 0, completed: 0, escalated: 0, abandoned: 0,
  } as TaskAnalytics['by_status'];
  for (const row of taskStatusRows) {
    if ((TASK_STATUSES as readonly string[]).includes(row.status)) {
      byStatus[row.status as keyof typeof byStatus] = row.cnt;
    }
  }
  const tasksTotal =
    byStatus.open + byStatus.claimed + byStatus.completed + byStatus.escalated + byStatus.abandoned;

  const completionDenom = byStatus.completed + byStatus.abandoned;
  const completionRate = completionDenom > 0 ? byStatus.completed / completionDenom : 0;

  const avgRow = await db.get<{ avg_ms: number | null }>(`
    SELECT AVG((julianday(updated_at) - julianday(created_at)) * 86400000) AS avg_ms
    FROM tasks
    WHERE workspace_id = ? AND status = 'completed' AND created_at >= ?
  `, workspaceId, sinceIso);
  const avgCompletionMs = avgRow!.avg_ms;

  const medianRow = await db.get<{ median: number | null }>(`
    WITH ordered AS (
      SELECT (julianday(updated_at) - julianday(created_at)) * 86400000 AS ms,
             ROW_NUMBER() OVER (ORDER BY (julianday(updated_at) - julianday(created_at))) AS rn,
             COUNT(*) OVER () AS cnt
      FROM tasks
      WHERE workspace_id = ? AND status = 'completed' AND created_at >= ?
    )
    SELECT AVG(ms) AS median FROM ordered
    WHERE cnt > 0 AND rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
  `, workspaceId, sinceIso);
  const medianCompletionMs = medianRow?.median ?? null;

  // ── Events ───────────────────────────────────────────────────────
  const eventTypeRows = await db.all<{ event_type: string; cnt: number }>(`
    SELECT event_type, COUNT(*) as cnt FROM events
    WHERE workspace_id = ? AND created_at >= ?
    GROUP BY event_type
  `, workspaceId, sinceIso);

  const byType = {
    LEARNING: 0, BROADCAST: 0, ESCALATION: 0, ERROR: 0, TASK_UPDATE: 0,
  } as EventAnalytics['by_type'];
  for (const row of eventTypeRows) {
    if ((EVENT_TYPES as readonly string[]).includes(row.event_type)) {
      byType[row.event_type as keyof typeof byType] = row.cnt;
    }
  }
  const eventsTotal = byType.LEARNING + byType.BROADCAST + byType.ESCALATION + byType.ERROR + byType.TASK_UPDATE;

  // Per-hour bucketing for the last 24 hours.
  // hoursAgo 0 = the most recent hour, 23 = 23 hours ago.
  const last24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const perHourRows = await db.all<{ hours_ago: number; cnt: number }>(`
    SELECT CAST((julianday('now') - julianday(created_at)) * 24 AS INTEGER) AS hours_ago,
           COUNT(*) AS cnt
    FROM events
    WHERE workspace_id = ? AND created_at >= ?
    GROUP BY hours_ago
  `, workspaceId, last24hIso);

  const perHour = new Array(24).fill(0) as number[];
  for (const row of perHourRows) {
    if (row.hours_ago >= 0 && row.hours_ago < 24) {
      perHour[row.hours_ago] = row.cnt;
    }
  }

  // ── Agents ───────────────────────────────────────────────────────
  const agentCounts = await db.get<{ total: number; online: number | null }>(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online
    FROM agents WHERE workspace_id = ?
  `, workspaceId);

  const topProducers = await db.all<TopProducer>(`
    SELECT
      a.id AS agent_id,
      COALESCE(e.cnt, 0) AS events,
      COALESCE(t.cnt, 0) AS tasks_completed
    FROM agents a
    LEFT JOIN (
      SELECT created_by, COUNT(*) AS cnt FROM events
      WHERE workspace_id = ? AND created_at >= ?
      GROUP BY created_by
    ) e ON e.created_by = a.id
    LEFT JOIN (
      SELECT claimed_by, COUNT(*) AS cnt FROM tasks
      WHERE workspace_id = ? AND status = 'completed' AND updated_at >= ?
      GROUP BY claimed_by
    ) t ON t.claimed_by = a.id
    WHERE a.workspace_id = ?
      AND (COALESCE(e.cnt, 0) > 0 OR COALESCE(t.cnt, 0) > 0)
    ORDER BY events DESC, tasks_completed DESC, agent_id ASC
    LIMIT 10
  `, workspaceId, sinceIso, workspaceId, sinceIso, workspaceId);

  // ── Context ──────────────────────────────────────────────────────
  const contextTotalRow = await db.get<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM context_entries WHERE workspace_id = ?',
    workspaceId,
  );
  const contextTotal = contextTotalRow!.cnt;

  const contextSinceRow = await db.get<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM context_entries WHERE workspace_id = ? AND created_at >= ?',
    workspaceId, sinceIso,
  );
  const contextSince = contextSinceRow!.cnt;

  const topAuthors = await db.all<TopAuthor>(`
    SELECT created_by AS agent_id, COUNT(*) AS count
    FROM context_entries
    WHERE workspace_id = ? AND created_at >= ?
    GROUP BY created_by
    ORDER BY count DESC, agent_id ASC
    LIMIT 10
  `, workspaceId, sinceIso);

  // ── Messages ─────────────────────────────────────────────────────
  const messagesTotalRow = await db.get<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM messages WHERE workspace_id = ?',
    workspaceId,
  );
  const messagesTotal = messagesTotalRow!.cnt;

  const messagesSinceRow = await db.get<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM messages WHERE workspace_id = ? AND created_at >= ?',
    workspaceId, sinceIso,
  );
  const messagesSince = messagesSinceRow!.cnt;

  return {
    tasks: {
      total: tasksTotal,
      by_status: byStatus,
      completion_rate: completionRate,
      avg_completion_ms: avgCompletionMs,
      median_completion_ms: medianCompletionMs,
    },
    events: {
      total: eventsTotal,
      by_type: byType,
      per_hour_last_24h: perHour,
    },
    agents: {
      total: agentCounts!.total,
      online: agentCounts!.online ?? 0,
      top_producers: topProducers,
    },
    context: {
      total_entries: contextTotal,
      entries_since: contextSince,
      top_authors: topAuthors,
    },
    messages: {
      total: messagesTotal,
      since: messagesSince,
    },
  };
}
