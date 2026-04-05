import type Database from 'better-sqlite3';

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

export interface TeamAnalytics {
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

export function getTeamAnalytics(
  db: Database.Database,
  teamId: string,
  sinceIso: string,
): TeamAnalytics {
  // ── Tasks ────────────────────────────────────────────────────────
  const taskStatusRows = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM tasks
    WHERE team_id = ? AND created_at >= ?
    GROUP BY status
  `).all(teamId, sinceIso) as Array<{ status: string; cnt: number }>;

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

  const avgRow = db.prepare(`
    SELECT AVG((julianday(updated_at) - julianday(created_at)) * 86400000) AS avg_ms
    FROM tasks
    WHERE team_id = ? AND status = 'completed' AND created_at >= ?
  `).get(teamId, sinceIso) as { avg_ms: number | null };
  const avgCompletionMs = avgRow.avg_ms;

  const medianRow = db.prepare(`
    WITH ordered AS (
      SELECT (julianday(updated_at) - julianday(created_at)) * 86400000 AS ms,
             ROW_NUMBER() OVER (ORDER BY (julianday(updated_at) - julianday(created_at))) AS rn,
             COUNT(*) OVER () AS cnt
      FROM tasks
      WHERE team_id = ? AND status = 'completed' AND created_at >= ?
    )
    SELECT AVG(ms) AS median FROM ordered
    WHERE cnt > 0 AND rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
  `).get(teamId, sinceIso) as { median: number | null };
  const medianCompletionMs = medianRow?.median ?? null;

  // ── Events ───────────────────────────────────────────────────────
  const eventTypeRows = db.prepare(`
    SELECT event_type, COUNT(*) as cnt FROM events
    WHERE team_id = ? AND created_at >= ?
    GROUP BY event_type
  `).all(teamId, sinceIso) as Array<{ event_type: string; cnt: number }>;

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
  const perHourRows = db.prepare(`
    SELECT CAST((julianday('now') - julianday(created_at)) * 24 AS INTEGER) AS hours_ago,
           COUNT(*) AS cnt
    FROM events
    WHERE team_id = ? AND created_at >= ?
    GROUP BY hours_ago
  `).all(teamId, last24hIso) as Array<{ hours_ago: number; cnt: number }>;

  const perHour = new Array(24).fill(0) as number[];
  for (const row of perHourRows) {
    if (row.hours_ago >= 0 && row.hours_ago < 24) {
      perHour[row.hours_ago] = row.cnt;
    }
  }

  // ── Agents ───────────────────────────────────────────────────────
  const agentCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online
    FROM agents WHERE team_id = ?
  `).get(teamId) as { total: number; online: number | null };

  const topProducers = db.prepare(`
    SELECT
      a.id AS agent_id,
      COALESCE(e.cnt, 0) AS events,
      COALESCE(t.cnt, 0) AS tasks_completed
    FROM agents a
    LEFT JOIN (
      SELECT created_by, COUNT(*) AS cnt FROM events
      WHERE team_id = ? AND created_at >= ?
      GROUP BY created_by
    ) e ON e.created_by = a.id
    LEFT JOIN (
      SELECT claimed_by, COUNT(*) AS cnt FROM tasks
      WHERE team_id = ? AND status = 'completed' AND updated_at >= ?
      GROUP BY claimed_by
    ) t ON t.claimed_by = a.id
    WHERE a.team_id = ?
      AND (COALESCE(e.cnt, 0) > 0 OR COALESCE(t.cnt, 0) > 0)
    ORDER BY events DESC, tasks_completed DESC, agent_id ASC
    LIMIT 10
  `).all(teamId, sinceIso, teamId, sinceIso, teamId) as TopProducer[];

  // ── Context ──────────────────────────────────────────────────────
  const contextTotal = (db.prepare(
    'SELECT COUNT(*) AS cnt FROM context_entries WHERE team_id = ?',
  ).get(teamId) as { cnt: number }).cnt;

  const contextSince = (db.prepare(
    'SELECT COUNT(*) AS cnt FROM context_entries WHERE team_id = ? AND created_at >= ?',
  ).get(teamId, sinceIso) as { cnt: number }).cnt;

  const topAuthors = db.prepare(`
    SELECT created_by AS agent_id, COUNT(*) AS count
    FROM context_entries
    WHERE team_id = ? AND created_at >= ?
    GROUP BY created_by
    ORDER BY count DESC, agent_id ASC
    LIMIT 10
  `).all(teamId, sinceIso) as TopAuthor[];

  // ── Messages ─────────────────────────────────────────────────────
  const messagesTotal = (db.prepare(
    'SELECT COUNT(*) AS cnt FROM messages WHERE team_id = ?',
  ).get(teamId) as { cnt: number }).cnt;

  const messagesSince = (db.prepare(
    'SELECT COUNT(*) AS cnt FROM messages WHERE team_id = ? AND created_at >= ?',
  ).get(teamId, sinceIso) as { cnt: number }).cnt;

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
      total: agentCounts.total,
      online: agentCounts.online ?? 0,
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
