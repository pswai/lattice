# AgentHub Phase 1: Architecture Specification

**Status**: Draft  
**Author**: Principal Engineer  
**Date**: 2026-04-05  
**Scope**: Phase 1 — "The Walkie-Talkie"

---

## 1. Project Structure

```
agenthub/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts                  # Entry point — starts HTTP + MCP servers
│   ├── config.ts                 # Environment/config loading
│   ├── db/
│   │   ├── schema.ts             # CREATE TABLE statements, migrations
│   │   ├── connection.ts         # SQLite connection (WAL mode, better-sqlite3)
│   │   └── migrations/
│   │       └── 001_initial.sql   # Initial schema migration
│   ├── models/
│   │   ├── types.ts              # All TypeScript interfaces/types
│   │   ├── context.ts            # ContextEntry CRUD operations
│   │   ├── event.ts              # Event CRUD operations
│   │   └── task.ts               # Task CRUD + claim/reap operations
│   ├── mcp/
│   │   └── server.ts             # MCP server setup, tool registration
│   ├── http/
│   │   ├── app.ts                # Hono app with middleware
│   │   ├── middleware/
│   │   │   └── auth.ts           # API key auth middleware
│   │   └── routes/
│   │       ├── context.ts        # save_context, get_context
│   │       ├── events.ts         # broadcast, get_updates
│   │       └── tasks.ts          # create_task, update_task
│   ├── services/
│   │   ├── secret-scanner.ts     # Pre-write secret detection
│   │   └── task-reaper.ts        # Background abandoned task reaper
│   └── errors.ts                 # Error types and formatting
├── tests/
│   ├── secret-scanner.test.ts
│   ├── context.test.ts
│   ├── events.test.ts
│   ├── tasks.test.ts
│   └── auth.test.ts
└── README.md
```

**Key decisions:**
- `better-sqlite3` (synchronous, fast, no async overhead for single-file DB)
- Hono for HTTP (lightweight, TypeScript-native, Cloudflare/Node compatible)
- `@modelcontextprotocol/sdk` for MCP server
- Single process — HTTP server + MCP server + task reaper all run in one Node process

---

## 2. Database Schema

SQLite in WAL mode. All timestamps stored as ISO 8601 strings (SQLite has no native datetime; strings sort correctly and are human-readable).

### 2.1 `context_entries` — Append-Only Context Store

```sql
CREATE TABLE context_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
    created_by TEXT NOT NULL,          -- agent identifier
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    
    -- Indexes for common query patterns
    UNIQUE(team_id, key)              -- key is unique per team (upsert semantics: see note)
);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE context_entries_fts USING fts5(
    key,
    value,
    tags,
    content='context_entries',
    content_rowid='id'
);

-- Triggers to keep FTS index in sync (append-only, but we handle key conflicts via INSERT OR REPLACE)
CREATE TRIGGER context_entries_ai AFTER INSERT ON context_entries BEGIN
    INSERT INTO context_entries_fts(rowid, key, value, tags)
    VALUES (new.id, new.key, new.value, new.tags);
END;

CREATE TRIGGER context_entries_ad AFTER DELETE ON context_entries BEGIN
    INSERT INTO context_entries_fts(context_entries_fts, rowid, key, value, tags)
    VALUES ('delete', old.id, old.key, old.value, old.tags);
END;

CREATE INDEX idx_context_team ON context_entries(team_id);
CREATE INDEX idx_context_created ON context_entries(created_at);
```

