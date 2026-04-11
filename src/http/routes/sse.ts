import { Hono } from 'hono';
import type { DbAdapter } from '../../db/adapter.js';
import { getUpdates } from '../../models/event.js';
import type { Event } from '../../models/types.js';
import { createSseStream } from '../sse-helper.js';

function formatEventSSE(event: Event): string {
  return `id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createSseRoutes(db: DbAdapter): Hono {
  const router = new Hono();

  router.get('/stream', async (c) => {
    const { workspaceId } = c.get('auth');

    return createSseStream<Event, { workspaceId: string; eventId: number }>({
      eventName: 'event',
      lastEventId: c.req.header('Last-Event-ID'),
      signal: c.req.raw.signal,
      fetchSince: async (sinceId, limit) => {
        const res = await getUpdates(db, workspaceId, { since_id: sinceId, limit });
        return res.events;
      },
      matches: (p) => p.workspaceId === workspaceId,
      payloadId: (p) => p.eventId,
      itemId: (e) => e.id,
      formatItem: formatEventSSE,
    });
  });

  return router;
}
