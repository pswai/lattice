import type Database from 'better-sqlite3';
import { randomBytes, createHmac } from 'crypto';
import { NotFoundError, ValidationError } from '../errors.js';

export interface Webhook {
  id: string;
  teamId: string;
  url: string;
  secret: string;
  eventTypes: string[];
  active: boolean;
  failureCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: number;
  status: 'pending' | 'success' | 'failed' | 'dead';
  responseCode: number | null;
  attempts: number;
  nextRetryAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookRow {
  id: string;
  team_id: string;
  url: string;
  secret: string;
  event_types: string;
  active: number;
  failure_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: number;
  status: string;
  response_code: number | null;
  attempts: number;
  next_retry_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    teamId: row.team_id,
    url: row.url,
    secret: row.secret,
    eventTypes: JSON.parse(row.event_types) as string[],
    active: row.active === 1,
    failureCount: row.failure_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    status: row.status as WebhookDelivery['status'],
    responseCode: row.response_code,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function generateWebhookId(): string {
  return 'whk_' + randomBytes(12).toString('hex');
}

export function generateDeliveryId(): string {
  return 'dlv_' + randomBytes(12).toString('hex');
}

export function generateSecret(): string {
  return 'whsk_' + randomBytes(24).toString('base64url');
}

const VALID_EVENT_TYPES = ['*', 'LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE'];

export interface CreateWebhookInput {
  url: string;
  event_types?: string[];
}

export function createWebhook(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: CreateWebhookInput,
): Webhook {
  try {
    const parsed = new URL(input.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ValidationError('url must be http(s)');
    }
  } catch {
    throw new ValidationError('Invalid url');
  }

  const eventTypes = input.event_types ?? ['*'];
  if (eventTypes.length === 0) {
    throw new ValidationError('event_types must be non-empty');
  }
  for (const t of eventTypes) {
    if (!VALID_EVENT_TYPES.includes(t)) {
      throw new ValidationError(
        `Invalid event_type '${t}'. Allowed: ${VALID_EVENT_TYPES.join(', ')}`,
      );
    }
  }

  const id = generateWebhookId();
  const secret = generateSecret();

  db.prepare(`
    INSERT INTO webhooks (id, team_id, url, secret, event_types, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, teamId, input.url, secret, JSON.stringify(eventTypes), agentId);

  return getWebhook(db, teamId, id);
}

export function getWebhook(
  db: Database.Database,
  teamId: string,
  id: string,
): Webhook {
  const row = db
    .prepare('SELECT * FROM webhooks WHERE id = ? AND team_id = ?')
    .get(id, teamId) as WebhookRow | undefined;
  if (!row) throw new NotFoundError('Webhook', id);
  return rowToWebhook(row);
}

export function listWebhooks(db: Database.Database, teamId: string): Webhook[] {
  const rows = db
    .prepare('SELECT * FROM webhooks WHERE team_id = ? ORDER BY created_at DESC')
    .all(teamId) as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function deleteWebhook(
  db: Database.Database,
  teamId: string,
  id: string,
): { deleted: boolean } {
  const result = db
    .prepare('DELETE FROM webhooks WHERE id = ? AND team_id = ?')
    .run(id, teamId);
  if (result.changes === 0) throw new NotFoundError('Webhook', id);
  return { deleted: true };
}

export function listActiveWebhooksForEvent(
  db: Database.Database,
  teamId: string,
  eventType: string,
): Webhook[] {
  const rows = db
    .prepare('SELECT * FROM webhooks WHERE team_id = ? AND active = 1')
    .all(teamId) as WebhookRow[];
  return rows
    .map(rowToWebhook)
    .filter((w) => w.eventTypes.includes('*') || w.eventTypes.includes(eventType));
}

export function createDelivery(
  db: Database.Database,
  webhookId: string,
  eventId: number,
): WebhookDelivery {
  const id = generateDeliveryId();
  db.prepare(`
    INSERT INTO webhook_deliveries (id, webhook_id, event_id, next_retry_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(id, webhookId, eventId);
  const row = db
    .prepare('SELECT * FROM webhook_deliveries WHERE id = ?')
    .get(id) as DeliveryRow;
  return rowToDelivery(row);
}

export function listDeliveries(
  db: Database.Database,
  teamId: string,
  webhookId: string,
  limit = 100,
): WebhookDelivery[] {
  // Verify the webhook belongs to this team before exposing deliveries
  getWebhook(db, teamId, webhookId);
  const rows = db
    .prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(webhookId, Math.min(limit, 200)) as DeliveryRow[];
  return rows.map(rowToDelivery);
}

export function getPendingDeliveries(
  db: Database.Database,
  limit = 50,
): Array<WebhookDelivery & { teamId: string; url: string; secret: string; failureCount: number }> {
  const rows = db
    .prepare(`
      SELECT d.*, w.team_id, w.url, w.secret, w.failure_count
      FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'pending'
        AND w.active = 1
        AND (d.next_retry_at IS NULL OR d.next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ORDER BY d.next_retry_at ASC
      LIMIT ?
    `)
    .all(limit) as Array<DeliveryRow & {
      team_id: string;
      url: string;
      secret: string;
      failure_count: number;
    }>;
  return rows.map((row) => ({
    ...rowToDelivery(row),
    teamId: row.team_id,
    url: row.url,
    secret: row.secret,
    failureCount: row.failure_count,
  }));
}

// Retry schedule: 1s, 5s, 30s, 5min, 30min, 2h, 6h (7 attempts total)
export const RETRY_SCHEDULE_MS = [
  1_000,
  5_000,
  30_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];

export const MAX_CONSECUTIVE_FAILURES = 20;

export function markDeliverySuccess(
  db: Database.Database,
  deliveryId: string,
  webhookId: string,
  responseCode: number,
): void {
  db.transaction(() => {
    db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'success', response_code = ?, attempts = attempts + 1,
          next_retry_at = NULL, error = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(responseCode, deliveryId);
    db.prepare(`
      UPDATE webhooks SET failure_count = 0,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(webhookId);
  })();
}

export function markDeliveryFailure(
  db: Database.Database,
  deliveryId: string,
  webhookId: string,
  responseCode: number | null,
  errorMessage: string,
  isRetriable: boolean,
): void {
  db.transaction(() => {
    const row = db
      .prepare('SELECT attempts FROM webhook_deliveries WHERE id = ?')
      .get(deliveryId) as { attempts: number } | undefined;
    if (!row) return;
    const nextAttempt = row.attempts + 1;

    let status: 'pending' | 'failed' | 'dead' = 'pending';
    let nextRetryAt: string | null = null;
    if (!isRetriable) {
      status = 'failed';
    } else if (nextAttempt >= RETRY_SCHEDULE_MS.length) {
      status = 'dead';
    } else {
      nextRetryAt = new Date(Date.now() + RETRY_SCHEDULE_MS[nextAttempt]).toISOString();
    }

    db.prepare(`
      UPDATE webhook_deliveries
      SET status = ?, response_code = ?, attempts = ?, next_retry_at = ?, error = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(status, responseCode, nextAttempt, nextRetryAt, errorMessage.slice(0, 500), deliveryId);

    // Bump failure_count on the webhook; disable if threshold reached.
    const whRow = db
      .prepare('SELECT failure_count FROM webhooks WHERE id = ?')
      .get(webhookId) as { failure_count: number } | undefined;
    if (!whRow) return;
    const newFailureCount = whRow.failure_count + 1;
    const disable = newFailureCount >= MAX_CONSECUTIVE_FAILURES;
    db.prepare(`
      UPDATE webhooks SET failure_count = ?,
          active = CASE WHEN ? THEN 0 ELSE active END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(newFailureCount, disable ? 1 : 0, webhookId);
  })();
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${hex}`;
}
