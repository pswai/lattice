import type Database from 'better-sqlite3';
import { eventBus } from './event-emitter.js';
import {
  listActiveWebhooksForEvent,
  createDelivery,
  getPendingDeliveries,
  markDeliverySuccess,
  markDeliveryFailure,
  signPayload,
} from '../models/webhook.js';

interface EventRow {
  id: number;
  team_id: string;
  event_type: string;
  message: string;
  tags: string;
  created_by: string;
  created_at: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const WORKER_INTERVAL_MS = 1_000;

export interface WebhookDispatcher {
  stop: () => void;
  processOnce: () => Promise<void>;
}

export function startWebhookDispatcher(
  db: Database.Database,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): WebhookDispatcher {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  // On each new domain event, create a pending delivery row for matching webhooks.
  const onEvent = (payload: { teamId: string; eventId: number }) => {
    try {
      const eventRow = db
        .prepare('SELECT * FROM events WHERE id = ?')
        .get(payload.eventId) as EventRow | undefined;
      if (!eventRow) return;
      const matches = listActiveWebhooksForEvent(db, payload.teamId, eventRow.event_type);
      for (const wh of matches) {
        createDelivery(db, wh.id, eventRow.id);
      }
      // Kick the worker immediately for low latency.
      void processOnce();
    } catch (err) {
      console.error('webhook-dispatcher: enqueue failed', err);
    }
  };
  eventBus.on('event', onEvent);

  let running = false;
  async function processOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const pending = getPendingDeliveries(db, 25);
      await Promise.all(pending.map((d) => deliverOne(db, d, fetchImpl, timeoutMs)));
    } finally {
      running = false;
    }
  }

  const interval = setInterval(() => {
    void processOnce();
  }, opts.intervalMs ?? WORKER_INTERVAL_MS);
  // Don't block node process exit.
  if (typeof interval === 'object' && interval !== null && 'unref' in interval) {
    (interval as { unref?: () => void }).unref?.();
  }

  return {
    stop: () => {
      eventBus.off('event', onEvent);
      clearInterval(interval);
    },
    processOnce,
  };
}

async function deliverOne(
  db: Database.Database,
  delivery: Awaited<ReturnType<typeof getPendingDeliveries>>[number],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const eventRow = db
    .prepare('SELECT * FROM events WHERE id = ?')
    .get(delivery.eventId) as EventRow | undefined;
  if (!eventRow) {
    // Event was cleaned up before delivery — drop.
    markDeliveryFailure(db, delivery.id, delivery.webhookId, null, 'event not found', false);
    return;
  }

  const envelope = {
    id: delivery.id,
    event_id: delivery.eventId,
    event_type: eventRow.event_type,
    team_id: eventRow.team_id,
    message: eventRow.message,
    tags: JSON.parse(eventRow.tags),
    created_by: eventRow.created_by,
    created_at: eventRow.created_at,
  };
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(delivery.secret, timestamp, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AgentHub-Webhooks/1.0',
        'X-AgentHub-Event': eventRow.event_type,
        'X-AgentHub-Delivery': delivery.id,
        'X-AgentHub-Signature': signature,
      },
      body,
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      markDeliverySuccess(db, delivery.id, delivery.webhookId, res.status);
    } else if (res.status >= 400 && res.status < 500) {
      // 4xx is a terminal client error — do not retry.
      markDeliveryFailure(
        db,
        delivery.id,
        delivery.webhookId,
        res.status,
        `HTTP ${res.status}`,
        false,
      );
    } else {
      markDeliveryFailure(
        db,
        delivery.id,
        delivery.webhookId,
        res.status,
        `HTTP ${res.status}`,
        true,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markDeliveryFailure(db, delivery.id, delivery.webhookId, null, msg, true);
  } finally {
    clearTimeout(timer);
  }
}
