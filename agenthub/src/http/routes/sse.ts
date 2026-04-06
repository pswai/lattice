import { Hono } from 'hono';
import type { DbAdapter } from '../../db/adapter.js';
import { getUpdates } from '../../models/event.js';
import { eventBus } from '../../services/event-emitter.js';
import type { Event } from '../../models/types.js';

function formatSSE(event: Event): string {
  return `id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createSseRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  // GET /stream — SSE endpoint for real-time event streaming
  router.get('/stream', async (c) => {
    const { teamId } = c.get('auth');
    const lastEventId = c.req.header('Last-Event-ID');

    // Backfill: send events since Last-Event-ID
    const sinceId = lastEventId ? parseInt(lastEventId, 10) : 0;
    const backfill = await getUpdates(db, teamId, { since_id: sinceId, limit: 200 });

    // Track the latest ID we've sent to avoid duplicates
    let lastSentId = backfill.events.length > 0
      ? backfill.events[backfill.events.length - 1].id
      : sinceId;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        function send(text: string) {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // stream closed
          }
        }

        // Send backfilled events
        for (const event of backfill.events) {
          send(formatSSE(event));
        }

        // Subscribe to new events
        const onEvent = (payload: { teamId: string; eventId: number }) => {
          if (payload.teamId !== teamId) return;
          // Fetch events since our last sent ID to get the full event data
          getUpdates(db, teamId, { since_id: lastSentId, limit: 200 }).then((updates) => {
            for (const event of updates.events) {
              send(formatSSE(event));
            }
            if (updates.events.length > 0) {
              lastSentId = updates.events[updates.events.length - 1].id;
            }
          }).catch(() => {
            // swallow errors in SSE polling
          });
        };

        eventBus.on('event', onEvent);

        // Keepalive every 30 seconds
        const keepalive = setInterval(() => {
          send(':keepalive\n\n');
        }, 30_000);

        // Cleanup on disconnect
        c.req.raw.signal.addEventListener('abort', () => {
          eventBus.off('event', onEvent);
          clearInterval(keepalive);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  return router;
}
