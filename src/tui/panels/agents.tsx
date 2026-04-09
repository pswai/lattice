import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { LatticeClient } from '../client.js';
import { usePolling } from '../hooks/use-polling.js';
import { useListNav } from '../hooks/use-list-nav.js';
import { colors, symbols, statusSymbol, timeAgo, truncate } from '../theme.js';

interface AgentsPanelProps {
  client: LatticeClient;
  active: boolean;
  height: number;
}

export function AgentsPanel({ client, active, height }: AgentsPanelProps) {
  const [pane, setPane] = useState<'list' | 'detail'>('list');

  const { data, error, loading, refresh } = usePolling(
    () => client.listAgents(),
    10000,
    { enabled: active },
  );

  const agents = data?.agents ?? [];
  const listHeight = Math.max(1, height - 3);
  const { selectedIndex, scrollOffset } = useListNav(agents.length, listHeight, { enabled: active && pane === 'list' });

  const selected = agents[selectedIndex] ?? null;

  useInput((input, key) => {
    if (!active) return;
    if (input === 'l' || key.rightArrow) setPane('detail');
    if (input === 'h' || key.leftArrow) setPane('list');
    if (input === 'r') refresh();
  });

  const visibleAgents = agents.slice(scrollOffset, scrollOffset + listHeight);

  return (
    <Box flexDirection="row" height={height}>
      {/* List */}
      <Box flexDirection="column" width="50%" borderStyle="single" borderColor={pane === 'list' ? colors.accent : colors.border}>
        <Box paddingX={1}>
          <Text bold color={colors.accent}>AGENTS</Text>
          <Text color={colors.dim}> ({agents.length})</Text>
          <Box flexGrow={1} />
          {agents.length > 0 && (
            <Text color={colors.dim}>{selectedIndex + 1}/{agents.length}</Text>
          )}
        </Box>

        {loading && !data && (
          <Box paddingX={1}>
            <Text color={colors.accent}><Spinner type="dots" /></Text>
            <Text color={colors.dim}> Loading agents...</Text>
          </Box>
        )}

        {error && (
          <Box paddingX={1}>
            <Text color={colors.escalated}>{symbols.cross} {error.message}</Text>
          </Box>
        )}

        {visibleAgents.map((agent, i) => {
          const realIndex = scrollOffset + i;
          const isSelected = realIndex === selectedIndex;
          const statusColor = colors[agent.status as keyof typeof colors] ?? colors.dim;

          return (
            <Box key={agent.id} paddingX={1}>
              <Text color={isSelected ? colors.accent : colors.dim}>
                {isSelected ? symbols.selected : ' '}
              </Text>
              <Text color={statusColor}> {statusSymbol(agent.status)} </Text>
              <Text color={isSelected ? colors.textBright : colors.text}>
                {truncate(agent.id, 30)}
              </Text>
              <Box flexGrow={1} />
              <Text color={colors.dim}>{timeAgo(agent.lastHeartbeat)}</Text>
            </Box>
          );
        })}

        {!loading && agents.length === 0 && (
          <Box paddingX={1}>
            <Text color={colors.dim}>No agents registered</Text>
          </Box>
        )}
      </Box>

      {/* Detail */}
      <Box flexDirection="column" width="50%" borderStyle="single" borderColor={pane === 'detail' ? colors.accent : colors.border}>
        <Box paddingX={1}>
          <Text bold color={colors.accent}>DETAIL</Text>
        </Box>

        {selected ? (
          <Box flexDirection="column" paddingX={1}>
            <Box>
              <Text color={colors.dim}>Agent:       </Text>
              <Text bold>{selected.id}</Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Status:      </Text>
              <Text color={colors[selected.status as keyof typeof colors] ?? colors.dim} bold>
                {statusSymbol(selected.status)} {selected.status}
              </Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Heartbeat:   </Text>
              <Text>{timeAgo(selected.lastHeartbeat)}</Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Registered:  </Text>
              <Text>{timeAgo(selected.registeredAt)}</Text>
            </Box>
            {selected.capabilities.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text color={colors.dim}>Capabilities:</Text>
                {selected.capabilities.map((cap) => (
                  <Box key={cap} paddingLeft={2}>
                    <Text color={colors.text}>{'\u2022'} {cap}</Text>
                  </Box>
                ))}
              </Box>
            )}
            {Object.keys(selected.metadata).length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text color={colors.dim}>Metadata:</Text>
                {Object.entries(selected.metadata).map(([k, v]) => (
                  <Box key={k} paddingLeft={2}>
                    <Text color={colors.dim}>{k}: </Text>
                    <Text>{String(v)}</Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        ) : (
          <Box paddingX={1}>
            <Text color={colors.dim}>Select an agent</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function agentsKeyHints(): Array<{ key: string; label: string }> {
  return [
    { key: 'j/k', label: 'navigate' },
    { key: 'h/l', label: 'panes' },
    { key: 'r', label: 'refresh' },
  ];
}
