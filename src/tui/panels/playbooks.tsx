import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { LatticeClient } from '../client.js';
import { usePolling } from '../hooks/use-polling.js';
import { useListNav } from '../hooks/use-list-nav.js';
import { colors, symbols, timeAgo, truncate } from '../theme.js';

type SubView = 'playbooks' | 'runs' | 'schedules';

interface PlaybooksPanelProps {
  client: LatticeClient;
  active: boolean;
  height: number;
}

export function PlaybooksPanel({ client, active, height }: PlaybooksPanelProps) {
  const [subView, setSubView] = useState<SubView>('playbooks');

  const { data: pbData, loading: pbLoading } = usePolling(
    () => client.listPlaybooks(),
    15000,
    { enabled: active && subView === 'playbooks' },
  );

  const { data: runData, loading: runLoading } = usePolling(
    () => client.listWorkflowRuns({ limit: 50 }),
    5000,
    { enabled: active && subView === 'runs' },
  );

  const { data: schedData, loading: schedLoading } = usePolling(
    () => client.listSchedules(),
    15000,
    { enabled: active && subView === 'schedules' },
  );

  const playbooks = pbData?.playbooks ?? [];
  const runs = runData?.runs ?? [];
  const schedules = schedData?.schedules ?? [];

  const listHeight = Math.max(1, height - 4);

  const pbNav = useListNav(playbooks.length, listHeight, { enabled: active && subView === 'playbooks' });
  const runNav = useListNav(runs.length, listHeight, { enabled: active && subView === 'runs' });
  const schedNav = useListNav(schedules.length, listHeight, { enabled: active && subView === 'schedules' });

  useInput((input) => {
    if (!active) return;
    if (input === 'p') setSubView('playbooks');
    if (input === 'w') setSubView('runs');
    if (input === 'd') setSubView('schedules');
  });

  const isLoading = (subView === 'playbooks' && pbLoading && !pbData)
    || (subView === 'runs' && runLoading && !runData)
    || (subView === 'schedules' && schedLoading && !schedData);

  return (
    <Box flexDirection="column" height={height} borderStyle="single" borderColor={colors.border}>
      {/* Sub-tabs */}
      <Box paddingX={1} gap={2}>
        {([
          { id: 'playbooks' as const, key: 'p', label: 'Playbooks' },
          { id: 'runs' as const, key: 'w', label: 'Runs' },
          { id: 'schedules' as const, key: 'd', label: 'Schedules' },
        ]).map(v => (
          <Text
            key={v.id}
            bold={v.id === subView}
            color={v.id === subView ? colors.accent : colors.dim}
            underline={v.id === subView}
          >
            [{v.key}]{v.label}
          </Text>
        ))}
        <Box flexGrow={1} />
        <Text color={colors.dim}>
          {subView === 'playbooks' ? playbooks.length : subView === 'runs' ? runs.length : schedules.length} items
        </Text>
      </Box>

      {isLoading && (
        <Box paddingX={1}>
          <Text color={colors.accent}><Spinner type="dots" /></Text>
          <Text color={colors.dim}> Loading...</Text>
        </Box>
      )}

      {/* Playbooks list */}
      {subView === 'playbooks' && playbooks.slice(pbNav.scrollOffset, pbNav.scrollOffset + listHeight).map((pb, i) => {
        const realIndex = pbNav.scrollOffset + i;
        const isSelected = realIndex === pbNav.selectedIndex;
        return (
          <Box key={pb.id} paddingX={1}>
            <Text color={isSelected ? colors.accent : colors.dim}>{isSelected ? symbols.selected : ' '} </Text>
            <Text color={isSelected ? colors.textBright : colors.text} bold>{truncate(pb.name, 25)}</Text>
            <Text color={colors.dim}> {truncate(pb.description, 35)}</Text>
            <Box flexGrow={1} />
            <Text color={colors.dim}>{pb.taskCount} tasks</Text>
          </Box>
        );
      })}

      {/* Workflow runs */}
      {subView === 'runs' && runs.slice(runNav.scrollOffset, runNav.scrollOffset + listHeight).map((run, i) => {
        const realIndex = runNav.scrollOffset + i;
        const isSelected = realIndex === runNav.selectedIndex;
        const statusColor = run.status === 'completed' ? colors.completed
          : run.status === 'failed' ? colors.failed
          : colors.running;
        return (
          <Box key={run.id} paddingX={1}>
            <Text color={isSelected ? colors.accent : colors.dim}>{isSelected ? symbols.selected : ' '} </Text>
            <Text color={statusColor} bold>{run.status.padEnd(10)}</Text>
            <Text color={colors.text}>{truncate(run.playbook_name, 25)}</Text>
            <Box flexGrow={1} />
            <Text color={colors.dim}>{run.task_ids.length} tasks</Text>
            <Text color={colors.dim}> {timeAgo(run.started_at)}</Text>
          </Box>
        );
      })}

      {/* Schedules */}
      {subView === 'schedules' && schedules.slice(schedNav.scrollOffset, schedNav.scrollOffset + listHeight).map((sched, i) => {
        const realIndex = schedNav.scrollOffset + i;
        const isSelected = realIndex === schedNav.selectedIndex;
        return (
          <Box key={sched.id} paddingX={1}>
            <Text color={isSelected ? colors.accent : colors.dim}>{isSelected ? symbols.selected : ' '} </Text>
            <Text color={sched.enabled ? colors.online : colors.dim}>
              {sched.enabled ? symbols.online : symbols.offline}
            </Text>
            <Text color={colors.text}> {truncate(sched.playbook_name, 25)}</Text>
            <Text color={colors.dim}> {sched.cron_expression}</Text>
            <Box flexGrow={1} />
            <Text color={colors.dim}>next: {timeAgo(sched.next_run_at)}</Text>
          </Box>
        );
      })}

      {/* Empty states */}
      {!isLoading && subView === 'playbooks' && playbooks.length === 0 && (
        <Box paddingX={1}><Text color={colors.dim}>No playbooks defined</Text></Box>
      )}
      {!isLoading && subView === 'runs' && runs.length === 0 && (
        <Box paddingX={1}><Text color={colors.dim}>No workflow runs</Text></Box>
      )}
      {!isLoading && subView === 'schedules' && schedules.length === 0 && (
        <Box paddingX={1}><Text color={colors.dim}>No schedules</Text></Box>
      )}
    </Box>
  );
}

export function playbooksKeyHints(): Array<{ key: string; label: string }> {
  return [
    { key: 'j/k', label: 'navigate' },
    { key: 'p', label: 'playbooks' },
    { key: 'w', label: 'runs' },
    { key: 'd', label: 'schedules' },
  ];
}