**Note on "append-only"**: The design doc says append-only, but `key` serves as a logical identifier. We use `INSERT OR REPLACE` — if an agent saves the same key twice, the old row is replaced. This is effectively append-only from a usage perspective (agents don't delete), but allows key-based updates. The FTS delete trigger handles the replaced row cleanup.

### 2.2 `events` — Messaging Bus

```sql
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE')),
    message TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
    created_by TEXT NOT NULL,          -- agent identifier
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_events_team_time ON events(team_id, created_at);
CREATE INDEX idx_events_team_id ON events(team_id, id);
```

**Polling query pattern**: `get_updates` uses `id > ?` (not timestamp) for cursor-based pagination. This avoids clock skew issues. The `since_timestamp` from the MCP tool interface is converted to an event ID internally via a lookup, or agents can pass `since_id` directly.

### 2.3 `tasks` — Task Coordination with Claim/Reap

```sql
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'completed', 'escalated', 'abandoned')),
    result TEXT,                        -- completion result or escalation reason
    created_by TEXT NOT NULL,           -- agent that created the task
    claimed_by TEXT,                    -- agent that claimed the task (NULL if unclaimed)
    claimed_at TEXT,                    -- ISO 8601 timestamp of claim
    version INTEGER NOT NULL DEFAULT 1, -- optimistic locking
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tasks_team ON tasks(team_id);
CREATE INDEX idx_tasks_status ON tasks(team_id, status);
CREATE INDEX idx_tasks_reap ON tasks(status, claimed_at);  -- for reaper queries
```

**Optimistic locking**: Every write to `tasks` must include `WHERE version = ?`. The update sets `version = version + 1`. If 0 rows affected, the claim was lost to a concurrent agent — return a conflict error.

### 2.4 `api_keys` — Team Authentication

```sql
CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,     -- SHA-256 hash of the API key
    label TEXT NOT NULL DEFAULT '',     -- human-readable label ("Sarah's Claude Code")
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    
    FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE teams (
    id TEXT PRIMARY KEY,                -- UUID or slug
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

---

## 3. TypeScript Interfaces

All types live in `src/models/types.ts`.

```typescript
// ─── Core Domain Types ───────────────────────────────────────────────

export interface ContextEntry {
  id: number;
  teamId: string;
  key: string;
  value: string;
  tags: string[];
  createdBy: string;
  createdAt: string; // ISO 8601
}

export type EventType = 'LEARNING' | 'BROADCAST' | 'ESCALATION' | 'ERROR' | 'TASK_UPDATE';

export interface Event {
  id: number;
  teamId: string;
  eventType: EventType;
  message: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
}

export type TaskStatus = 'open' | 'claimed' | 'completed' | 'escalated' | 'abandoned';

export interface Task {
  id: number;
  teamId: string;
  description: string;
  status: TaskStatus;
  result: string | null;
  createdBy: string;
  claimedBy: string | null;
  claimedAt: string | null;
  version: number;
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
  since_id?: number;         // cursor-based: events with id > since_id
  since_timestamp?: string;  // fallback: ISO 8601 timestamp
  topics?: string[];         // tag filter
  limit?: number;            // default 50, max 200
}

export interface CreateTaskInput {
  description: string;
  status?: 'open' | 'claimed'; // default 'claimed' (creator auto-claims)
}

export interface UpdateTaskInput {
  task_id: number;
  status: 'completed' | 'escalated' | 'abandoned';
  result?: string;
}

// ─── MCP Tool Response Types ─────────────────────────────────────────

export interface SaveContextResponse {
  id: number;
  key: string;
  created: boolean; // true if new, false if replaced
}

export interface GetContextResponse {
  entries: ContextEntry[];
  total: number;
}

export interface BroadcastResponse {
  event_id: number;
}

export interface GetUpdatesResponse {
  events: Event[];
  cursor: number; // highest event ID returned — pass as since_id next time
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

// ─── Auth & Config ───────────────────────────────────────────────────

export interface AuthContext {
  teamId: string;
  agentId: string; // from X-Agent-ID header
}

export interface AppConfig {
  port: number;                    // default 3000
  dbPath: string;                  // default ./data/agenthub.db
  pollIntervalMs: number;          // default 5000 (informational, client-side)
  taskReapTimeoutMinutes: number;  // default 30
  taskReapIntervalMs: number;      // default 60000 (how often reaper runs)
  logLevel: string;                // default 'info'
}

// ─── Error Types ─────────────────────────────────────────────────────

export interface ApiError {
  error: string;   // machine-readable code: 'SECRET_DETECTED', 'TASK_CONFLICT', etc.
  message: string; // human-readable description
  details?: Record<string, unknown>;
}
```

---

## 4. API Design — Hono HTTP Routes

All routes are prefixed with `/api/v1`. All requests require the `Authorization: Bearer <api_key>` header. The `X-Agent-ID` header identifies the calling agent (required).

### Route Table

| Method | Path | MCP Tool | Description |
|--------|------|----------|-------------|
| POST | `/api/v1/context` | `save_context` | Save a context entry |
| GET | `/api/v1/context` | `get_context` | Search context entries |
| POST | `/api/v1/events` | `broadcast` | Broadcast an event |
| GET | `/api/v1/events` | `get_updates` | Poll for events |
| POST | `/api/v1/tasks` | `create_task` | Create (and optionally claim) a task |
| PATCH | `/api/v1/tasks/:id` | `update_task` | Update task status |

### 4.1 `POST /api/v1/context` — save_context

**Request:**
```json
{
  "key": "stripe-retry-behavior",
  "value": "Stripe webhooks retry 3x with exponential backoff. Use event ID as idempotency key.",
  "tags": ["stripe", "webhooks", "idempotency"]
}
```

**Success Response (201 Created):**
```json
{
  "id": 42,
  "key": "stripe-retry-behavior",
  "created": true
}
```

**Error Response (422 — secret detected):**
```json
{
  "error": "SECRET_DETECTED",
  "message": "Content blocked: potential secret detected. Remove the sensitive value before saving.",
  "details": {
    "pattern": "AWS Access Key",
    "match_preview": "AKIA...XXXX"
  }
}
```

**Implementation notes:**
1. Run secret scanner on `value` field before any DB write
2. Use `INSERT OR REPLACE` with `UNIQUE(team_id, key)` — set `created: false` if replaced
3. After successful save, auto-broadcast a `LEARNING` event to the events table

### 4.2 `GET /api/v1/context` — get_context

**Query params:**
- `query` (required): FTS5 search string
- `tags` (optional): comma-separated tag filter (OR matching)
- `limit` (optional): max results, default 20, max 100

**Example:** `GET /api/v1/context?query=stripe+webhooks&tags=stripe,payments&limit=10`

**Success Response (200):**
```json
{
  "entries": [
    {
      "id": 42,
      "key": "stripe-retry-behavior",
      "value": "Stripe webhooks retry 3x with exponential backoff...",
      "tags": ["stripe", "webhooks", "idempotency"],
      "createdBy": "sarah-claude-code",
      "createdAt": "2026-04-05T14:30:00.000Z"
    }
  ],
  "total": 1
}
```

**SQL query pattern:**
```sql
-- When both query and tags are provided:
SELECT ce.* FROM context_entries ce
JOIN context_entries_fts fts ON ce.id = fts.rowid
WHERE ce.team_id = ?
  AND EXISTS (
    SELECT 1 FROM json_each(ce.tags) AS t
    WHERE t.value IN (?, ?, ?)  -- tag filter (OR match)
  )
  AND context_entries_fts MATCH ?  -- FTS5 query
ORDER BY fts.rank
LIMIT ?;

-- When only query is provided (no tags):
SELECT ce.* FROM context_entries ce
JOIN context_entries_fts fts ON ce.id = fts.rowid
WHERE ce.team_id = ?
  AND context_entries_fts MATCH ?
ORDER BY fts.rank
LIMIT ?;

-- When only tags are provided (no query):
SELECT ce.* FROM context_entries ce
WHERE ce.team_id = ?
  AND EXISTS (
    SELECT 1 FROM json_each(ce.tags) AS t
    WHERE t.value IN (?, ?, ?)
  )
ORDER BY ce.created_at DESC
LIMIT ?;
```

### 4.3 `POST /api/v1/events` — broadcast

**Request:**
```json
{
  "event_type": "BROADCAST",
  "message": "Auth middleware now requires X-Request-ID header on all requests",
  "tags": ["auth", "api", "breaking-change"]
}
```

**Success Response (201):**
```json
{
  "event_id": 157
}
```

**Validation:**
- `event_type` must be one of: `LEARNING`, `BROADCAST`, `ESCALATION`, `ERROR`, `TASK_UPDATE`
- `message` must be non-empty, max 10,000 characters
- `tags` must be an array of strings, max 20 tags, each max 50 characters

### 4.4 `GET /api/v1/events` — get_updates

**Query params:**
- `since_id` (optional): return events with `id > since_id` (preferred cursor)
- `since_timestamp` (optional): fallback if `since_id` not available
- `topics` (optional): comma-separated tag filter
- `limit` (optional): default 50, max 200

**Example:** `GET /api/v1/events?since_id=150&topics=stripe,auth&limit=20`

**Success Response (200):**
```json
{
  "events": [
    {
      "id": 157,
      "eventType": "BROADCAST",
      "message": "Auth middleware now requires X-Request-ID header",
      "tags": ["auth", "api", "breaking-change"],
      "createdBy": "sarah-claude-code",
      "createdAt": "2026-04-05T15:00:00.000Z"
    }
  ],
  "cursor": 157
}
```

**SQL:**
```sql
-- With since_id + topics:
SELECT * FROM events
WHERE team_id = ?
  AND id > ?
  AND EXISTS (
    SELECT 1 FROM json_each(tags) AS t
    WHERE t.value IN (?, ?)
  )
ORDER BY id ASC
LIMIT ?;
```

**Important**: Return events in ascending ID order so agents process them chronologically. The `cursor` field is the max ID in the result set — agents pass it as `since_id` on the next poll.

### 4.5 `POST /api/v1/tasks` — create_task

**Request:**
```json
{
  "description": "Fix webhook handler for idempotency",
  "status": "claimed"
}
```

**Success Response (201):**
```json
{
  "task_id": 8,
  "status": "claimed",
  "claimed_by": "sarah-claude-code"
}
```

**Behavior:**
- If `status` is `"claimed"` (default), the creating agent is auto-set as `claimed_by`
- If `status` is `"open"`, the task is created unclaimed
- A `TASK_UPDATE` event is auto-broadcast after creation

### 4.6 `PATCH /api/v1/tasks/:id` — update_task

**Request:**
```json
{
  "status": "completed",
  "result": "Added idempotency check using Stripe event ID as dedup key",
  "version": 1
}
```

**Success Response (200):**
```json
{
  "task_id": 8,
  "status": "completed",
  "version": 2
}
```

**Error Response (409 — optimistic lock conflict):**
```json
{
  "error": "TASK_CONFLICT",
  "message": "Task was modified by another agent. Fetch the latest version and retry.",
  "details": {
    "current_version": 3,
    "your_version": 1
  }
}
```

**State transitions allowed:**

| From | To | Who |
|------|----|-----|
| `open` | `claimed` | Any agent (sets `claimed_by`, `claimed_at`) |
| `claimed` | `completed` | Only `claimed_by` agent |
| `claimed` | `escalated` | Only `claimed_by` agent |
| `claimed` | `abandoned` | Only `claimed_by` agent or the reaper |
| `abandoned` | `claimed` | Any agent (re-claim) |

Invalid transitions return `400 Bad Request` with error code `INVALID_TRANSITION`.

**Side effects:**
- On `completed`: auto-broadcast `TASK_UPDATE` event + append result as context entry (key: `task-result-{task_id}`)
- On `escalated`: auto-broadcast `ESCALATION` event
- On `abandoned`: auto-broadcast `TASK_UPDATE` event, clear `claimed_by`/`claimed_at`
- On `claimed` (from open/abandoned): set `claimed_by` to requesting agent, set `claimed_at` to now

---

## 5. MCP Server Setup

The MCP server uses `@modelcontextprotocol/sdk` with **Streamable HTTP transport** (the standard for remote MCP servers). It connects to the same Hono HTTP server — the MCP SDK handles the `/mcp` endpoint.

### 5.1 Server Registration (`src/mcp/server.ts`)

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'agenthub',
    version: '0.1.0',
  });

  // Register all 6 tools
  server.tool('save_context', 'Persist a learning or context entry to the shared team knowledge base. Pre-write secret scanning blocks entries containing API keys.', {
    key: { type: 'string', description: 'Unique identifier for this context entry (e.g., "stripe-retry-behavior")' },
    value: { type: 'string', description: 'The context content to save' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization and filtering' },
  }, handleSaveContext);

  server.tool('get_context', 'Search the shared team knowledge base using full-text search and optional tag filtering.', {
    query: { type: 'string', description: 'Full-text search query' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter (OR matching)' },
    limit: { type: 'number', description: 'Max results (default 20, max 100)' },
  }, handleGetContext);

  server.tool('broadcast', 'Push an event to the team messaging bus. Other agents receive it on their next poll.', {
    event_type: { type: 'string', enum: ['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE'], description: 'Type of event' },
    message: { type: 'string', description: 'Event message content' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Tags for topic-based filtering' },
  }, handleBroadcast);

  server.tool('get_updates', 'Poll for events since your last check. Use the returned cursor as since_id on your next call.', {
    since_id: { type: 'number', description: 'Return events after this ID (preferred — use cursor from previous response)' },
    since_timestamp: { type: 'string', description: 'Fallback: ISO 8601 timestamp' },
    topics: { type: 'array', items: { type: 'string' }, description: 'Optional topic filter' },
    limit: { type: 'number', description: 'Max events to return (default 50, max 200)' },
  }, handleGetUpdates);

  server.tool('create_task', 'Create a work item visible to all agents. Defaults to auto-claiming for the creator.', {
    description: { type: 'string', description: 'What needs to be done' },
    status: { type: 'string', enum: ['open', 'claimed'], description: 'Initial status (default: claimed — creator auto-claims)' },
  }, handleCreateTask);

  server.tool('update_task', 'Update a task status. Uses optimistic locking — include the current version number.', {
    task_id: { type: 'number', description: 'Task ID to update' },
    status: { type: 'string', enum: ['claimed', 'completed', 'escalated', 'abandoned'], description: 'New status' },
    result: { type: 'string', description: 'Completion result or escalation reason' },
    version: { type: 'number', description: 'Current version for optimistic locking (required)' },
  }, handleUpdateTask);

  return server;
}
```

### 5.2 Transport Integration with Hono

The MCP Streamable HTTP transport is mounted on the Hono app at `/mcp`:

```typescript
// In src/http/app.ts
import { Hono } from 'hono';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = new Hono();

// MCP endpoint — handles POST /mcp for JSON-RPC
app.post('/mcp', async (c) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);
  // Forward the request body to the transport
  const body = await c.req.json();
  const result = await transport.handleRequest(body, c.req.raw.headers);
  return c.json(result);
});

// REST API routes under /api/v1/...
```

**Note on auth for MCP**: The MCP transport doesn't natively support auth headers. We extract `Authorization` and `X-Agent-ID` from the HTTP request headers before passing to MCP handlers. Each MCP tool handler receives auth context via a closure or middleware injection.

### 5.3 Agent MCP Client Configuration

Agents configure AgentHub as a remote MCP server. Example for Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "agenthub": {
      "type": "streamableHttp",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ahk_team_abc123...",
        "X-Agent-ID": "sarah-claude-code"
      }
    }
  }
}
```

---

## 6. Secret Scanning

### 6.1 Implementation (`src/services/secret-scanner.ts`)

The secret scanner is a **synchronous, pre-write hook** that runs on the `value` field of every `save_context` call. It blocks the write and returns an error if a match is found.

```typescript
export interface SecretMatch {
  pattern: string;  // human-readable name
  preview: string;  // first 4 chars + "..." + last 4 chars (for error message)
}

