import type { DbAdapter } from '../db/adapter.js';

/** Coerce Postgres bigint strings (and any other non-number) to a JS number. */
function num(v: unknown): number {
  return Number(v) || 0;
}

/**
 * Dialect-aware SQL for computing millisecond difference between two timestamp columns.
 * SQLite uses julianday(); Postgres uses EXTRACT(EPOCH FROM ...).
 */
function msDiffExpr(dialect: 'sqlite' | 'pg', col1: string, col2: string): string {
  if (dialect === 'sqlite') {
    return `(julianday(${col1}) - julianday(${col2})) * 86400000`;
  }
  return `EXTRACT(EPOCH FROM (${col1}::timestamptz - ${col2}::timestamptz)) * 1000`;
}

/**
 * Dialect-aware SQL for computing hours ago from now for a timestamp column.
 * SQLite uses julianday(); Postgres uses EXTRACT(EPOCH FROM ...).
 */
function hoursAgoExpr(dialect: 'sqlite' | 'pg', col: string): string {
  if (dialect === 'sqlite') {
    return `CAST((julianday('now') - julianday(${col})) * 24 AS INTEGER)`;
  }
  return `CAST(EXTRACT(EPOCH FROM (NOW() - ${col}::timestamptz)) / 3600 AS INTEGER)`;
}

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
      byStatus[row.status as keyof typeof byStatus] = num(row.cnt);
    }
  }
  const tasksTotal =
    byStatus.open + byStatus.claimed + byStatus.completed + byStatus.escalated + byStatus.abandoned;

  const completionDenom = byStatus.completed + byStatus.abandoned;
  const completionRate = completionDenom > 0 ? byStatus.completed / completionDenom : 0;

  const msDiff = msDiffExpr(db.dialect, 'updated_at', 'created_at');

  const avgRow = await db.get<{ avg_ms: number | null }>(`
    SELECT AVG(${msDiff}) AS avg_ms
    FROM tasks
    WHERE workspace_id = ? AND status = 'completed' AND created_at >= ?
  `, workspaceId, sinceIso);
  const avgCompletionMs = avgRow?.avg_ms != null ? num(avgRow.avg_ms) : null;

  const medianRow = await db.get<{ median: number | null }>(`
    WITH ordered AS (
      SELECT ${msDiff} AS ms,
             ROW_NUMBER() OVER (ORDER BY ${msDiff}) AS rn,
             COUNT(*) OVER () AS cnt
      FROM tasks
      WHERE workspace_id = ? AND status = 'completed' AND created_at >= ?
    )
    SELECT AVG(ms) AS median FROM ordered
    WHERE cnt > 0 AND rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
  `, workspaceId, sinceIso);
  const medianCompletionMs = medianRow?.median != null ? num(medianRow.median) : null;

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
      byType[row.event_type as keyof typeof byType] = num(row.cnt);
    }
  }
  const eventsTotal = byType.LEARNING + byType.BROADCAST + byType.ESCALATION + byType.ERROR + byType.TASK_UPDATE;

  // Per-hour bucketing for the last 24 hours.
  // hoursAgo 0 = the most recent hour, 23 = 23 hours ago.
  const last24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const perHourRows = await db.all<{ hours_ago: number; cnt: number }>(`
    SELECT ${hoursAgoExpr(db.dialect, 'created_at')} AS hours_ago,
           COUNT(*) AS cnt
    FROM events
    WHERE workspace_id = ? AND created_at >= ?
    GROUP BY hours_ago
  `, workspaceId, last24hIso);

  const perHour = new Array(24).fill(0) as number[];
  for (const row of perHourRows) {
    const h = num(row.hours_ago);
    if (h >= 0 && h < 24) {
      perHour[h] = num(row.cnt);
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
  const contextTotal = num(contextTotalRow!.cnt);

  const contextSinceRow = await db.get<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM context_entries WHERE workspace_id = ? AND created_at >= ?',
    workspaceId, sinceIso,
  );
  const contextSince = num(contextSinceRow!.cnt);

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
  const messagesTotal = num(messagesTotalRow!.cnt);

  const messagesSinceRow = await db.get<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM messages WHERE workspace_id = ? AND created_at >= ?',
    workspaceId, sinceIso,
  );
  const messagesSince = num(messagesSinceRow!.cnt);

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
      total: num(agentCounts!.total),
      online: num(agentCounts!.online),
      top_producers: topProducers.map((p) => ({
        agent_id: p.agent_id,
        events: num(p.events),
        tasks_completed: num(p.tasks_completed),
      })),
    },
    context: {
      total_entries: contextTotal,
      entries_since: contextSince,
      top_authors: topAuthors.map((a) => ({ agent_id: a.agent_id, count: num(a.count) })),
    },
    messages: {
      total: messagesTotal,
      since: messagesSince,
    },
  };
}
