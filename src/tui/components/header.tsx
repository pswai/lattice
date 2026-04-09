import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

export type PanelId = 'tasks' | 'agents' | 'events' | 'contexts' | 'playbooks' | 'stats';

const panels: { id: PanelId; label: string; key: string }[] = [
  { id: 'tasks', label: 'Tasks', key: '1' },
  { id: 'agents', label: 'Agents', key: '2' },
  { id: 'events', label: 'Events', key: '3' },
  { id: 'contexts', label: 'Knowledge', key: '4' },
  { id: 'playbooks', label: 'Playbooks', key: '5' },
  { id: 'stats', label: 'Stats', key: '6' },
];

interface HeaderProps {
  activePanel: PanelId;
  workspace: string;
  agentsOnline: number;
  serverOk: boolean;
}

export function Header({ activePanel, workspace, agentsOnline, serverOk }: HeaderProps) {
  return (
    <Box flexDirection="row" paddingX={1}>
      <Text bold color={colors.accent}>Lattice</Text>
      <Text color={colors.dim}> {'\u2502'} </Text>

      {panels.map((p) => {
        const active = p.id === activePanel;
        return (
          <Box key={p.id} marginRight={1}>
            <Text
              color={active ? colors.accent : colors.dim}
              bold={active}
              underline={active}
            >
              [{p.key}]{p.label}
            </Text>
          </Box>
        );
      })}

      <Box flexGrow={1} />

      <Text color={colors.dim}>{workspace}</Text>
      <Text color={colors.dim}> {'\u00b7'} </Text>
      <Text color={agentsOnline > 0 ? colors.online : colors.dim}>
        {agentsOnline} agent{agentsOnline !== 1 ? 's' : ''}
      </Text>
      <Text color={colors.dim}> {'\u00b7'} </Text>
      <Text color={serverOk ? colors.online : colors.escalated}>
        {serverOk ? '\u25cf' : '\u25cb'}
      </Text>
    </Box>
  );
}

export { panels };