export interface ScanResult {
  clean: boolean;
  matches: SecretMatch[];
}

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // AWS
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS Secret Access Key', regex: /\b[A-Za-z0-9/+=]{40}\b(?=.*aws|.*secret)/i },

  // Stripe
  { name: 'Stripe Secret Key', regex: /\bsk_live_[0-9a-zA-Z]{24,}\b/ },
  { name: 'Stripe Restricted Key', regex: /\brk_live_[0-9a-zA-Z]{24,}\b/ },

  // Generic API keys / tokens
  { name: 'Generic API Key', regex: /\b(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/i },
  { name: 'Bearer Token (long)', regex: /\bBearer\s+[A-Za-z0-9_\-\.]{40,}\b/ },
  { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },

  // GitHub
  { name: 'GitHub Personal Access Token', regex: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub OAuth Token', regex: /\bgho_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub App Token', regex: /\bghs_[A-Za-z0-9]{36}\b/ },

  // Slack
  { name: 'Slack Bot Token', regex: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}\b/ },
  { name: 'Slack Webhook URL', regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },

  // OpenAI / Anthropic
  { name: 'OpenAI API Key', regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Anthropic API Key', regex: /\bsk-ant-[A-Za-z0-9_\-]{40,}\b/ },

  // Database URLs with credentials
  { name: 'Database Connection String', regex: /(?:postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:]+:[^\s@]+@/ },
];

