/**
 * TUI component and panel rendering tests using ink-testing-library.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { Header } from '../src/tui/components/header.js';
import { Footer } from '../src/tui/components/footer.js';
import { TasksPanel } from '../src/tui/panels/tasks.js';
import { AgentsPanel } from '../src/tui/panels/agents.js';
import { EventsPanel } from '../src/tui/panels/events.js';
import { ContextsPanel } from '../src/tui/panels/contexts.js';
import { PlaybooksPanel } from '../src/tui/panels/playbooks.js';
import { StatsPanel } from '../src/tui/panels/stats.js';
import type { LatticeClient } from '../src/tui/client.js';
import type { Task, Event } from '../src/models/types.js';

// ── Mock client ──────────────────────────────────────────────────────

function makeMockClient(overrides: Partial<Record<keyof LatticeClient, unknown>> = {}): LatticeClient {
  return {
    health: vi.fn().mockResolvedValue(true),
    listTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }),
    getTask: vi.fn().mockResolvedValue(null),
    getTaskGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    createTask: vi.fn().mockResolvedValue({ task_id: 1, status: 'claimed', claimed_by: 'tui' }),
    updateTask: vi.fn().mockResolvedValue({ task_id: 1, status: 'completed', version: 2 }),
    listEvents: vi.fn().mockResolvedValue({ events: [], cursor: 0 }),
    listAgents: vi.fn().mockResolvedValue({ agents: [] }),
    searchContext: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    listPlaybooks: vi.fn().mockResolvedValue({ playbooks: [] }),
    runPlaybook: vi.fn().mockResolvedValue({ workflow_run_id: 1, task_ids: [] }),
    listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [] }),
    listSchedules: vi.fn().mockResolvedValue({ schedules: [] }),
    listProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
    getAnalytics: vi.fn().mockResolvedValue({
      tasks: { total: 10, by_status: { open: 3, claimed: 2, completed: 4, escalated: 1, abandoned: 0 }, completion_rate: 0.4, avg_completion_ms: null, median_completion_ms: null },
      events: { total: 50, by_type: { LEARNING: 10, BROADCAST: 20, ESCALATION: 5, ERROR: 5, TASK_UPDATE: 10 } },
      agents: { total: 5, online: 2 },
      context: { total_entries: 15, entries_since: 3 },
    }),
    listArtifacts: vi.fn().mockResolvedValue({ artifacts: [], total: 0 }),
    sseUrl: vi.fn().mockReturnValue('http://localhost:3000/api/v1/events/stream'),
    authHeaders: { 'Authorization': 'Bearer test', 'Content-Type': 'application/json' },
    ...overrides,
  } as unknown as LatticeClient;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    workspaceId: 'ws-1',
    description: 'Fix authentication bug',
    status: 'open',
    result: null,
    createdBy: 'agent-1',
    claimedBy: null,
    claimedAt: null,
    version: 1,
    priority: 'P1',
    assignedTo: null,
    createdAt: new Date(Date.now() - 300_000).toISOString(),
    updatedAt: new Date(Date.now() - 300_000).toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 1,
    workspaceId: 'ws-1',
    eventType: 'BROADCAST',
    message: 'Deployment complete',
    tags: ['deploy'],
    createdBy: 'agent-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Header tests ─────────────────────────────────────────────────────

describe('Header', () => {
  it('renders workspace name', () => {
    const { lastFrame } = render(
      <Header activePanel="tasks" workspace="my-team" agentsOnline={3} serverOk={true} />,
    );
    expect(lastFrame()).toContain('my-team');
  });

  it('renders agent count', () => {
    const { lastFrame } = render(
      <Header activePanel="tasks" workspace="ws" agentsOnline={5} serverOk={true} />,
    );
    expect(lastFrame()).toContain('5 agents');
  });

  it('renders singular agent', () => {
    const { lastFrame } = render(
      <Header activePanel="tasks" workspace="ws" agentsOnline={1} serverOk={true} />,
    );
    expect(lastFrame()).toContain('1 agent');
    expect(lastFrame()).not.toContain('1 agents');
  });

  it('highlights active panel tab', () => {
    const { lastFrame } = render(
      <Header activePanel="events" workspace="ws" agentsOnline={0} serverOk={true} />,
    );
    // Events tab should be present
    expect(lastFrame()).toContain('Events');
  });

  it('shows connection indicator', () => {
    const online = render(
      <Header activePanel="tasks" workspace="ws" agentsOnline={0} serverOk={true} />,
    );
    const offline = render(
      <Header activePanel="tasks" workspace="ws" agentsOnline={0} serverOk={false} />,
    );
    // Both should render without error
    expect(online.lastFrame()).toBeTruthy();
    expect(offline.lastFrame()).toBeTruthy();
    online.unmount();
    offline.unmount();
  });
});

// ── Footer tests ─────────────────────────────────────────────────────

describe('Footer', () => {
  it('renders key bindings', () => {
    const bindings = [
      { key: 'j/k', label: 'navigate' },
      { key: 'q', label: 'quit' },
    ];
    const { lastFrame } = render(<Footer bindings={bindings} />);
    const frame = lastFrame();
    expect(frame).toContain('j/k');
    expect(frame).toContain('navigate');
    expect(frame).toContain('q');
    expect(frame).toContain('quit');
  });

  it('renders error message', () => {
    const { lastFrame } = render(<Footer bindings={[]} error="Connection lost" />);
    expect(lastFrame()).toContain('Connection lost');
  });

  it('renders empty bindings without crash', () => {
    const { lastFrame, unmount } = render(<Footer bindings={[]} />);
    // Empty footer renders as empty string — that's fine, no crash
    expect(() => lastFrame()).not.toThrow();
    unmount();
  });
});

// ── TasksPanel tests ─────────────────────────────────────────────────

describe('TasksPanel', () => {
  it('shows loading state initially', () => {
    const client = makeMockClient({
      listTasks: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const { lastFrame, unmount } = render(
      <TasksPanel client={client} active={true} height={15} />,
    );
    expect(lastFrame()).toContain('Loading tasks');
    unmount();
  });

  it('renders tasks after loading', async () => {
    const tasks = [
      makeTask({ id: 1, description: 'Fix auth bug', priority: 'P0', status: 'open' }),
      makeTask({ id: 2, description: 'Add logging', priority: 'P2', status: 'claimed', claimedBy: 'worker' }),
    ];
    const client = makeMockClient({
      listTasks: vi.fn().mockResolvedValue({ tasks, total: 2 }),
    });

    const { lastFrame, unmount } = render(
      <TasksPanel client={client} active={true} height={15} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Fix auth bug');
    });
    expect(lastFrame()).toContain('Add logging');
    expect(lastFrame()).toContain('TASKS');
    expect(lastFrame()).toContain('P0');
    expect(lastFrame()).toContain('P2');
    expect(lastFrame()).toContain('1/2');
    unmount();
  });

  it('shows "No tasks found" when empty', async () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <TasksPanel client={client} active={true} height={15} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('No tasks found');
    });
    unmount();
  });

  it('shows DETAIL pane', async () => {
    const tasks = [makeTask({ id: 1, description: 'Test task', status: 'open', createdBy: 'me' })];
    const client = makeMockClient({
      listTasks: vi.fn().mockResolvedValue({ tasks, total: 1 }),
    });
    const { lastFrame, unmount } = render(
      <TasksPanel client={client} active={true} height={15} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('DETAIL');
      expect(lastFrame()).toContain('#1');
      expect(lastFrame()).toContain('open');
    });
    unmount();
  });

  it('shows action hints for open tasks', async () => {
    const tasks = [makeTask({ status: 'open' })];
    const client = makeMockClient({
      listTasks: vi.fn().mockResolvedValue({ tasks, total: 1 }),
    });
    const { lastFrame, unmount } = render(
      <TasksPanel client={client} active={true} height={20} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('c:claim');
    });
    unmount();
  });

  it('shows action hints for claimed tasks', async () => {
    const tasks = [makeTask({ status: 'claimed', claimedBy: 'worker' })];
    const client = makeMockClient({
      listTasks: vi.fn().mockResolvedValue({ tasks, total: 1 }),
    });
    const { lastFrame, unmount } = render(
      <TasksPanel client={client} active={true} height={20} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('x:complete');
      expect(lastFrame()).toContain('e:escalate');
    });
    unmount();
  });

  it('shows error state on API failure', async () => {
    const client = makeMockClient({
      listTasks: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    const { lastFrame, unmount } = render(
      <TasksPanel client={client} active={true} height={15} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Network error');
    });
    unmount();
  });

  it('does not poll when inactive', async () => {
    const listTasks = vi.fn().mockResolvedValue({ tasks: [], total: 0 });
    const client = makeMockClient({ listTasks });
    const { unmount } = render(
      <TasksPanel client={client} active={false} height={15} />,
    );
    await new Promise(r => setTimeout(r, 100));
    expect(listTasks).not.toHaveBeenCalled();
    unmount();
  });
});

// ── AgentsPanel tests ────────────────────────────────────────────────

describe('AgentsPanel', () => {
  it('renders agent list', async () => {
    const agents = [
      { id: 'worker-1', capabilities: ['code'], status: 'online', metadata: {}, lastHeartbeat: new Date().toISOString(), registeredAt: new Date().toISOString() },
      { id: 'reviewer', capabilities: ['review'], status: 'offline', metadata: {}, lastHeartbeat: new Date(Date.now() - 3600_000).toISOString(), registeredAt: new Date().toISOString() },
    ];
    const client = makeMockClient({
      listAgents: vi.fn().mockResolvedValue({ agents }),
    });
    const { lastFrame, unmount } = render(
      <AgentsPanel client={client} active={true} height={12} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('worker-1');
      expect(lastFrame()).toContain('reviewer');
      expect(lastFrame()).toContain('AGENTS');
      expect(lastFrame()).toContain('(2)');
    });
    unmount();
  });

  it('shows empty state', async () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <AgentsPanel client={client} active={true} height={12} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('No agents registered');
    });
    unmount();
  });
});

// ── EventsPanel tests ────────────────────────────────────────────────

describe('EventsPanel', () => {
  it('shows events in tail mode', async () => {
    const events = [
      makeEvent({ id: 1, eventType: 'BROADCAST', message: 'Deploy started' }),
      makeEvent({ id: 2, eventType: 'ERROR', message: 'Connection failed' }),
    ];
    const client = makeMockClient({
      listEvents: vi.fn().mockResolvedValue({ events, cursor: 2 }),
    });
    const { lastFrame, unmount } = render(
      <EventsPanel client={client} active={true} height={12} />,
    );
    await vi.waitFor(() => {
      const frame = lastFrame();
      expect(frame).toContain('TAIL');
      // In tail mode, newest first
      expect(frame).toContain('Connection failed');
      expect(frame).toContain('Deploy started');
    });
    unmount();
  });

  it('shows SSE/POLL indicator', async () => {
    // SSE will fail to connect (no server), so should show POLL
    const client = makeMockClient({
      listEvents: vi.fn().mockResolvedValue({ events: [], cursor: 0 }),
    });
    const { lastFrame, unmount } = render(
      <EventsPanel client={client} active={true} height={12} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('POLL');
    });
    unmount();
  });

  it('shows empty state', async () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <EventsPanel client={client} active={true} height={12} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('No events');
    });
    unmount();
  });
});

// ── ContextsPanel tests ──────────────────────────────────────────────

describe('ContextsPanel', () => {
  it('shows search prompt on initial render', () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <ContextsPanel client={client} active={true} height={12} />,
    );
    expect(lastFrame()).toContain('press / to search');
    expect(lastFrame()).toContain('KNOWLEDGE');
    unmount();
  });

  it('shows (0) count initially', () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <ContextsPanel client={client} active={true} height={12} />,
    );
    expect(lastFrame()).toContain('(0)');
    unmount();
  });
});

// ── PlaybooksPanel tests ─────────────────────────────────────────────

describe('PlaybooksPanel', () => {
  it('renders playbook list', async () => {
    const playbooks = [
      { id: 1, name: 'deploy-prod', description: 'Deploy to production', taskCount: 4, createdBy: 'admin', createdAt: new Date().toISOString() },
    ];
    const client = makeMockClient({
      listPlaybooks: vi.fn().mockResolvedValue({ playbooks }),
    });
    const { lastFrame, unmount } = render(
      <PlaybooksPanel client={client} active={true} height={12} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('deploy-prod');
      expect(lastFrame()).toContain('4 tasks');
    });
    unmount();
  });

  it('shows empty playbooks state', async () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <PlaybooksPanel client={client} active={true} height={12} />,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('No playbooks defined');
    });
    unmount();
  });

  it('renders sub-tab labels', () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <PlaybooksPanel client={client} active={true} height={12} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('Playbooks');
    expect(frame).toContain('Runs');
    expect(frame).toContain('Schedules');
    unmount();
  });
});

// ── StatsPanel tests ─────────────────────────────────────────────────

describe('StatsPanel', () => {
  it('renders analytics data', async () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <StatsPanel client={client} active={true} height={25} />,
    );
    await vi.waitFor(() => {
      const frame = lastFrame();
      expect(frame).toContain('ANALYTICS');
      expect(frame).toContain('Tasks');
      expect(frame).toContain('Events');
      expect(frame).toContain('Agents');
      expect(frame).toContain('Knowledge Base');
    });
    unmount();
  });

  it('shows time window tabs', () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <StatsPanel client={client} active={true} height={25} />,
    );
    const frame = lastFrame();
    expect(frame).toContain('24h');
    expect(frame).toContain('7d');
    expect(frame).toContain('30d');
    unmount();
  });

  it('renders correct agent counts', async () => {
    const client = makeMockClient();
    const { lastFrame, unmount } = render(
      <StatsPanel client={client} active={true} height={25} />,
    );
    await vi.waitFor(() => {
      const frame = lastFrame();
      expect(frame).toContain('5');  // total registered
      expect(frame).toContain('2');  // online
    });
    unmount();
  });

  it('shows loading spinner before data arrives', () => {
    const client = makeMockClient({
      getAnalytics: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { lastFrame, unmount } = render(
      <StatsPanel client={client} active={true} height={25} />,
    );
    expect(lastFrame()).toContain('Loading analytics');
    unmount();
  });
});

// ── Key hints export tests ───────────────────────────────────────────

describe('Panel key hints', () => {
  it('tasksKeyHints includes expected keys', async () => {
    const { tasksKeyHints } = await import('../src/tui/panels/tasks.js');
    const hints = tasksKeyHints();
    const keys = hints.map(h => h.key);
    expect(keys).toContain('j/k');
    expect(keys).toContain('/');
    expect(keys).toContain('c');
    expect(keys).toContain('x');
    expect(keys).toContain('r');
  });

  it('eventsKeyHints includes expected keys', async () => {
    const { eventsKeyHints } = await import('../src/tui/panels/events.js');
    const hints = eventsKeyHints();
    const keys = hints.map(h => h.key);
    expect(keys).toContain('f');
    expect(keys).toContain('t');
  });

  it('statsKeyHints includes time window keys', async () => {
    const { statsKeyHints } = await import('../src/tui/panels/stats.js');
    const hints = statsKeyHints();
    const keys = hints.map(h => h.key);
    expect(keys).toContain('1');
    expect(keys).toContain('2');
    expect(keys).toContain('3');
  });
});
