import React, { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { Task } from '../../models/types.js';
import type { LatticeClient } from '../client.js';
import { usePolling } from '../hooks/use-polling.js';
import { useListNav } from '../hooks/use-list-nav.js';
import { colors, symbols, timeAgo, truncate } from '../theme.js';

const STATUS_FILTERS = ['all', 'open', 'claimed', 'completed', 'escalated'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

interface TasksPanelProps {
  client: LatticeClient;
  active: boolean;
  height: number;
}

export function TasksPanel({ client, active, height }: TasksPanelProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [filterText, setFilterText] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const { data, error, loading, refresh } = usePolling(
    () => client.listTasks(statusFilter === 'all' ? { limit: 200 } : { status: statusFilter, limit: 200 }),
    5000,
    { enabled: active },
  );

  const tasks = useMemo(() => {
    const all = data?.tasks ?? [];
    if (!filterText) return all;
    const lower = filterText.toLowerCase();
    return all.filter(t =>
      t.description.toLowerCase().includes(lower) ||
      t.claimedBy?.toLowerCase().includes(lower) ||
      t.assignedTo?.toLowerCase().includes(lower)
    );
  }, [data, filterText]);

  const listHeight = Math.max(1, height - 4);
  // Disable list nav when filter is active to prevent keybinding conflicts
  const { selectedIndex, scrollOffset } = useListNav(tasks.length, listHeight, {
    enabled: active && pane === 'list' && !showFilter,
  });

  const selected = tasks[selectedIndex] ?? null;

  // Flash action message then clear after 2s
  const flashMsg = useCallback((msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 2000);
  }, []);

  // Task actions
  const claimTask = useCallback(async () => {
    if (!selected || selected.status !== 'open') return;
    try {
      await client.updateTask(selected.id, 'claimed', selected.version);
      flashMsg(`Claimed #${selected.id}`);
      refresh();
    } catch (err) {
      flashMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selected, client, flashMsg, refresh]);

  const completeTask = useCallback(async () => {
    if (!selected || selected.status !== 'claimed') return;
    try {
      await client.updateTask(selected.id, 'completed', selected.version, { result: 'Completed via TUI' });
      flashMsg(`Completed #${selected.id}`);
      refresh();
    } catch (err) {
      flashMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selected, client, flashMsg, refresh]);

  const escalateTask = useCallback(async () => {
    if (!selected || selected.status !== 'claimed') return;
    try {
      await client.updateTask(selected.id, 'escalated', selected.version, { result: 'Escalated via TUI' });
      flashMsg(`Escalated #${selected.id}`);
      refresh();
    } catch (err) {
      flashMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selected, client, flashMsg, refresh]);

  useInput((input, key) => {
    if (!active) return;

    // Filter mode
    if (input === '/' && !showFilter) {
      setShowFilter(true);
      setFilterText('');
      return;
    }
    if (showFilter) {
      if (key.escape) { setShowFilter(false); setFilterText(''); return; }
      if (key.return) { setShowFilter(false); return; }
      if (key.backspace) { setFilterText(prev => prev.slice(0, -1)); return; }
      if (input && !key.escape) { setFilterText(prev => prev + input); return; }
      return;
    }

    // Pane switching
    if (input === 'l' || key.rightArrow) setPane('detail');
    if (input === 'h' || key.leftArrow) setPane('list');
    if (input === 'r') refresh();

    // Status filter cycle
    if (input === 's') {
      const idx = STATUS_FILTERS.indexOf(statusFilter);
      setStatusFilter(STATUS_FILTERS[(idx + 1) % STATUS_FILTERS.length]);
    }

    // Task actions
    if (input === 'c') claimTask();
    if (input === 'x') completeTask();
    if (input === 'e') escalateTask();
  });

  const visibleTasks = tasks.slice(scrollOffset, scrollOffset + listHeight);

  return (
    <Box flexDirection="row" height={height}>
      {/* Left: Task List */}
      <Box flexDirection="column" width="50%" borderStyle="single" borderColor={pane === 'list' ? colors.accent : colors.border}>
        <Box paddingX={1}>
          <Text bold color={colors.accent}>TASKS</Text>
          <Text color={colors.dim}> ({tasks.length})</Text>
          <Box flexGrow={1} />
          {tasks.length > 0 && (
            <Text color={colors.dim}>{selectedIndex + 1}/{tasks.length} </Text>
          )}
          <Text color={colors[statusFilter === 'all' ? 'dim' : statusFilter as keyof typeof colors] ?? colors.dim}>
            {statusFilter}
          </Text>
        </Box>

        {showFilter && (
          <Box paddingX={1}>
            <Text color={colors.accent}>/</Text>
            <Text>{filterText}</Text>
            <Text color={colors.accent}>|</Text>
          </Box>
        )}

        {actionMsg && (
          <Box paddingX={1}>
            <Text color={actionMsg.startsWith('Error') ? colors.escalated : colors.completed}>{actionMsg}</Text>
          </Box>
        )}

        {loading && !data && (
          <Box paddingX={1}>
            <Text color={colors.accent}><Spinner type="dots" /></Text>
            <Text color={colors.dim}> Loading tasks...</Text>
          </Box>
        )}

        {error && (
          <Box paddingX={1}>
            <Text color={colors.escalated}>{symbols.cross} {error.message}</Text>
          </Box>
        )}

        {visibleTasks.map((task, i) => {
          const realIndex = scrollOffset + i;
          const isSelected = realIndex === selectedIndex;
          const priorityColor = colors[task.priority.toLowerCase() as keyof typeof colors] ?? colors.dim;

          return (
            <Box key={task.id} paddingX={1}>
              <Text color={isSelected ? colors.accent : colors.dim}>
                {isSelected ? symbols.selected : ' '}
              </Text>
              <Text color={priorityColor} bold> {task.priority} </Text>
              <Text color={colors[task.status as keyof typeof colors] ?? colors.text}>
                {truncate(task.description, 40)}
              </Text>
            </Box>
          );
        })}

        {!loading && tasks.length === 0 && (
          <Box paddingX={1}>
            <Text color={colors.dim}>No tasks found</Text>
          </Box>
        )}
      </Box>

      {/* Right: Detail */}
      <Box flexDirection="column" width="50%" borderStyle="single" borderColor={pane === 'detail' ? colors.accent : colors.border}>
        <Box paddingX={1}>
          <Text bold color={colors.accent}>DETAIL</Text>
          {selected && (
            <Box flexGrow={1} justifyContent="flex-end">
              <Text color={colors.dim}>v{selected.version}</Text>
            </Box>
          )}
        </Box>

        {selected ? (
          <Box flexDirection="column" paddingX={1} gap={0}>
            <Box>
              <Text color={colors.dim}>ID:        </Text>
              <Text bold>#{selected.id}</Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Status:    </Text>
              <Text color={colors[selected.status as keyof typeof colors] ?? colors.text} bold>
                {selected.status}
              </Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Priority:  </Text>
              <Text color={colors[selected.priority.toLowerCase() as keyof typeof colors] ?? colors.text} bold>
                {selected.priority}
              </Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Created:   </Text>
              <Text>{timeAgo(selected.createdAt)}</Text>
              <Text color={colors.dim}> by {selected.createdBy}</Text>
            </Box>
            {selected.claimedBy && (
              <Box>
                <Text color={colors.dim}>Claimed:   </Text>
                <Text>{selected.claimedBy}</Text>
                {selected.claimedAt && <Text color={colors.dim}> ({timeAgo(selected.claimedAt)})</Text>}
              </Box>
            )}
            {selected.assignedTo && (
              <Box>
                <Text color={colors.dim}>Assigned:  </Text>
                <Text>{selected.assignedTo}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text wrap="wrap">{selected.description}</Text>
            </Box>
            {selected.result && (
              <Box marginTop={1} flexDirection="column">
                <Text color={colors.dim}>Result:</Text>
                <Text wrap="wrap">{selected.result}</Text>
              </Box>
            )}

            {/* Available actions */}
            <Box marginTop={1}>
              {selected.status === 'open' && (
                <Text color={colors.accent}>c:claim</Text>
              )}
              {selected.status === 'claimed' && (
                <>
                  <Text color={colors.completed}>x:complete</Text>
                  <Text color={colors.dim}> </Text>
                  <Text color={colors.escalated}>e:escalate</Text>
                </>
              )}
            </Box>
          </Box>
        ) : (
          <Box paddingX={1}>
            <Text color={colors.dim}>Select a task</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function tasksKeyHints(): Array<{ key: string; label: string }> {
  return [
    { key: 'j/k', label: 'navigate' },
    { key: 'h/l', label: 'panes' },
    { key: 's', label: 'status' },
    { key: '/', label: 'filter' },
    { key: 'c', label: 'claim' },
    { key: 'x', label: 'complete' },
    { key: 'r', label: 'refresh' },
  ];
}