export function scanForSecrets(text: string): ScanResult {
  const matches: SecretMatch[] = [];

  for (const { name, regex } of SECRET_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      const full = match[0];
      const preview = full.length > 12
        ? `${full.slice(0, 4)}...${full.slice(-4)}`
        : `${full.slice(0, 4)}...`;
      matches.push({ pattern: name, preview });
    }
  }

  return { clean: matches.length === 0, matches };
}
```

### 6.2 Integration Point

Called in the `save_context` route handler **before** any database operation:

```typescript
// In POST /api/v1/context handler
const scan = scanForSecrets(input.value);
if (!scan.clean) {
  return c.json({
    error: 'SECRET_DETECTED',
    message: 'Content blocked: potential secret detected. Remove the sensitive value before saving.',
    details: {
      pattern: scan.matches[0].pattern,
      match_preview: scan.matches[0].preview,
    },
  }, 422);
}
```

Also scan the `key` field (in case agents put secrets in keys) and `message` field of `broadcast`.

---

## 7. Task Reaping

### 7.1 Mechanism (`src/services/task-reaper.ts`)

A `setInterval` loop running every `config.taskReapIntervalMs` (default 60 seconds). It queries for tasks that have been claimed for longer than `config.taskReapTimeoutMinutes` (default 30 minutes) and auto-abandons them.

```typescript
export function startTaskReaper(db: Database, config: AppConfig): NodeJS.Timeout {
  return setInterval(() => {
    reapAbandonedTasks(db);
  }, config.taskReapIntervalMs);
}

