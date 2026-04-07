import type { LatticeEvent } from './types';

export type SseStatus = 'connecting' | 'live' | 'error';

export interface SseConnection {
  status: SseStatus;
  close: () => void;
}

export function createSseConnection(
  token: string,
  onEvent: (event: LatticeEvent) => void,
  onStatusChange: (status: SseStatus) => void,
): SseConnection {
  let es: EventSource | null = null;
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect() {
    if (closed) return;
    onStatusChange('connecting');

    es = new EventSource(`/api/v1/events/stream?token=${encodeURIComponent(token)}`);

    es.onopen = () => {
      retryDelay = 1000;
      onStatusChange('live');
    };

    es.onmessage = (msg) => {
      try {
        const event: LatticeEvent = JSON.parse(msg.data);
        onEvent(event);
      } catch {
        // ignore malformed messages
      }
    };

    es.onerror = () => {
      es?.close();
      onStatusChange('error');
      if (!closed) {
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, 30000);
          connect();
        }, retryDelay);
      }
    };
  }

  connect();

  return {
    status: 'connecting',
    close() {
      closed = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}
