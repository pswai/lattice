import { useEffect, useRef, useState, useCallback } from 'react';
import { createSseConnection, type SseStatus } from '../lib/sse';
import type { LatticeEvent } from '../lib/types';

const MAX_EVENTS = 100;

interface UseSSEOptions {
  token: string | null;
  onTaskUpdate?: () => void;
}

interface UseSSEReturn {
  status: SseStatus;
  events: LatticeEvent[];
}

export function useSSE({ token, onTaskUpdate }: UseSSEOptions): UseSSEReturn {
  const [status, setStatus] = useState<SseStatus>('connecting');
  const [events, setEvents] = useState<LatticeEvent[]>([]);
  const onTaskUpdateRef = useRef(onTaskUpdate);
  onTaskUpdateRef.current = onTaskUpdate;

  const handleEvent = useCallback((event: LatticeEvent) => {
    setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
    if (
      event.eventType === 'TASK_UPDATE' ||
      event.tags?.includes('agent-registry')
    ) {
      onTaskUpdateRef.current?.();
    }
  }, []);

  useEffect(() => {
    if (!token) return;

    const conn = createSseConnection(token, handleEvent, setStatus);
    return () => conn.close();
  }, [token, handleEvent]);

  return { status, events };
}
