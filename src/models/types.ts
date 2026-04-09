// ─── Core Domain Types ───────────────────────────────────────────────

export interface ContextEntry {
  id: number;
  workspaceId: string;
  key: string;
  value: string;
  tags: string[];
  createdBy: string;
  createdAt: string; // ISO 8601
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export type EventType = 'LEARNING' | 'BROADCAST' | 'ESCALATION' | 'ERROR' | 'TASK_UPDATE';

export interface Event {
  id: number;
  workspaceId: string;
  eventType: EventType;
  message: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
}

export type TaskStatus = 'open' | 'claimed' | 'completed' | 'escalated' | 'abandoned';

export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface Task {
  id: number;
  workspaceId: string;
  description: string;
  status: TaskStatus;
  result: string | null;
  createdBy: string;
  claimedBy: string | null;
  claimedAt: string | null;
  version: number;
  priority: TaskPriority;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── MCP Tool Input Types ────────────────────────────────────────────

export interface SaveContextInput {
  key: string;
  value: string;
  tags: string[];
}

export interface GetContextInput {
  query: string;
  tags?: string[];
  limit?: number; // default 20, max 100
}

export interface BroadcastInput {
  event_type: EventType;
  message: string;
  tags: string[];
}

export interface GetUpdatesInput {
  since_id?: number;
  since_timestamp?: string;
  topics?: string[];
  event_type?: EventType;
  limit?: number; // default 50, max 200
  agent_id?: string; // caller's agent id for context recommendations
  include_context?: boolean; // default true — set false to skip recommended_context
}

export interface WaitForEventInput {
  since_id: number;
  topics?: string[];
  event_type?: EventType;
  timeout_sec?: number; // default 30, max 60
}

export interface WaitForEventResponse {
  events: Event[];
  cursor: number;
}

export interface CreateTaskInput {
  description: string;
  status?: 'open' | 'claimed'; // default 'claimed'
  depends_on?: number[]; // task IDs that must complete before this one can be claimed
  priority?: TaskPriority; // default 'P2'
  assigned_to?: string; // agent_id this task is assigned to
}

export interface UpdateTaskInput {
  task_id: number;
  status: 'claimed' | 'completed' | 'escalated' | 'abandoned';
  result?: string;
  version: number;
  priority?: TaskPriority;
  assigned_to?: string | null;
}

// ─── MCP Tool Response Types ─────────────────────────────────────────

export interface SaveContextResponse {
  id: number;
  key: string;
  created: boolean;
}

export interface GetContextResponse {
  entries: ContextEntry[];
  total: number;
}

export interface BroadcastResponse {
  eventId: number;
}

export interface RecommendedContextEntry {
  id: number;
  key: string;
  preview: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
}

export interface GetUpdatesResponse {
  events: Event[];
  cursor: number;
  recommended_context?: RecommendedContextEntry[];
}

export interface CreateTaskResponse {
  task_id: number;
  status: TaskStatus;
  claimed_by: string | null;
}

export interface UpdateTaskResponse {
  task_id: number;
  status: TaskStatus;
  version: number;
}

// ─── Message Types ──────────────────────────────────────────────────

export interface Message {
  id: number;
  workspaceId: string;
  fromAgent: string;
  toAgent: string;
  message: string;
  tags: string[];
  createdAt: string;
}

export interface SendMessageInput {
  to: string;
  message: string;
  tags: string[];
}

export interface SendMessageResponse {
  messageId: number;
}

export interface GetMessagesInput {
  since_id?: number;
  limit?: number; // default 50, max 200
}

export interface GetMessagesResponse {
  messages: Message[];
  cursor: number;
}

export interface WaitForMessageInput {
  since_id: number;
  timeout_sec?: number; // default 30, max 60
}

export interface WaitForMessageResponse {
  messages: Message[];
  cursor: number;
}

// ─── Artifact Types ──────────────────────────────────────────────────

export type ArtifactContentType =
  | 'text/plain'
  | 'text/markdown'
  | 'text/html'
  | 'application/json'
  | 'text/x-typescript'
  | 'text/x-javascript'
  | 'text/x-python'
  | 'text/css';

export interface Artifact {
  id: number;
  workspaceId: string;
  key: string;
  contentType: ArtifactContentType;
  content: string;
  metadata: Record<string, unknown>;
  size: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactSummary {
  id: number;
  key: string;
  contentType: ArtifactContentType;
  size: number;
  createdBy: string;
}

export interface SaveArtifactInput {
  key: string;
  content_type: ArtifactContentType;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SaveArtifactResponse {
  id: number;
  key: string;
  size: number;
  created: boolean;
}

export interface ListArtifactsInput {
  content_type?: ArtifactContentType;
  limit?: number;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactSummary[];
  total: number;
}

// ─── Auth & Config ───────────────────────────────────────────────────

export type ApiKeyScope = 'read' | 'write' | 'admin';

export interface AuthContext {
  workspaceId: string;
  agentId: string;
  scope: ApiKeyScope;
  ip?: string;
  requestId?: string;
}

// ─── Error Types ─────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}
