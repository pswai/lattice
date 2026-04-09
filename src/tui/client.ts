/**
 * Lattice REST API client for TUI.
 * Zero external deps — uses native fetch (Node 18+).
 */

import type {
  Task, Event, ContextEntry, Message, Artifact, ArtifactSummary,
  TaskStatus, TaskPriority, EventType, ArtifactContentType,
} from '../models/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface AgentInfo {
  id: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'busy';
  metadata: Record<string, unknown>;
  lastHeartbeat: string;
  registeredAt: string;
}

export interface PlaybookInfo {
  id: number;
  name: string;
  description: string;
  taskCount: number;
  createdBy: string;
  createdAt: string;
}

export interface WorkflowRunInfo {
  id: number;
  playbook_name: string;
  started_by: string;
  task_ids: number[];
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
}

export interface ScheduleInfo {
  id: number;
  playbook_name: string;
  cron_expression: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  created_by: string;
}

export interface ProfileInfo {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  default_capabilities: string[];
  default_tags: string[];
  created_by: string;
}

export interface AnalyticsData {
  tasks: {
    total: number;
    by_status: Record<string, number>;
    completion_rate: number;
    avg_completion_ms: number | null;
    median_completion_ms: number | null;
  };
  events: { total: number; by_type: Record<string, number> };
  agents: { total: number; online: number };
  context: { total_entries: number; entries_since: number };
}

export interface TaskGraphData {
  nodes: Array<{ id: number; description: string; status: TaskStatus; priority: TaskPriority; claimed_by: string | null }>;
  edges: Array<{ from: number; to: number }>;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class LatticeClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET ${path}: ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${path}: ${res.status} ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PATCH ${path}: ${res.status} ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // ── Health ───────────────────────────────────────────────────────────────

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  async listTasks(filters?: {
    status?: string; claimed_by?: string; assigned_to?: string;
    priority?: string; limit?: number;
  }): Promise<{ tasks: Task[]; total: number }> {
    const params = new URLSearchParams();
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined) params.set(k, String(v));
      }
    }
    const qs = params.toString();
    return this.get(`/tasks${qs ? `?${qs}` : ''}`);
  }

  async getTask(id: number): Promise<Task> {
    return this.get(`/tasks/${id}`);
  }

  async getTaskGraph(filters?: { status?: string; limit?: number }): Promise<TaskGraphData> {
    const params = new URLSearchParams();
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined) params.set(k, String(v));
      }
    }
    const qs = params.toString();
    return this.get(`/tasks/graph${qs ? `?${qs}` : ''}`);
  }

  async createTask(description: string, opts?: {
    status?: 'open' | 'claimed'; priority?: TaskPriority; assigned_to?: string; depends_on?: number[];
  }): Promise<{ task_id: number; status: TaskStatus; claimed_by: string | null }> {
    return this.post('/tasks', { description, ...opts });
  }

  async updateTask(id: number, status: string, version: number, opts?: {
    result?: string; priority?: TaskPriority; assigned_to?: string | null;
  }): Promise<{ task_id: number; status: TaskStatus; version: number }> {
    return this.patch(`/tasks/${id}`, { status, version, ...opts });
  }

  // ── Events ───────────────────────────────────────────────────────────────

  async listEvents(opts?: {
    since_id?: number; event_type?: EventType; limit?: number;
  }): Promise<{ events: Event[]; cursor: number }> {
    const params = new URLSearchParams();
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined) params.set(k, String(v));
      }
    }
    const qs = params.toString();
    return this.get(`/events${qs ? `?${qs}` : ''}`);
  }

  sseUrl(): string {
    return `${this.baseUrl}/api/v1/events/stream`;
  }

  get authHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  // ── Agents ───────────────────────────────────────────────────────────────

  async listAgents(filters?: {
    capability?: string; status?: string;
  }): Promise<{ agents: AgentInfo[] }> {
    const params = new URLSearchParams();
    if (filters) {
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined) params.set(k, String(v));
      }
    }
    const qs = params.toString();
    return this.get(`/agents${qs ? `?${qs}` : ''}`);
  }

  // ── Context ──────────────────────────────────────────────────────────────

  async searchContext(query: string, opts?: {
    tags?: string[]; limit?: number;
  }): Promise<{ entries: ContextEntry[]; total: number }> {
    const params = new URLSearchParams({ query });
    if (opts?.tags?.length) params.set('tags', opts.tags.join(','));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.get(`/context?${params}`);
  }

  // ── Playbooks ────────────────────────────────────────────────────────────

  async listPlaybooks(): Promise<{ playbooks: PlaybookInfo[] }> {
    return this.get('/playbooks');
  }

  async runPlaybook(name: string, variables?: Record<string, string>): Promise<{ workflow_run_id: number; task_ids: number[] }> {
    return this.post('/playbooks/run', { name, variables });
  }

  // ── Workflow Runs ────────────────────────────────────────────────────────

  async listWorkflowRuns(opts?: { limit?: number }): Promise<{ runs: WorkflowRunInfo[] }> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.get(`/workflow-runs${qs ? `?${qs}` : ''}`);
  }

  // ── Schedules ────────────────────────────────────────────────────────────

  async listSchedules(): Promise<{ schedules: ScheduleInfo[] }> {
    return this.get('/schedules');
  }

  // ── Profiles ─────────────────────────────────────────────────────────────

  async listProfiles(): Promise<{ profiles: ProfileInfo[] }> {
    return this.get('/profiles');
  }

  // ── Analytics ────────────────────────────────────────────────────────────

  async getAnalytics(window?: '24h' | '7d' | '30d'): Promise<AnalyticsData> {
    const qs = window ? `?window=${window}` : '';
    return this.get(`/analytics${qs}`);
  }

  // ── Artifacts ────────────────────────────────────────────────────────────

  async listArtifacts(opts?: { content_type?: ArtifactContentType; limit?: number }): Promise<{ artifacts: ArtifactSummary[]; total: number }> {
    const params = new URLSearchParams();
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined) params.set(k, String(v));
      }
    }
    const qs = params.toString();
    return this.get(`/artifacts${qs ? `?${qs}` : ''}`);
  }
}
