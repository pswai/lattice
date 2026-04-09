import type { DbAdapter } from '../db/adapter.js';
import { jsonArrayTable } from '../db/adapter.js';
import type { Event, EventType, BroadcastInput, GetUpdatesInput, GetUpdatesResponse, WaitForEventInput, WaitForEventResponse, RecommendedContextEntry } from './types.js';
import { eventBus } from '../services/event-emitter.js';
import { sessionRegistry } from '../mcp/session-registry.js';
import { getLogger } from '../logger.js';

import { safeJsonParse } from '../safe-json.js';

const RECOMMENDED_CONTEXT_LIMIT = 5;
const RECOMMENDED_ACTIVITY_LOOKBACK = 10;
const RECOMMENDED_PREVIEW_CHARS = 200;

interface ContextEntryRow {
  id: number;
  key: string;
  value: string;
  tags: string;
  created_by: string;
  created_at: string;
}

function rowToRecommended(row: ContextEntryRow): RecommendedContextEntry {
  const value = row.value ?? '';
  return {
    id: row.id,
    key: row.key,
    preview: value.length > RECOMMENDED_PREVIEW_CHARS
      ? value.slice(0, RECOMMENDED_PREVIEW_CHARS)
      : value,
    tags: safeJsonParse<string[]>(row.tags, []),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Compute context entries relevant to the caller's recent activity.
 *  Extracts tags from BOTH events and claimed tasks, includes own entries,
 *  and weights by recency. Exported for standalone use. */
export async function computeRecommendedContext(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
): Promise<RecommendedContextEntry[]> {
  const activeTags = new Set<string>();

  // 1. Tags from recent events (broadcasts, learnings)
  const recentEventRows = await db.all<{ tags: string }>(`
    SELECT tags FROM events
    WHERE workspace_id = ? AND created_by = ?
    ORDER BY id DESC
    LIMIT ?
  `, workspaceId, agentId, RECOMMENDED_ACTIVITY_LOOKBACK);

  for (const row of recentEventRows) {
    for (const t of safeJsonParse<string[]>(row.tags, [])) activeTags.add(t);
  }

  // 2. Keywords from claimed task descriptions (for task-heavy agents with few events)
  const claimedTasks = await db.all<{ description: string }>(`
    SELECT description FROM tasks
    WHERE workspace_id = ? AND claimed_by = ? AND status = 'claimed'
    ORDER BY created_at DESC
    LIMIT 5
  `, workspaceId, agentId);

  for (const task of claimedTasks) {
    // Extract significant words (4+ chars) as pseudo-tags
    const words = task.description.toLowerCase().split(/\s+/)
      .filter(w => w.length >= 4 && !['this', 'that', 'with', 'from', 'have', 'been', 'will', 'should', 'could', 'would'].includes(w));
    for (const w of words.slice(0, 5)) activeTags.add(w);
  }

  let rows: ContextEntryRow[];
  if (activeTags.size > 0) {
    const tagList = Array.from(activeTags);
    const placeholders = tagList.map(() => '?').join(', ');
    // Include own entries (removed the created_by != ? exclusion) and weight by recency
    rows = await db.all<ContextEntryRow>(`
      SELECT id, key, value, tags, created_by, created_at
      FROM context_entries
      WHERE workspace_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
        AND EXISTS (
          SELECT 1 FROM ${jsonArrayTable(db.dialect, 'tags', 't')}
          WHERE t.value IN (${placeholders})
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `, workspaceId, new Date().toISOString(), ...tagList, RECOMMENDED_CONTEXT_LIMIT);
  } else {
    // No recent activity — return most-recent team entries
    rows = await db.all<ContextEntryRow>(`
      SELECT id, key, value, tags, created_by, created_at
      FROM context_entries
      WHERE workspace_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `, workspaceId, new Date().toISOString(), RECOMMENDED_CONTEXT_LIMIT);
  }

  return rows.map(rowToRecommended);
}

interface EventRow {
  id: number;
  workspace_id: string;
  event_type: string;
  message: string;
  tags: string;
  created_by: string;
  created_at: string;
}

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: row.event_type as EventType,
    message: row.message,
    tags: safeJsonParse<string[]>(row.tags, []),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Persist a domain event and notify in-process listeners via eventBus. */
export async function broadcastEvent(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: BroadcastInput,
): Promise<BroadcastResponse> {
  const result = await db.run(`
    INSERT INTO events (workspace_id, event_type, message, tags, created_by)
    VALUES (?, ?, ?, ?, ?)
  `, workspaceId, input.event_type, input.message, JSON.stringify(input.tags), agentId);

  const eventId = Number(result.lastInsertRowid);
  eventBus.emit('event', { workspaceId, eventId });

  // Push notification to all connected agents in the workspace
  pushBroadcastToSessions(workspaceId, agentId, eventId, input.event_type, input.message);

  return { eventId };
}

/** Poll for events since a cursor, with optional topic/type filters and recommended context. */
export async function getUpdates(
  db: DbAdapter,
  workspaceId: string,
  input: GetUpdatesInput,
): Promise<GetUpdatesResponse> {
  const limit = Math.min(input.limit ?? 50, 200);
  const hasTopics = input.topics && input.topics.length > 0;
  const hasEventType = !!input.event_type;

  let sinceId = input.since_id ?? 0;

  // If since_timestamp is provided and since_id is not, find the corresponding event ID
  if (!input.since_id && input.since_timestamp) {
    const row = await db.get<{ max_id: number }>(`
      SELECT COALESCE(MAX(id), 0) as max_id FROM events
      WHERE workspace_id = ? AND created_at <= ?
    `, workspaceId, input.since_timestamp);
    sinceId = row!.max_id;
  }

  const clauses = ['workspace_id = ?', 'id > ?'];
  const params: unknown[] = [workspaceId, sinceId];

  if (hasEventType) {
    clauses.push('event_type = ?');
    params.push(input.event_type);
  }

  if (hasTopics) {
    const placeholders = input.topics!.map(() => '?').join(', ');
    clauses.push(`EXISTS (SELECT 1 FROM ${jsonArrayTable(db.dialect, 'tags', 't')} WHERE t.value IN (${placeholders}))`);
    params.push(...input.topics!);
  }

  params.push(limit);

  const rows = await db.all<EventRow>(`
    SELECT * FROM events
    WHERE ${clauses.join(' AND ')}
    ORDER BY id ASC
    LIMIT ?
  `, ...params);

  const events = rows.map(rowToEvent);
  const cursor = events.length > 0 ? events[events.length - 1].id : sinceId;

  const includeContext = input.include_context !== false;
  if (input.agent_id && includeContext) {
    const recommended_context = await computeRecommendedContext(db, workspaceId, input.agent_id);
    return { events, cursor, recommended_context };
  }

  return { events, cursor };
}

/** Long-poll wait for matching events. Resolves immediately if any exist, else subscribes
 *  to the eventBus and waits up to timeout_sec for a match. */
export async function waitForEvent(
  db: DbAdapter,
  workspaceId: string,
  input: WaitForEventInput,
): Promise<WaitForEventResponse> {
  const timeoutSec = Math.min(Math.max(input.timeout_sec ?? 30, 0), 60);

  const query = (): Promise<WaitForEventResponse> =>
    getUpdates(db, workspaceId, {
      since_id: input.since_id,
      topics: input.topics,
      event_type: input.event_type,
    });

  // Fast path: already have matching events
  const initial = await query();
  if (initial.events.length > 0) {
    return initial;
  }

  // Zero timeout — return empty immediately
  if (timeoutSec === 0) {
    return initial;
  }

  return new Promise<WaitForEventResponse>((resolve) => {
    let settled = false;

    const cleanup = () => {
      eventBus.off('event', onEvent);
      clearTimeout(timer);
    };

    const finish = (result: WaitForEventResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onEvent = (payload: { workspaceId: string; eventId: number }) => {
      if (payload.workspaceId !== workspaceId) return;
      if (payload.eventId <= input.since_id) return;
      query().then((result) => {
        if (result.events.length > 0) {
          finish(result);
        }
      });
    };

    const timer = setTimeout(() => {
      finish({ events: [], cursor: input.since_id });
    }, timeoutSec * 1000);

    eventBus.on('event', onEvent);
  });
}

/** Internal helper — broadcast an event without going through HTTP validation */
export async function broadcastInternal(
  db: DbAdapter,
  workspaceId: string,
  eventType: EventType,
  message: string,
  tags: string[],
  createdBy: string,
): Promise<number> {
  const result = await db.run(`
    INSERT INTO events (workspace_id, event_type, message, tags, created_by)
    VALUES (?, ?, ?, ?, ?)
  `, workspaceId, eventType, message, JSON.stringify(tags), createdBy);
  const eventId = Number(result.lastInsertRowid);
  eventBus.emit('event', { workspaceId, eventId });

  // Push notification to all connected agents in the workspace
  pushBroadcastToSessions(workspaceId, createdBy, eventId, eventType, message);

  return eventId;
}

/** Push a broadcast event notification to all connected MCP sessions in the workspace (except sender). */
function pushBroadcastToSessions(
  workspaceId: string,
  senderAgentId: string,
  eventId: number,
  eventType: string,
  message: string,
): void {
  const sessions = sessionRegistry.getSessionsForWorkspace(workspaceId);
  for (const session of sessions) {
    // Don't push to the sender
    if (session.agentId === senderAgentId) continue;
    session.server.sendLoggingMessage({
      level: 'info',
      data: JSON.stringify({
        type: 'event_broadcast',
        eventId,
        eventType,
        from: senderAgentId,
        preview: message.slice(0, 200),
      }),
    }, session.sessionId).catch((err) => {
      getLogger().debug('mcp_event_push_failed', {
        eventId,
        toAgent: session.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

interface BroadcastResponse {
  eventId: number;
}
