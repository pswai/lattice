import { eventBus } from '../services/event-emitter.js';

const KEEPALIVE_INTERVAL_MS = 30_000;
const BACKFILL_LIMIT = 200;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

export interface SseStreamConfig<TItem, TPayload> {
  /** eventBus topic to subscribe to (e.g. 'event', 'message'). */
  eventName: 'event' | 'message';
  /** Raw Last-Event-ID header value from the client, if any. */
  lastEventId: string | undefined;
  /** Client abort signal for cleanup on disconnect. */
  signal: AbortSignal;
  /** Fetch items with id > sinceId, up to limit. */
  fetchSince: (sinceId: number, limit: number) => Promise<TItem[]>;
  /** Return true if the emitted payload is relevant to this subscriber. */
  matches: (payload: TPayload) => boolean;
  /** Extract the item id from the emitted payload (for floor clamping). */
  payloadId: (payload: TPayload) => number;
  /** Extract the item id from a fetched item. */
  itemId: (item: TItem) => number;
  /** Format an item as an SSE frame (`id: N\nevent: message\ndata: ...\n\n`). */
  formatItem: (item: TItem) => string;
}

/** Build a Server-Sent Events response for a subscriber that backfills from
 *  persistent storage, then streams live items pushed via the process-local
 *  eventBus until the client disconnects. */
export async function createSseStream<TItem, TPayload>(
  config: SseStreamConfig<TItem, TPayload>,
): Promise<Response> {
  let lastSentId = config.lastEventId ? parseInt(config.lastEventId, 10) : 0;
  if (!Number.isFinite(lastSentId) || lastSentId < 0) lastSentId = 0;

  const backfill = await config.fetchSince(lastSentId, BACKFILL_LIMIT);
  if (backfill.length > 0) lastSentId = config.itemId(backfill[backfill.length - 1]);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // controller already closed
        }
      };

      for (const item of backfill) send(config.formatItem(item));

      const handler = (payload: TPayload) => {
        if (!config.matches(payload)) return;
        // Clamp the fetch floor to just below the triggering id so an abnormal
        // Last-Event-ID higher than the true max does not silently drop new items.
        const floor = Math.min(lastSentId, config.payloadId(payload) - 1);
        config.fetchSince(floor, BACKFILL_LIMIT).then((items) => {
          for (const item of items) send(config.formatItem(item));
          if (items.length > 0) lastSentId = config.itemId(items[items.length - 1]);
        }).catch(() => {
          // swallow refetch errors; next event will retry
        });
      };

      eventBus.on(config.eventName, handler);
      const keepalive = setInterval(() => send(':keepalive\n\n'), KEEPALIVE_INTERVAL_MS);

      config.signal.addEventListener('abort', () => {
        eventBus.off(config.eventName, handler);
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
