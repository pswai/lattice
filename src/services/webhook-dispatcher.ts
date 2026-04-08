import type { DbAdapter } from '../db/adapter.js';
import { eventBus } from './event-emitter.js';
import { getLogger } from '../logger.js';
import {
  listActiveWebhooksForEvent,
  createDelivery,
  getPendingDeliveries,
  markDeliverySuccess,
  markDeliveryFailure,
  signPayload,
} from '../models/webhook.js';
import { assertPublicUrl } from './ssrf-guard.js';

interface EventRow {
  id: number;
  workspace_id: string;
  event_type: string;
  message: string;
  tags: string;
  created_by: string;
  created_at: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const WORKER_INTERVAL_MS = 1_000;

/** Handle returned by startWebhookDispatcher for lifecycle control. */
export interface WebhookDispatcher {
  stop: () => void;
  processOnce: () => Promise<void>;
}

/**
 * Start the webhook delivery pipeline — listens for domain events,
 * enqueues deliveries for matching webhooks, and retries on failure.
 */
export function startWebhookDispatcher(
  db: DbAdapter,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): WebhookDispatcher {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  // On each new domain event, create a pending delivery row for matching webhooks.
  const onEvent = (payload: { workspaceId: string; eventId: number }) => {
    (async () => {
      try {
        const eventRow = await db.get<EventRow>(
          'SELECT * FROM events WHERE id = ?',
          payload.eventId,
        );
        if (!eventRow) return;
        const matches = await listActiveWebhooksForEvent(db, payload.workspaceId, eventRow.event_type);
        for (const wh of matches) {
          await createDelivery(db, wh.id, eventRow.id);
        }
        // Kick the worker immediately for low latency.
        void processOnce();
      } catch (err) {
        getLogger().error('webhook_enqueue_failed', {
          component: 'webhook-dispatcher',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };
  eventBus.on('event', onEvent);

  let running = false;
  async function processOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const pending = await getPendingDeliveries(db, 25);
      // Process deliveries sequentially to avoid concurrent SQLite transactions
      for (const d of pending) {
        await deliverOne(db, d, fetchImpl, timeoutMs);
      }
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
  db: DbAdapter,
  delivery: Awaited<ReturnType<typeof getPendingDeliveries>>[number],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const eventRow = await db.get<EventRow>(
    'SELECT * FROM events WHERE id = ?',
    delivery.eventId,
  );
  if (!eventRow) {
    // Event was cleaned up before delivery — drop.
    await markDeliveryFailure(db, delivery.id, delivery.webhookId, null, 'event not found', false);
    return;
  }

  const envelope = {
    id: delivery.id,
    event_id: delivery.eventId,
    event_type: eventRow.event_type,
    workspace_id: eventRow.workspace_id,
    message: eventRow.message,
    tags: JSON.parse(eventRow.tags),
    created_by: eventRow.created_by,
    created_at: eventRow.created_at,
  };
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(delivery.secret, timestamp, body);

  // Defense in depth — re-check at dispatch time in case policy changed
  // or the URL was inserted before the guard existed.
  try {
    assertPublicUrl(delivery.url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn('webhook_url_blocked', {
      component: 'webhook-dispatcher',
      delivery_id: delivery.id,
      webhook_id: delivery.webhookId,
      reason: msg,
    });
    await markDeliveryFailure(db, delivery.id, delivery.webhookId, null, msg, false);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(delivery.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Lattice-Webhooks/1.0',
        'X-Lattice-Event': eventRow.event_type,
        'X-Lattice-Delivery': delivery.id,
        'X-Lattice-Signature': signature,
      },
      body,
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      await markDeliverySuccess(db, delivery.id, delivery.webhookId, res.status);
    } else if (res.status >= 400 && res.status < 500) {
      // 4xx is a terminal client error — do not retry.
      await markDeliveryFailure(
        db,
        delivery.id,
        delivery.webhookId,
        res.status,
        `HTTP ${res.status}`,
        false,
      );
    } else {
      await markDeliveryFailure(
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
    await markDeliveryFailure(db, delivery.id, delivery.webhookId, null, msg, true);
  } finally {
    clearTimeout(timer);
  }
}
