import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { PanelId } from './components/header.js';
import { Header } from './components/header.js';
import { Footer } from './components/footer.js';
import type { LatticeClient } from './client.js';
import { usePolling } from './hooks/use-polling.js';
import { colors } from './theme.js';

import { TasksPanel, tasksKeyHints } from './panels/tasks.js';
import { AgentsPanel, agentsKeyHints } from './panels/agents.js';
import { EventsPanel, eventsKeyHints } from './panels/events.js';
import { ContextsPanel, contextsKeyHints } from './panels/contexts.js';
import { PlaybooksPanel, playbooksKeyHints } from './panels/playbooks.js';
import { StatsPanel, statsKeyHints } from './panels/stats.js';

interface AppProps {
  client: LatticeClient;
  workspace: string;
}

const PANEL_KEYS: Record<string, PanelId> = {
  '1': 'tasks',
  '2': 'agents',
  '3': 'events',
  '4': 'contexts',
  '5': 'playbooks',
  '6': 'stats',
};

function getKeyHints(panel: PanelId): Array<{ key: string; label: string }> {
  switch (panel) {
    case 'tasks': return tasksKeyHints();
    case 'agents': return agentsKeyHints();
    case 'events': return eventsKeyHints();
    case 'contexts': return contextsKeyHints();
    case 'playbooks': return playbooksKeyHints();
    case 'stats': return statsKeyHints();
  }
}

export function App({ client, workspace }: AppProps) {
  const { exit } = useApp();
  const [activePanel, setActivePanel] = useState<PanelId>('tasks');
  const [agentsOnline, setAgentsOnline] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const panelHeight = Math.max(8, termHeight - 5);

  // Poll server health independently
  const { data: serverOk } = usePolling(
    () => client.health(),
    30000,
  );

  // Poll agent count independently (not just when Agents panel is active)
  usePolling(
    async () => {
      const result = await client.listAgents();
      setAgentsOnline(result.agents.filter(a => a.status === 'online').length);
      return result;
    },
    15000,
  );

  // Global keybindings — avoid conflicts with panel-specific keys
  useInput((input, key) => {
    if (input === '?' && !showHelp) { setShowHelp(true); return; }
    if (showHelp && (key.escape || input === '?' || input === 'q')) { setShowHelp(false); return; }
    if (showHelp) return;

    // Panel switching: 1-6, but SKIP 1/2/3 when Stats panel is active (it uses those for time windows)
    if (input in PANEL_KEYS) {
      if (activePanel === 'stats' && (input === '1' || input === '2' || input === '3')) {
        return; // Let stats panel handle these
      }
      setActivePanel(PANEL_KEYS[input]);
      return;
    }

    if (input === 'q') {
      exit();
    }
  });

  // Panel-specific key hints + global ones
  const panelHints = getKeyHints(activePanel);
  const globalHints = activePanel === 'stats'
    ? [{ key: '4-6', label: 'panels' }, { key: '?', label: 'help' }, { key: 'q', label: 'quit' }]
    : [{ key: '1-6', label: 'panels' }, { key: '?', label: 'help' }, { key: 'q', label: 'quit' }];
  const allHints = [...panelHints, ...globalHints];

  const footerBindings = allHints;

  if (showHelp) {
    return (
      <Box flexDirection="column" height={termHeight}>
        <Header activePanel={activePanel} workspace={workspace} agentsOnline={agentsOnline} serverOk={serverOk ?? true} />
        <Box flexDirection="column" borderStyle="single" borderColor={colors.accent} paddingX={2} paddingY={1}>
          <Text bold color={colors.accent}>Keyboard Shortcuts</Text>
          <Text> </Text>
          <Text bold color={colors.text}>Navigation</Text>
          <Text color={colors.dim}>  1-6          Switch panels (Tasks, Agents, Events, Knowledge, Playbooks, Stats)</Text>
          <Text color={colors.dim}>  j/k or {'\u2191\u2193'}    Move up/down in lists</Text>
          <Text color={colors.dim}>  h/l or {'\u2190\u2192'}    Switch between list and detail panes</Text>
          <Text color={colors.dim}>  g/G          Jump to top/bottom of list</Text>
          <Text color={colors.dim}>  Enter        Select / confirm</Text>
          <Text color={colors.dim}>  Esc          Back / cancel</Text>
          <Text> </Text>
          <Text bold color={colors.text}>Actions</Text>
          <Text color={colors.dim}>  /            Filter / search</Text>
          <Text color={colors.dim}>  r            Refresh current panel</Text>
          <Text color={colors.dim}>  ?            Toggle this help</Text>
          <Text color={colors.dim}>  q            Quit</Text>
          <Text> </Text>
          <Text bold color={colors.text}>Tasks Panel</Text>
          <Text color={colors.dim}>  s            Cycle status filter</Text>
          <Text color={colors.dim}>  c            Claim selected task</Text>
          <Text color={colors.dim}>  x            Complete selected task</Text>
          <Text color={colors.dim}>  e            Escalate selected task</Text>
          <Text> </Text>
          <Text bold color={colors.text}>Events Panel</Text>
          <Text color={colors.dim}>  f            Cycle event type filter</Text>
          <Text color={colors.dim}>  t            Toggle tail/scroll mode</Text>
          <Text> </Text>
          <Text bold color={colors.text}>Playbooks Panel</Text>
          <Text color={colors.dim}>  p            Show playbooks</Text>
          <Text color={colors.dim}>  w            Show workflow runs</Text>
          <Text color={colors.dim}>  d            Show schedules</Text>
          <Text> </Text>
          <Text bold color={colors.text}>Stats Panel</Text>
          <Text color={colors.dim}>  1/2/3        Switch time window (24h / 7d / 30d)</Text>
          <Text> </Text>
          <Text color={colors.dim} italic>Press ? or Esc to close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header
        activePanel={activePanel}
        workspace={workspace}
        agentsOnline={agentsOnline}
        serverOk={serverOk ?? true}
      />

      {activePanel === 'tasks' && (
        <TasksPanel client={client} active height={panelHeight} />
      )}
      {activePanel === 'agents' && (
        <AgentsPanel client={client} active height={panelHeight} />
      )}
      {activePanel === 'events' && (
        <EventsPanel client={client} active height={panelHeight} />
      )}
      {activePanel === 'contexts' && (
        <ContextsPanel client={client} active height={panelHeight} />
      )}
      {activePanel === 'playbooks' && (
        <PlaybooksPanel client={client} active height={panelHeight} />
      )}
      {activePanel === 'stats' && (
        <StatsPanel client={client} active height={panelHeight} />
      )}

      <Footer bindings={footerBindings} />
    </Box>
  );
}
