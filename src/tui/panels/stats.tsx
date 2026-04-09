import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { LatticeClient, AnalyticsData } from '../client.js';
import { usePolling } from '../hooks/use-polling.js';
import { colors, symbols } from '../theme.js';

type TimeWindow = '24h' | '7d' | '30d';

interface StatsPanelProps {
  client: LatticeClient;
  active: boolean;
  height: number;
}

function Bar({ value, max, width, color }: { value: number; max: number; width: number; color: string }) {
  if (max === 0) return <Text color={colors.dim}>{'  ' + symbols.dash.repeat(width)}</Text>;
  const filled = Math.round((value / max) * width);
  return (
    <Text>
      <Text color={color}>{symbols.block.repeat(filled)}</Text>
      <Text color={colors.dim}>{symbols.blockLight.repeat(width - filled)}</Text>
    </Text>
  );
}

function StatRow({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <Box paddingX={1}>
      <Text color={colors.dim}>{label.padEnd(22)}</Text>
      <Text color={color ?? colors.text} bold>{String(value ?? 0)}</Text>
    </Box>
  );
}

export function StatsPanel({ client, active, height }: StatsPanelProps) {
  const [window, setWindow] = useState<TimeWindow>('24h');

  const { data } = usePolling(
    () => client.getAnalytics(window),
    30000,
    { enabled: active },
  );

  useInput((input) => {
    if (!active) return;
    if (input === '1') setWindow('24h');
    if (input === '2') setWindow('7d');
    if (input === '3') setWindow('30d');
  });

  const a = data;

  return (
    <Box flexDirection="column" height={height} borderStyle="single" borderColor={colors.border}>
      {/* Window tabs */}
      <Box paddingX={1} gap={2}>
        <Text bold color={colors.accent}>ANALYTICS</Text>
        <Box flexGrow={1} />
        {(['24h', '7d', '30d'] as const).map((w, i) => (
          <Text
            key={w}
            bold={w === window}
            color={w === window ? colors.accent : colors.dim}
            underline={w === window}
          >
            [{i + 1}]{w}
          </Text>
        ))}
      </Box>

      {a ? (
        <Box flexDirection="column">
          {/* Tasks */}
          <Box paddingX={1} marginTop={1}>
            <Text bold color={colors.accent}>Tasks</Text>
            <Text color={colors.dim}> (total: {a.tasks.total})</Text>
          </Box>
          {Object.entries(a.tasks.by_status).map(([status, count]) => {
            const statusColor = colors[status as keyof typeof colors] ?? colors.text;
            return <StatRow key={status} label={`  ${status}`} value={count} color={statusColor} />;
          })}
          {a.tasks.completion_rate > 0 && (
            <StatRow label="  Completion rate" value={`${(a.tasks.completion_rate * 100).toFixed(0)}%`} />
          )}
          {a.tasks.avg_completion_ms != null && (
            <StatRow label="  Avg completion" value={`${(Number(a.tasks.avg_completion_ms) / 60000).toFixed(1)}m`} />
          )}

          {/* Task bar chart */}
          {a.tasks.total > 0 && (
            <>
              <Box paddingX={1} marginTop={1}>
                <Text color={colors.dim}>  completed </Text>
                <Bar
                  value={a.tasks.by_status.completed ?? 0}
                  max={a.tasks.total}
                  width={30}
                  color={colors.completed}
                />
              </Box>
              <Box paddingX={1}>
                <Text color={colors.dim}>  escalated </Text>
                <Bar
                  value={a.tasks.by_status.escalated ?? 0}
                  max={a.tasks.total}
                  width={30}
                  color={colors.escalated}
                />
              </Box>
            </>
          )}

          {/* Events */}
          <Box paddingX={1} marginTop={1}>
            <Text bold color={colors.accent}>Events</Text>
          </Box>
          <StatRow label="Total" value={a.events.total} />
          {Object.entries(a.events.by_type).map(([type, count]) => (
            <Box key={type} paddingX={1}>
              <Text color={colors.dim}>{'  ' + type.padEnd(20)}</Text>
              <Text color={colors[type as keyof typeof colors] ?? colors.text}>{count}</Text>
            </Box>
          ))}

          {/* Agents */}
          <Box paddingX={1} marginTop={1}>
            <Text bold color={colors.accent}>Agents</Text>
          </Box>
          <StatRow label="Registered" value={a.agents.total} />
          <StatRow label="Online now" value={a.agents.online} color={colors.online} />

          {/* Knowledge */}
          <Box paddingX={1} marginTop={1}>
            <Text bold color={colors.accent}>Knowledge Base</Text>
          </Box>
          <StatRow label="Total entries" value={a.context.total_entries} />
          <StatRow label="Added in window" value={a.context.entries_since} />
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color={colors.accent}><Spinner type="dots" /></Text>
          <Text color={colors.dim}> Loading analytics...</Text>
        </Box>
      )}
    </Box>
  );
}

export function statsKeyHints(): Array<{ key: string; label: string }> {
  return [
    { key: '1', label: '24h' },
    { key: '2', label: '7d' },
    { key: '3', label: '30d' },
  ];
}