function reapAbandonedTasks(db: Database): void {
  const cutoff = new Date(Date.now() - config.taskReapTimeoutMinutes * 60 * 1000).toISOString();

  // Find and abandon stale claimed tasks
  const staleTasks = db.prepare(`
    SELECT id, team_id, description, claimed_by, version
    FROM tasks
    WHERE status = 'claimed'
      AND claimed_at < ?
  `).all(cutoff);

  for (const task of staleTasks) {
    const result = db.prepare(`
      UPDATE tasks
      SET status = 'abandoned',
          claimed_by = NULL,
          claimed_at = NULL,
          result = 'Auto-released: agent did not complete within timeout',
          version = version + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND version = ?
    `).run(task.id, task.version);

    if (result.changes > 0) {
      // Broadcast TASK_UPDATE event for the abandoned task
      db.prepare(`
        INSERT INTO events (team_id, event_type, message, tags, created_by)
        VALUES (?, 'TASK_UPDATE', ?, '["task-reaper"]', 'system:reaper')
      `).run(task.team_id, `Task "${task.description}" auto-released (claimed by ${task.claimed_by}, timed out)`);
    }
  }
}
```

**Key design choices:**
- Uses optimistic locking (`WHERE version = ?`) so the reaper doesn't accidentally abandon a task that was just completed
- Broadcasts a `TASK_UPDATE` event so other agents learn the task is available
- Reaper identifies itself as `system:reaper` in `created_by`
- The reaper runs in the same process — no external cron needed

---

## 8. Auth Model

### 8.1 API Key Scheme

Each team gets one or more API keys. Keys are prefixed `ahk_` for easy identification. The key is hashed with SHA-256 before storage (we never store plaintext keys).

**Key format:** `ahk_{team_slug}_{random_32_chars}`  
**Example:** `ahk_acme_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`

### 8.2 Auth Middleware (`src/http/middleware/auth.ts`)

```typescript
import { createMiddleware } from 'hono/factory';
import { createHash } from 'crypto';

