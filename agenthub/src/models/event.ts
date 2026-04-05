import type Database from 'better-sqlite3';
import type { Event, EventType, BroadcastInput, GetUpdatesInput, BroadcastResponse, GetUpdatesResponse, WaitForEventInput, WaitForEventResponse, RecommendedContextEntry } from './types.js';
import { eventBus } from '../services/event-emitter.js';

const RECOMMENDED_CONTEXT_LIMIT = 3;
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
    tags: JSON.parse(row.tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Compute top 2-3 context entries relevant to the caller's recent activity. */
function computeRecommendedContext(
  db: Database.Database,
  teamId: string,
  agentId: string,
): RecommendedContextEntry[] {
  // Look at the caller's recent broadcasts/context-save LEARNING events to extract active tags.
  const recentEventRows = db.prepare(`
    SELECT tags FROM events
    WHERE team_id = ? AND created_by = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(teamId, agentId, RECOMMENDED_ACTIVITY_LOOKBACK) as Array<{ tags: string }>;

  const activeTags = new Set<string>();
  for (const row of recentEventRows) {
    const tags = JSON.parse(row.tags) as string[];
    for (const t of tags) activeTags.add(t);
  }

  let rows: ContextEntryRow[];
  if (activeTags.size > 0) {
    const tagList = Array.from(activeTags);
    const placeholders = tagList.map(() => '?').join(', ');
    rows = db.prepare(`
      SELECT id, key, value, tags, created_by, created_at
      FROM context_entries
      WHERE team_id = ?
        AND created_by != ?
        AND EXISTS (
          SELECT 1 FROM json_each(tags) AS t
          WHERE t.value IN (${placeholders})
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(teamId, agentId, ...tagList, RECOMMENDED_CONTEXT_LIMIT) as ContextEntryRow[];
  } else {
    // No recent activity from this agent — return most-recent team entries (still excluding self).
    rows = db.prepare(`
      SELECT id, key, value, tags, created_by, created_at
      FROM context_entries
      WHERE team_id = ? AND created_by != ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(teamId, agentId, RECOMMENDED_CONTEXT_LIMIT) as ContextEntryRow[];
  }

  return rows.map(rowToRecommended);
}

interface EventRow {
  id: number;
  team_id: string;
  event_type: string;
  message: string;
  tags: string;
  created_by: string;
  created_at: string;
}

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    teamId: row.team_id,
    eventType: row.event_type as EventType,
    message: row.message,
    tags: JSON.parse(row.tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function broadcastEvent(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: BroadcastInput,
): BroadcastResponse {
  const result = db.prepare(`
    INSERT INTO events (team_id, event_type, message, tags, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(teamId, input.event_type, input.message, JSON.stringify(input.tags), agentId);

  const eventId = Number(result.lastInsertRowid);
  eventBus.emit('event', { teamId, eventId });
  return { eventId };
}

export function getUpdates(
  db: Database.Database,
  teamId: string,
  input: GetUpdatesInput,
): GetUpdatesResponse {
  const limit = Math.min(input.limit ?? 50, 200);
  const hasTopics = input.topics && input.topics.length > 0;
  const hasEventType = !!input.event_type;

  let sinceId = input.since_id ?? 0;

  // If since_timestamp is provided and since_id is not, find the corresponding event ID
  if (!input.since_id && input.since_timestamp) {
    const row = db.prepare(`
      SELECT COALESCE(MAX(id), 0) as max_id FROM events
      WHERE team_id = ? AND created_at <= ?
    `).get(teamId, input.since_timestamp) as { max_id: number };
    sinceId = row.max_id;
  }

  const clauses = ['team_id = ?', 'id > ?'];
  const params: unknown[] = [teamId, sinceId];

  if (hasEventType) {
    clauses.push('event_type = ?');
    params.push(input.event_type);
  }

  if (hasTopics) {
    const placeholders = input.topics!.map(() => '?').join(', ');
    clauses.push(`EXISTS (SELECT 1 FROM json_each(tags) AS t WHERE t.value IN (${placeholders}))`);
    params.push(...input.topics!);
  }

  params.push(limit);

  const rows = db.prepare(`
    SELECT * FROM events
    WHERE ${clauses.join(' AND ')}
    ORDER BY id ASC
    LIMIT ?
  `).all(...params) as EventRow[];

  const events = rows.map(rowToEvent);
  const cursor = events.length > 0 ? events[events.length - 1].id : sinceId;

  const includeContext = input.include_context !== false;
  if (input.agent_id && includeContext) {
    const recommended_context = computeRecommendedContext(db, teamId, input.agent_id);
    return { events, cursor, recommended_context };
  }

  return { events, cursor };
}

/** Long-poll wait for matching events. Resolves immediately if any exist, else subscribes
 *  to the eventBus and waits up to timeout_sec for a match. */
export function waitForEvent(
  db: Database.Database,
  teamId: string,
  input: WaitForEventInput,
): Promise<WaitForEventResponse> {
  const timeoutSec = Math.min(Math.max(input.timeout_sec ?? 30, 0), 60);

  const query = (): WaitForEventResponse =>
    getUpdates(db, teamId, {
      since_id: input.since_id,
      topics: input.topics,
      event_type: input.event_type,
    });

  // Fast path: already have matching events
  const initial = query();
  if (initial.events.length > 0) {
    return Promise.resolve(initial);
  }

  // Zero timeout — return empty immediately
  if (timeoutSec === 0) {
    return Promise.resolve(initial);
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

    const onEvent = (payload: { teamId: string; eventId: number }) => {
      if (payload.teamId !== teamId) return;
      if (payload.eventId <= input.since_id) return;
      const result = query();
      if (result.events.length > 0) {
        finish(result);
      }
    };

    const timer = setTimeout(() => {
      finish({ events: [], cursor: input.since_id });
    }, timeoutSec * 1000);

    eventBus.on('event', onEvent);
  });
}

/** Internal helper — broadcast an event without going through HTTP validation */
export function broadcastInternal(
  db: Database.Database,
  teamId: string,
  eventType: EventType,
  message: string,
  tags: string[],
  createdBy: string,
): number {
  const result = db.prepare(`
    INSERT INTO events (team_id, event_type, message, tags, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(teamId, eventType, message, JSON.stringify(tags), createdBy);
  const eventId = Number(result.lastInsertRowid);
  eventBus.emit('event', { teamId, eventId });
  return eventId;
}
