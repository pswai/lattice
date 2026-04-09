import { useState, useEffect, useRef, useCallback } from 'react';
import http from 'node:http';
import https from 'node:https';
import type { Event } from '../../models/types.js';

interface UseSSEOptions {
  /** SSE endpoint URL */
  url: string;
  /** Auth headers */
  headers: Record<string, string>;
  /** Max events to buffer (oldest dropped first) */
  maxBuffer?: number;
  /** Whether to connect */
  enabled?: boolean;
}

interface UseSSEResult {
  /** Accumulated events (newest last) */
  events: Event[];
  /** Whether the SSE connection is active */
  connected: boolean;
  /** Last connection error, if any */
  error: Error | null;
  /** Clear the event buffer */
  clear: () => void;
}

/**
 * Subscribe to a Lattice SSE event stream using native Node http/https.
 *
 * Node doesn't have EventSource, so we parse SSE frames from a raw
 * http response stream. Handles reconnection with Last-Event-ID
 * for seamless resumption.
 */
export function useSSE(opts: UseSSEOptions): UseSSEResult {
  const { url, headers, maxBuffer = 500, enabled = true } = opts;
  const [events, setEvents] = useState<Event[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Track last event ID for reconnection
  const lastIdRef = useRef<string | undefined>(undefined);
  // Set of seen event IDs for deduplication
  const seenIdsRef = useRef<Set<number>>(new Set());

  const clear = useCallback(() => {
    setEvents([]);
    seenIdsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }

    let destroyed = false;
    let currentReq: http.ClientRequest | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function safeSetConnected(val: boolean) {
      if (!destroyed) setConnected(val);
    }
    function safeSetError(val: Error | null) {
      if (!destroyed) setError(val);
    }

    function clearReconnect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function scheduleReconnect(delayMs: number) {
      clearReconnect();
      if (!destroyed) {
        reconnectTimer = setTimeout(connect, delayMs);
      }
    }

    function connect() {
      if (destroyed) return;
      clearReconnect();

      const parsedUrl = new URL(url);
      const mod = parsedUrl.protocol === 'https:' ? https : http;

      const reqHeaders: Record<string, string> = { ...headers };
      if (lastIdRef.current) {
        reqHeaders['Last-Event-ID'] = lastIdRef.current;
      }

      const req = mod.get(url, { headers: reqHeaders }, (res) => {
        if (destroyed) { res.destroy(); return; }

        if (res.statusCode !== 200) {
          safeSetError(new Error(`SSE: ${res.statusCode}`));
          safeSetConnected(false);
          scheduleReconnect(5000);
          return;
        }

        safeSetConnected(true);
        safeSetError(null);

        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (destroyed) return;
          buffer += chunk;

          // Parse SSE frames: separated by double newlines
          const frames = buffer.split('\n\n');
          // Last element is incomplete — keep it in buffer
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            if (!frame.trim()) continue;
            // Skip keepalive comments
            if (frame.startsWith(':')) continue;

            let eventId: string | undefined;
            let data: string | undefined;

            for (const line of frame.split('\n')) {
              if (line.startsWith('id: ')) {
                eventId = line.slice(4).trim();
              } else if (line.startsWith('data: ')) {
                data = line.slice(6);
              }
            }

            if (eventId) {
              lastIdRef.current = eventId;
            }

            if (data) {
              try {
                const parsed = JSON.parse(data) as Event;
                // Deduplicate: skip events we've already seen
                if (seenIdsRef.current.has(parsed.id)) continue;
                seenIdsRef.current.add(parsed.id);

                // Trim seen-set to prevent unbounded growth
                if (seenIdsRef.current.size > maxBuffer * 2) {
                  const entries = [...seenIdsRef.current].sort((a, b) => a - b);
                  seenIdsRef.current = new Set(entries.slice(entries.length - maxBuffer));
                }

                if (!destroyed) {
                  setEvents(prev => {
                    const next = [...prev, parsed];
                    return next.length > maxBuffer ? next.slice(next.length - maxBuffer) : next;
                  });
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        });

        res.on('end', () => {
          if (destroyed) return;
          safeSetConnected(false);
          scheduleReconnect(1000);
        });

        res.on('error', (err) => {
          if (destroyed) return;
          safeSetError(err);
          safeSetConnected(false);
          scheduleReconnect(5000);
        });
      });

      req.on('error', (err) => {
        if (destroyed) return;
        safeSetError(err);
        safeSetConnected(false);
        scheduleReconnect(5000);
      });

      // Timeout: if no data after 60s, reconnect (server sends keepalive every 30s)
      req.setTimeout(60000, () => {
        if (destroyed) return;
        req.destroy();
        safeSetConnected(false);
        scheduleReconnect(1000);
      });

      currentReq = req;
    }

    connect();

    return () => {
      destroyed = true;
      clearReconnect();
      currentReq?.destroy();
      currentReq = null;
    };
  }, [url, enabled, maxBuffer]); // headers intentionally omitted — stable per client instance

  return { events, connected, error, clear };
}