export const authMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' }, 401);
  }

  const apiKey = authHeader.slice(7);
  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  const row = db.prepare('SELECT team_id FROM api_keys WHERE key_hash = ?').get(keyHash);
  if (!row) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid API key' }, 401);
  }

  const agentId = c.req.header('X-Agent-ID') || 'anonymous';

  // Set auth context for downstream handlers
  c.set('auth', { teamId: row.team_id, agentId });

  await next();
});
```

**Design notes:**
- `X-Agent-ID` is optional but strongly recommended. Without it, the agent shows as "anonymous" in events and tasks.
- Team-scoped: all data queries filter by `team_id` from the auth context. There is zero cross-team data access.
- For MVP, key management is manual (CLI script or direct DB insert). Phase 2 adds a dashboard for key management.

---

## 9. Error Handling

### 9.1 Error Codes

| Code | HTTP Status | When |
|------|-------------|------|
| `SECRET_DETECTED` | 422 | `save_context` or `broadcast` value contains a potential secret |
| `TASK_CONFLICT` | 409 | Optimistic lock failure on task update |
| `INVALID_TRANSITION` | 400 | Task status transition not allowed (e.g., open → completed) |
| `NOT_FOUND` | 404 | Task ID doesn't exist |
| `UNAUTHORIZED` | 401 | Missing/invalid API key |
| `FORBIDDEN` | 403 | Agent trying to complete/abandon a task they didn't claim |
| `VALIDATION_ERROR` | 400 | Missing required fields, invalid types, value too long |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### 9.2 Response Format

All errors follow the same shape:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "details": {}
}
```

