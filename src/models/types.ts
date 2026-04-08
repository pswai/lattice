// ─── Core Domain Types ───────────────────────────────────────────────

/** A stored key-value context entry within a workspace. */
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

/** A domain event broadcast within a workspace (learning, escalation, error, etc.). */
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

/** A trackable unit of work with optimistic-locking version control. */
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

/** Input for creating or updating a context entry (upsert by key). */
export interface SaveContextInput {
  key: string;
  value: string;
  tags: string[];
}

/** Input for full-text search over context entries. */
export interface GetContextInput {
  query: string;
  tags?: string[];
  limit?: number; // default 20, max 100
}

/** Input for broadcasting a domain event to the workspace. */
export interface BroadcastInput {
  event_type: EventType;
  message: string;
  tags: string[];
}

/** Input for polling events since a cursor, with optional topic/type filters. */
export interface GetUpdatesInput {
  since_id?: number;
  since_timestamp?: string;
  topics?: string[];
  event_type?: EventType;
  limit?: number; // default 50, max 200
  agent_id?: string; // caller's agent id for context recommendations
  include_context?: boolean; // default true — set false to skip recommended_context
}

/** Input for long-polling until matching events arrive or timeout. */
export interface WaitForEventInput {
  since_id: number;
  topics?: string[];
  event_type?: EventType;
  timeout_sec?: number; // default 30, max 60
}

/** Response from a wait_for_event long-poll. */
export interface WaitForEventResponse {
  events: Event[];
  cursor: number;
}

/** Input for creating a new task, optionally with dependency edges. */
export interface CreateTaskInput {
  description: string;
  status?: 'open' | 'claimed'; // default 'claimed'
  depends_on?: number[]; // task IDs that must complete before this one can be claimed
  priority?: TaskPriority; // default 'P2'
  assigned_to?: string; // agent_id this task is assigned to
}

/** Input for transitioning a task's status with optimistic-lock version. */
export interface UpdateTaskInput {
  task_id: number;
  status: 'claimed' | 'completed' | 'escalated' | 'abandoned';
  result?: string;
  version: number;
  priority?: TaskPriority;
  assigned_to?: string | null;
}

// ─── MCP Tool Response Types ─────────────────────────────────────────

/** Response after saving a context entry — indicates whether it was created or updated. */
export interface SaveContextResponse {
  id: number;
  key: string;
  created: boolean;
}

/** Paginated response from a context search. */
export interface GetContextResponse {
  entries: ContextEntry[];
  total: number;
}

/** Response after broadcasting an event. */
export interface BroadcastResponse {
  eventId: number;
}

/** A context entry surfaced as relevant to the caller's recent activity. */
export interface RecommendedContextEntry {
  id: number;
  key: string;
  preview: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
}

/** Response from get_updates — events plus an optional recommended_context digest. */
export interface GetUpdatesResponse {
  events: Event[];
  cursor: number;
  recommended_context?: RecommendedContextEntry[];
}

/** Response after creating a task. */
export interface CreateTaskResponse {
  task_id: number;
  status: TaskStatus;
  claimed_by: string | null;
}

/** Response after updating a task's status. */
export interface UpdateTaskResponse {
  task_id: number;
  status: TaskStatus;
  version: number;
}

// ─── Message Types ──────────────────────────────────────────────────

/** A direct message between agents in a workspace. */
export interface Message {
  id: number;
  workspaceId: string;
  fromAgent: string;
  toAgent: string;
  message: string;
  tags: string[];
  createdAt: string;
}

/** Input for sending a direct message to another agent. */
export interface SendMessageInput {
  to: string;
  message: string;
  tags: string[];
}

/** Response after sending a message. */
export interface SendMessageResponse {
  messageId: number;
}

/** Input for polling direct messages since a cursor. */
export interface GetMessagesInput {
  since_id?: number;
  limit?: number; // default 50, max 200
}

/** Paginated response of direct messages. */
export interface GetMessagesResponse {
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

/** A versioned artifact stored in the workspace (code, docs, JSON, etc.). */
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

/** Lightweight artifact metadata without the content body. */
export interface ArtifactSummary {
  id: number;
  workspaceId: string;
  key: string;
  contentType: ArtifactContentType;
  metadata: Record<string, unknown>;
  size: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating or updating an artifact (upsert by key). */
export interface SaveArtifactInput {
  key: string;
  content_type: ArtifactContentType;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Response after saving an artifact. */
export interface SaveArtifactResponse {
  id: number;
  key: string;
  size: number;
  created: boolean;
}

/** Input for listing artifacts with optional content-type filter. */
export interface ListArtifactsInput {
  content_type?: ArtifactContentType;
  limit?: number;
}

/** Paginated response of artifact summaries. */
export interface ListArtifactsResponse {
  artifacts: ArtifactSummary[];
  total: number;
}

// ─── Auth & Config ───────────────────────────────────────────────────

export type ApiKeyScope = 'read' | 'write' | 'admin';

/** Authentication context extracted from API key or MCP session headers. */
export interface AuthContext {
  workspaceId: string;
  agentId: string;
  scope: ApiKeyScope;
  ip?: string;
  requestId?: string;
}

// ─── Error Types ─────────────────────────────────────────────────────

/** Standard error response shape returned by the HTTP API. */
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}
