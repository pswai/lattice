import type { DbAdapter } from '../db/adapter.js';
import { randomBytes, createHmac } from 'crypto';
import { NotFoundError, ValidationError } from '../errors.js';
import { assertPublicUrl } from '../services/ssrf-guard.js';

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

export async function createWebhook(
  db: DbAdapter,
  teamId: string,
  agentId: string,
  input: CreateWebhookInput,
): Promise<Webhook> {
  try {
    const parsed = new URL(input.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ValidationError('url must be http(s)');
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('Invalid url');
  }

  try {
    assertPublicUrl(input.url);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ValidationError(err.message);
    }
    throw err;
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

  await db.run(`
    INSERT INTO webhooks (id, team_id, url, secret, event_types, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `, id, teamId, input.url, secret, JSON.stringify(eventTypes), agentId);

  return getWebhook(db, teamId, id);
}

export async function getWebhook(
  db: DbAdapter,
  teamId: string,
  id: string,
): Promise<Webhook> {
  const row = await db.get<WebhookRow>(
    'SELECT * FROM webhooks WHERE id = ? AND team_id = ?',
    id, teamId,
  );
  if (!row) throw new NotFoundError('Webhook', id);
  return rowToWebhook(row);
}

export async function listWebhooks(db: DbAdapter, teamId: string): Promise<Webhook[]> {
  const rows = await db.all<WebhookRow>(
    'SELECT * FROM webhooks WHERE team_id = ? ORDER BY created_at DESC',
    teamId,
  );
  return rows.map(rowToWebhook);
}

export async function deleteWebhook(
  db: DbAdapter,
  teamId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  const result = await db.run(
    'DELETE FROM webhooks WHERE id = ? AND team_id = ?',
    id, teamId,
  );
  if (result.changes === 0) throw new NotFoundError('Webhook', id);
  return { deleted: true };
}

export async function listActiveWebhooksForEvent(
  db: DbAdapter,
  teamId: string,
  eventType: string,
): Promise<Webhook[]> {
  const rows = await db.all<WebhookRow>(
    'SELECT * FROM webhooks WHERE team_id = ? AND active = 1',
    teamId,
  );
  return rows
    .map(rowToWebhook)
    .filter((w) => w.eventTypes.includes('*') || w.eventTypes.includes(eventType));
}

export async function createDelivery(
  db: DbAdapter,
  webhookId: string,
  eventId: number,
): Promise<WebhookDelivery> {
  const id = generateDeliveryId();
  await db.run(`
    INSERT INTO webhook_deliveries (id, webhook_id, event_id, next_retry_at)
    VALUES (?, ?, ?, ?)
  `, id, webhookId, eventId, new Date().toISOString());
  const row = await db.get<DeliveryRow>(
    'SELECT * FROM webhook_deliveries WHERE id = ?',
    id,
  );
  return rowToDelivery(row!);
}

export async function listDeliveries(
  db: DbAdapter,
  teamId: string,
  webhookId: string,
  limit = 100,
): Promise<WebhookDelivery[]> {
  // Verify the webhook belongs to this team before exposing deliveries
  await getWebhook(db, teamId, webhookId);
  const rows = await db.all<DeliveryRow>(
    'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?',
    webhookId, Math.min(limit, 200),
  );
  return rows.map(rowToDelivery);
}

export async function getPendingDeliveries(
  db: DbAdapter,
  limit = 50,
): Promise<Array<WebhookDelivery & { teamId: string; url: string; secret: string; failureCount: number }>> {
  const rows = await db.all<DeliveryRow & {
    team_id: string;
    url: string;
    secret: string;
    failure_count: number;
  }>(`
    SELECT d.*, w.team_id, w.url, w.secret, w.failure_count
    FROM webhook_deliveries d
    JOIN webhooks w ON w.id = d.webhook_id
    WHERE d.status = 'pending'
      AND w.active = 1
      AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)
    ORDER BY d.next_retry_at ASC
    LIMIT ?
  `, new Date().toISOString(), limit);
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

export async function markDeliverySuccess(
  db: DbAdapter,
  deliveryId: string,
  webhookId: string,
  responseCode: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE webhook_deliveries
      SET status = 'success', response_code = ?, attempts = attempts + 1,
          next_retry_at = NULL, error = NULL,
          updated_at = ?
      WHERE id = ?
    `, responseCode, new Date().toISOString(), deliveryId);
    await tx.run(`
      UPDATE webhooks SET failure_count = 0,
          updated_at = ?
      WHERE id = ?
    `, new Date().toISOString(), webhookId);
  });
}

export async function markDeliveryFailure(
  db: DbAdapter,
  deliveryId: string,
  webhookId: string,
  responseCode: number | null,
  errorMessage: string,
  isRetriable: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await tx.get<{ attempts: number }>(
      'SELECT attempts FROM webhook_deliveries WHERE id = ?',
      deliveryId,
    );
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

    await tx.run(`
      UPDATE webhook_deliveries
      SET status = ?, response_code = ?, attempts = ?, next_retry_at = ?, error = ?,
          updated_at = ?
      WHERE id = ?
    `, status, responseCode, nextAttempt, nextRetryAt, errorMessage.slice(0, 500), new Date().toISOString(), deliveryId);

    // Bump failure_count on the webhook; disable if threshold reached.
    const whRow = await tx.get<{ failure_count: number }>(
      'SELECT failure_count FROM webhooks WHERE id = ?',
      webhookId,
    );
    if (!whRow) return;
    const newFailureCount = whRow.failure_count + 1;
    const disable = newFailureCount >= MAX_CONSECUTIVE_FAILURES;
    await tx.run(`
      UPDATE webhooks SET failure_count = ?,
          active = CASE WHEN ? THEN 0 ELSE active END,
          updated_at = ?
      WHERE id = ?
    `, newFailureCount, disable ? 1 : 0, new Date().toISOString(), webhookId);
  });
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${hex}`;
}