For MCP tool responses, errors are returned as `isError: true` content:

```typescript
return {
  content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
  isError: true,
};
```

### 9.3 Validation

Use Zod for input validation on all routes. Define schemas matching the input types in Section 3. Return `VALIDATION_ERROR` with Zod's error messages in `details`.

---

## 10. Configuration

All configuration via environment variables, loaded in `src/config.ts`.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `DB_PATH` | `./data/agenthub.db` | SQLite database file path |
| `TASK_REAP_TIMEOUT_MINUTES` | `30` | Minutes before a claimed task is auto-abandoned |
| `TASK_REAP_INTERVAL_MS` | `60000` | How often the reaper checks for stale tasks |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `NODE_ENV` | `development` | Environment: development, production |

**`.env.example`:**
```env
PORT=3000
DB_PATH=./data/agenthub.db
TASK_REAP_TIMEOUT_MINUTES=30
TASK_REAP_INTERVAL_MS=60000
LOG_LEVEL=info
NODE_ENV=development
```

---

## 11. Entry Point (`src/index.ts`)

```typescript
import { serve } from '@hono/node-server';
import { createApp } from './http/app.js';
import { createMcpServer } from './mcp/server.js';
import { initDatabase } from './db/connection.js';
import { startTaskReaper } from './services/task-reaper.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = initDatabase(config.dbPath);
const mcpServer = createMcpServer(db);
const app = createApp(db, mcpServer);

startTaskReaper(db, config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`AgentHub listening on http://localhost:${info.port}`);
  console.log(`MCP endpoint: http://localhost:${info.port}/mcp`);
  console.log(`REST API: http://localhost:${info.port}/api/v1`);
});
```

---

## 12. Dependencies

```json
{
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.7.0",
    "hono": "^4.7.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.1.0"
  }
}
```

---

## 13. Implementation Order

The staff engineer should implement in this order:

1. **Project scaffold** — `package.json`, `tsconfig.json`, directory structure
2. **Config + DB** — `config.ts`, `connection.ts`, `schema.ts` with all CREATE statements
3. **Types** — `models/types.ts` with all interfaces
4. **Secret scanner** — `services/secret-scanner.ts` + tests
5. **Model layer** — `models/context.ts`, `models/event.ts`, `models/task.ts` (DB operations)
6. **Auth middleware** — `http/middleware/auth.ts`
7. **HTTP routes** — `routes/context.ts`, `routes/events.ts`, `routes/tasks.ts`
8. **MCP server** — `mcp/server.ts` (thin wrapper calling the same model layer as HTTP routes)
9. **Task reaper** — `services/task-reaper.ts`
10. **Entry point** — `src/index.ts` wiring everything together
11. **Tests** — unit tests for scanner, integration tests for routes

---

## 14. What This Doc Does NOT Cover (Phase 2)

- SSE push delivery
- Knowledge engine (compile step, two-layer store)
- Web dashboard
- PostgreSQL migration
- Embedding-based semantic search
- Knowledge linter
- Multi-tenant hosting

These are explicitly out of scope for Phase 1.
