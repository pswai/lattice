import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { Event, EventType } from '../../models/types.js';
import type { LatticeClient } from '../client.js';
import { useSSE } from '../hooks/use-sse.js';
import { usePolling } from '../hooks/use-polling.js';
import { useListNav } from '../hooks/use-list-nav.js';
import { colors, symbols, timeAgo, truncate } from '../theme.js';

const EVENT_TYPES: Array<EventType | 'ALL'> = ['ALL', 'LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE'];

interface EventsPanelProps {
  client: LatticeClient;
  active: boolean;
  height: number;
}

export function EventsPanel({ client, active, height }: EventsPanelProps) {
  const [typeFilter, setTypeFilter] = useState<EventType | 'ALL'>('ALL');
  const [tail, setTail] = useState(true);
  const [pane, setPane] = useState<'list' | 'detail'>('list');

  // SSE: real-time stream, always connected when panel is active
  const sse = useSSE({
    url: client.sseUrl(),
    headers: client.authHeaders,
    enabled: active,
    maxBuffer: 500,
  });

  // Polling fallback: only used when SSE is down, or for filtered queries in scroll mode
  const needsPolling = !tail || !sse.connected;
  const { data: pollData, error: pollError, loading: pollLoading, refresh } = usePolling(
    () => client.listEvents({
      limit: 200,
      ...(typeFilter !== 'ALL' ? { event_type: typeFilter } : {}),
    }),
    5000,
    { enabled: active && needsPolling },
  );

  // Merge events: in tail mode, prefer SSE; in scroll mode, use polling
  const events = useMemo(() => {
    if (tail) {
      // SSE events are newest-last; reverse for tail (newest first)
      let src = sse.connected ? sse.events : (pollData?.events ?? []);
      // Apply type filter client-side on SSE data
      if (typeFilter !== 'ALL') {
        src = src.filter(e => e.eventType === typeFilter);
      }
      return [...src].reverse();
    }
    // Scroll mode: use polled data (server-filtered)
    return pollData?.events ?? [];
  }, [tail, sse.connected, sse.events, pollData, typeFilter]);

  const listHeight = Math.max(1, height - 3);
  const { selectedIndex, scrollOffset } = useListNav(events.length, listHeight, {
    enabled: active && !tail && pane === 'list',
  });

  const selected = !tail ? events[selectedIndex] ?? null : null;

  const error = sse.error ?? pollError;
  const loading = pollLoading && !pollData && !sse.connected;

  useInput((input, key) => {
    if (!active) return;

    if (input === 'f') {
      const idx = EVENT_TYPES.indexOf(typeFilter);
      setTypeFilter(EVENT_TYPES[(idx + 1) % EVENT_TYPES.length]);
    }
    if (input === 't') setTail(!tail);
    if (input === 'r') refresh();
    if (input === 'l' || key.rightArrow) setPane('detail');
    if (input === 'h' || key.leftArrow) setPane('list');

    // Exit tail mode on j/k — nav will activate on next render
    if ((input === 'j' || input === 'k' || key.upArrow || key.downArrow) && tail) {
      setTail(false);
    }
  });

  const visibleEvents = tail
    ? events.slice(0, listHeight)
    : events.slice(scrollOffset, scrollOffset + listHeight);

  return (
    <Box flexDirection="row" height={height}>
      {/* Event list */}
      <Box flexDirection="column" width={pane === 'detail' ? '50%' : '100%'} borderStyle="single" borderColor={pane === 'list' ? colors.accent : colors.border}>
        <Box paddingX={1}>
          <Text bold color={colors.accent}>EVENTS</Text>
          <Text color={colors.dim}> ({events.length})</Text>
          <Box flexGrow={1} />
          {!tail && events.length > 0 && (
            <Text color={colors.dim}>{selectedIndex + 1}/{events.length} </Text>
          )}
          <Text color={typeFilter === 'ALL' ? colors.dim : colors[typeFilter as keyof typeof colors] ?? colors.dim}>
            {typeFilter}
          </Text>
          <Text color={colors.dim}> {symbols.dot} </Text>
          <Text color={tail ? colors.online : colors.dim}>{tail ? 'TAIL' : 'SCROLL'}</Text>
          <Text color={colors.dim}> {symbols.dot} </Text>
          <Text color={sse.connected ? colors.online : colors.claimed}>
            {sse.connected ? 'SSE' : 'POLL'}
          </Text>
        </Box>

        {loading && (
          <Box paddingX={1}>
            <Text color={colors.accent}><Spinner type="dots" /></Text>
            <Text color={colors.dim}> Connecting...</Text>
          </Box>
        )}

        {error && !sse.connected && (
          <Box paddingX={1}>
            <Text color={colors.escalated}>{symbols.cross} {error.message}</Text>
          </Box>
        )}

        {visibleEvents.map((evt, i) => {
          const realIndex = tail ? i : scrollOffset + i;
          const isSelected = !tail && realIndex === selectedIndex;
          const typeColor = colors[evt.eventType as keyof typeof colors] ?? colors.dim;
          const ts = new Date(evt.createdAt);
          const time = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

          return (
            <Box key={evt.id} paddingX={1}>
              {!tail && (
                <Text color={isSelected ? colors.accent : colors.dim}>
                  {isSelected ? symbols.selected : ' '}
                </Text>
              )}
              <Text color={colors.dim}>{time} </Text>
              <Text color={typeColor} bold>{evt.eventType.padEnd(11)} </Text>
              <Text color={colors.dim}>{evt.createdBy.padEnd(16)} </Text>
              <Text color={colors.text}>
                {truncate(evt.message, pane === 'detail' ? 40 : 60)}
              </Text>
            </Box>
          );
        })}

        {!loading && events.length === 0 && (
          <Box paddingX={1}>
            <Text color={colors.dim}>No events</Text>
          </Box>
        )}
      </Box>

      {/* Detail pane */}
      {pane === 'detail' && (
        <Box flexDirection="column" width="50%" borderStyle="single" borderColor={colors.accent}>
          <Box paddingX={1}>
            <Text bold color={colors.accent}>DETAIL</Text>
          </Box>

          {selected ? (
            <Box flexDirection="column" paddingX={1}>
              <Box>
                <Text color={colors.dim}>ID:      </Text>
                <Text>#{selected.id}</Text>
              </Box>
              <Box>
                <Text color={colors.dim}>Type:    </Text>
                <Text color={colors[selected.eventType as keyof typeof colors] ?? colors.text} bold>
                  {selected.eventType}
                </Text>
              </Box>
              <Box>
                <Text color={colors.dim}>Agent:   </Text>
                <Text>{selected.createdBy}</Text>
              </Box>
              <Box>
                <Text color={colors.dim}>Time:    </Text>
                <Text>{new Date(selected.createdAt).toLocaleString()}</Text>
              </Box>
              {selected.tags.length > 0 && (
                <Box>
                  <Text color={colors.dim}>Tags:    </Text>
                  <Text>{selected.tags.join(', ')}</Text>
                </Box>
              )}
              <Box marginTop={1}>
                <Text wrap="wrap">{selected.message}</Text>
              </Box>
            </Box>
          ) : (
            <Box paddingX={1}>
              <Text color={colors.dim}>{tail ? 'Exit tail mode (t) to select' : 'Select an event'}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

export function eventsKeyHints(): Array<{ key: string; label: string }> {
  return [
    { key: 'j/k', label: 'scroll' },
    { key: 'h/l', label: 'panes' },
    { key: 'f', label: 'type filter' },
    { key: 't', label: 'tail/scroll' },
    { key: 'r', label: 'refresh' },
  ];
}
