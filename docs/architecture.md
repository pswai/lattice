# Lattice Architecture (Phase 2)

**Status**: Current  
**Date**: 2026-04-05  
**Scope**: Phase 1 + Phase 2 — Full feature set

---

## 1. Overview

Lattice is an MCP-native coordination layer for AI agent teams. It provides shared knowledge, event-driven messaging, task management, agent discovery, and direct messaging — all accessible via MCP tools or REST API.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code Agents                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Agent A   │  │ Agent B   │  │ Agent C   │  │ Agent D   │  │
│  └────┬──────┘  └────┬──────┘  └────┬──────┘  └────┬──────┘  │
│       │              │              │              │          │
│       └──────────────┴──────┬───────┴──────────────┘          │
│                             │ MCP (Streamable HTTP)           │
└─────────────────────────────┼───────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────┐
│                    Lattice Server                           │
│                             │                               │
│  ┌──────────────────────────▼──────────────────────────┐    │
│  │               Hono HTTP Server                       │    │
│  │                                                      │    │
│  │  /mcp ─────── MCP Server (35 tools)                  │    │
│  │  /api/v1 ──── REST API (17 route groups)             │    │
│  │  /admin ───── Admin API (team/key mgmt)              │    │
│  │  / ─────────── Real-time dashboard (HTML)             │    │
│  │  /health ──── Health check                           │    │
│  └──────────────────────────┬──────────────────────────┘    │
│                             │                               │
│  ┌──────────────────────────▼──────────────────────────┐    │
│  │               Model Layer                            │    │
│  │  context · event · task · agent · message            │    │
│  │  artifact · playbook · workflow · profile            │    │
│  │  analytics · webhook                                 │    │
│  └──────────────────────────┬──────────────────────────┘    │
│                             │                               │
│  ┌──────────────────────────▼──────────────────────────┐    │
│  │           SQLite (WAL mode, better-sqlite3)          │    │
│  │  16 tables + FTS5 trigram index                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Background Services:                                       │
│  ┌────────────┐ ┌──────────────┐ ┌──────────────────┐      │
│  │ Task Reaper │ │ Event Cleanup │ │ Webhook Dispatcher│     │
│  └────────────┘ └──────────────┘ └──────────────────┘      │
│  ┌──────────────┐                                           │
│  │ Event Emitter │ (in-memory pub/sub for SSE/long-poll)    │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js (single process) |
| Language | TypeScript |
| HTTP | Hono |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Validation | Zod |
| Testing | Vitest (391 tests across 34 files) |

---

## 2. MCP Tools (35 total)

All tools are exposed at `POST /mcp` via Streamable HTTP transport. Auth via `Authorization: Bearer <api_key>` header. Optional `X-Agent-ID` header sets agent identity; optional `X-Team-Override` header lets a single MCP session switch teams mid-session.

### Context (2)

| Tool | Params | Description |
|------|--------|-------------|
| `save_context` | `agent_id`, `key`, `value`, `tags` | Persist key-value entry. Secret-scanned. Auto-broadcasts LEARNING event. |
| `get_context` | `query`, `tags?`, `limit?` | FTS5 trigram search with optional tag filter (OR matching). |

### Events (3)

| Tool | Params | Description |
|------|--------|-------------|
| `broadcast` | `agent_id`, `event_type`, `message`, `tags` | Push event. Types: LEARNING, BROADCAST, ESCALATION, ERROR, TASK_UPDATE. |
| `get_updates` | `since_id?`, `since_timestamp?`, `topics?`, `limit?`, `include_context?` | Cursor poll; can push-mode attach `recommended_context`. |
| `wait_for_event` | `since_id`, `topics?`, `event_type?`, `timeout_sec?` | Long-poll up to 60s for matching events. Returns immediately if any already exist. |

### Tasks (5)

| Tool | Params | Description |
|------|--------|-------------|
| `create_task` | `agent_id`, `description`, `status?`, `depends_on?`, `priority?`, `assigned_to?` | Create work item. Default auto-claimed by creator. Supports DAG + priority. |
| `update_task` | `agent_id`, `task_id`, `status`, `result?`, `version`, `priority?`, `assigned_to?` | Update with optimistic locking. Enforces state machine. |
| `list_tasks` | `status?`, `claimed_by?`, `assigned_to?`, `limit?` | List with priority-sorted results. |
| `get_task` | `task_id` | Get single task by ID. |
| `get_task_graph` | `status?` (CSV), `workflow_run_id?`, `limit?` | Tasks + dependencies as DAG nodes/edges for visualization. |

### Agents (3)

| Tool | Params | Description |
|------|--------|-------------|
| `register_agent` | `agent_id`, `capabilities`, `status?`, `metadata?` | Register/update agent in team directory. |
| `list_agents` | `capability?`, `status?` | Discover agents by capability or status. |
| `heartbeat` | `agent_id`, `status?` | Keep agent online. Updates `last_heartbeat`. |

### Messaging (2)

| Tool | Params | Description |
|------|--------|-------------|
| `send_message` | `agent_id`, `to`, `message`, `tags` | Send direct message. Secret-scanned. |
| `get_messages` | `agent_id`, `since_id?`, `limit?` | Fetch messages sent to you. Cursor pagination. |

### Artifacts (3)

| Tool | Params | Description |
|------|--------|-------------|
| `save_artifact` | `agent_id`, `key`, `content_type`, `content`, `metadata?` | Save typed file (HTML/JSON/MD/code). Max 1 MB. Upsert on `key`. |
| `get_artifact` | `key` | Retrieve artifact by key with full content. |
| `list_artifacts` | `content_type?`, `limit?` | List metadata only (no content). |

### Playbooks (3)

| Tool | Params | Description |
|------|--------|-------------|
| `define_playbook` | `agent_id`, `name`, `description`, `tasks[]` | Define a bundle of task templates with `depends_on_index` wiring. |
| `list_playbooks` | — | List playbooks for your team. |
| `run_playbook` | `agent_id`, `name`, `vars?` | Instantiate playbook into real tasks, wire dependencies, create workflow_run. `vars` are substituted into `{{vars.KEY}}` placeholders in task descriptions. |

### Schedules (3)

| Tool | Params | Description |
|------|--------|-------------|
| `define_schedule` | `agent_id`, `name`, `playbook_name`, `cron_expression`, `vars?` | Schedule a playbook on a cron-like expression. Supported forms: `*/N * * * *`, `0 */N * * *`, `0 N * * *`, `0 H * * D`. |
| `list_schedules` | — | List schedules with `last_run_at` / `next_run_at`. |
| `delete_schedule` | `agent_id`, `id` | Delete a schedule. |

### Workflow Runs (2)

| Tool | Params | Description |
|------|--------|-------------|
| `list_workflow_runs` | `status?` (running/completed/failed), `limit?` | List playbook executions. |
| `get_workflow_run` | `id` | Get a single run with current status of each created task. |

### Profiles (4)

| Tool | Params | Description |
|------|--------|-------------|
| `define_profile` | `agent_id`, `name`, `description`, `system_prompt`, `default_capabilities?`, `default_tags?` | Define a reusable role. |
| `list_profiles` | — | List profiles defined for your team. |
| `get_profile` | `name` | Get profile including full system prompt. |
| `delete_profile` | `agent_id`, `name` | Delete a profile. |

### Analytics (1)

| Tool | Params | Description |
|------|--------|-------------|
| `get_analytics` | `since?` (e.g. "24h", "7d", "30d") | Aggregated team analytics (tasks, events, agents, context, messages). |

### Inbound Endpoints (3)

| Tool | Params | Description |
|------|--------|-------------|
| `define_inbound_endpoint` | `agent_id`, `name`, `action_type` (create_task/broadcast_event/save_context/run_playbook), `action_config?`, `hmac_secret?` | Create a public receiver URL. `run_playbook` config supports `vars_from_payload` to pull playbook `vars` straight from the POST payload. |
| `list_inbound_endpoints` | — | List inbound endpoints. |
| `delete_inbound_endpoint` | `agent_id`, `endpoint_id` | Delete an inbound endpoint. |

### Data Export (1)

| Tool | Params | Description |
|------|--------|-------------|
| `export_team_data` | — | Full team snapshot (13 sections). Secrets redacted, artifacts metadata-only, events capped at 1000. |

### Auto-Registration

MCP tool handlers that accept `agent_id` call `autoRegisterAgent()` — a silent upsert that ensures the agent exists in the registry. No explicit `register_agent` call required for basic presence.

---

## 3. REST API

Base URL: `http://localhost:{PORT}`

### Authentication

All `/api/v1/*` routes require `Authorization: Bearer <api_key>`. Optional `X-Agent-ID` header (defaults to "anonymous"). Optional `X-Team-Override: <api_key>` lets one session switch teams per-call without restart.

Admin routes at `/admin/*` require `Authorization: Bearer <ADMIN_KEY>`.

The root path `/` serves the real-time HTML dashboard (no auth; the API key lives in client localStorage and is sent with XHR/SSE calls).

### Endpoints

#### Context (`/api/v1/context`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/context` | Save context entry (key, value, tags). Secret-scanned. |
| GET | `/api/v1/context` | Search via FTS5. Query params: `query`, `tags`, `limit`. |

#### Events (`/api/v1/events`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/events` | Broadcast event (event_type, message, tags). Secret-scanned. |
| GET | `/api/v1/events` | Poll events. Query params: `since_id`, `since_timestamp`, `topics`, `limit`, `include_context`. |
| GET | `/api/v1/events/wait` | Long-poll for new events (timeout up to 60s). Query: `since_id`, `topics`, `event_type`, `timeout_sec`. |
| GET | `/api/v1/events/stream` | Server-Sent Events stream of new events. |

#### Tasks (`/api/v1/tasks`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/tasks` | Create task (description, status, depends_on, priority, assigned_to). |
| GET | `/api/v1/tasks` | List tasks. Query params: `status`, `claimed_by`, `assigned_to`, `limit`. |
| GET | `/api/v1/tasks/:id` | Get single task. |
| PATCH | `/api/v1/tasks/:id` | Update task status (status, result, version, priority, assigned_to). Optimistic locking. |

#### Agents (`/api/v1/agents`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/agents` | Register/update agent (agent_id, capabilities, status, metadata). |
| GET | `/api/v1/agents` | List agents. Query params: `capability`, `status`. |
| POST | `/api/v1/agents/:id/heartbeat` | Send heartbeat. Optional body: `status`. |

#### Messages (`/api/v1/messages`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/messages` | Send direct message (to, message, tags). Secret-scanned. |
| GET | `/api/v1/messages` | Get messages for authenticated agent. Query params: `since_id`, `limit`. |

#### Analytics (`/api/v1/analytics`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/analytics` | Aggregated metrics. Query: `since` (e.g. "24h", "7d", "30d"). |

#### Artifacts (`/api/v1/artifacts`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/artifacts` | Save artifact (key, content_type, content, metadata). Max 1 MB. Upsert on key. |
| GET | `/api/v1/artifacts` | List artifacts metadata (no content). Query: `content_type`, `limit`. |
| GET | `/api/v1/artifacts/:key` | Get full artifact by key. |
| DELETE | `/api/v1/artifacts/:key` | Delete artifact. |

#### Playbooks (`/api/v1/playbooks`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/playbooks` | Define playbook (name, description, tasks[]). Upsert on name. |
| GET | `/api/v1/playbooks` | List playbooks for team. |
| GET | `/api/v1/playbooks/:name` | Get playbook with task templates. |
| POST | `/api/v1/playbooks/:name/run` | Run playbook → create tasks + workflow_run. Body: `{vars: {...}}` for `{{vars.KEY}}` substitution. |

#### Schedules (`/api/v1/schedules`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/schedules` | Create schedule (name, playbook_name, cron_expression, vars?). |
| GET | `/api/v1/schedules` | List schedules. |
| DELETE | `/api/v1/schedules/:id` | Delete schedule. |

#### Export (`/api/v1/export`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/export` | Full team data snapshot (13 sections). Secrets redacted, artifacts metadata-only, events capped at 1000. |

#### Workflow Runs (`/api/v1/workflow-runs`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/workflow-runs` | List runs. Query: `status` (running/completed/failed), `limit`. |
| GET | `/api/v1/workflow-runs/:id` | Get run with status of each created task. |

#### Profiles (`/api/v1/profiles`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/profiles` | Define profile (name, description, system_prompt, default_capabilities, default_tags). |
| GET | `/api/v1/profiles` | List profiles. |
| GET | `/api/v1/profiles/:name` | Get profile with full system prompt. |
| DELETE | `/api/v1/profiles/:name` | Delete profile. |

#### Webhooks (`/api/v1/webhooks`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/webhooks` | Create webhook (url, secret, event_types). HMAC-SHA256 signed outbound. |
| GET | `/api/v1/webhooks` | List webhooks for team. |
| GET | `/api/v1/webhooks/:id` | Get single webhook. |
| DELETE | `/api/v1/webhooks/:id` | Delete webhook. |
| GET | `/api/v1/webhooks/:id/deliveries` | Delivery history (status, attempts, response_code). |

#### Teams (`/api/v1/teams`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/teams/mine` | Info on authenticated team (+ override team if `X-Team-Override` was set). |

#### Inbound Endpoints (`/api/v1/inbound`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/inbound` | Create inbound endpoint (auth required). |
| GET | `/api/v1/inbound` | List endpoints. |
| GET | `/api/v1/inbound/:id` | Get endpoint. |
| DELETE | `/api/v1/inbound/:id` | Delete endpoint. |
| POST | `/api/v1/inbound/:endpoint_key` | **Public receiver** — no auth; HMAC verified if `hmac_secret` set. Triggers the configured action. |

#### Admin (`/admin`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/teams` | Create team. Returns raw API key (shown once). |
| GET | `/admin/teams` | List all teams. |
| POST | `/admin/teams/:id/keys` | Generate new API key for team. |
| DELETE | `/admin/teams/:id/keys` | Revoke all keys for team. |
| GET | `/admin/stats` | System stats: teams, agents, entries, events, tasks by status. |

#### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | No auth. Returns 200 if server is running. |

---

## 4. Data Model

SQLite in WAL mode. All timestamps are ISO 8601 strings.

### Tables

#### `teams`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Slug (e.g. "research-team") |
| `name` | TEXT | Human-readable name |
| `created_at` | TEXT | ISO 8601 |

#### `api_keys`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT FK | References teams(id) |
| `key_hash` | TEXT UNIQUE | SHA-256 of raw key |
| `label` | TEXT | Human label (e.g. "cli-init") |
| `created_at` | TEXT | ISO 8601 |

#### `context_entries`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `key` | TEXT | UNIQUE(team_id, key). Upsert semantics. |
| `value` | TEXT | Up to 100k chars |
| `tags` | TEXT | JSON array of strings |
| `created_by` | TEXT | Agent ID |
| `created_at` | TEXT | ISO 8601 |

FTS5 virtual table `context_entries_fts` with auto-sync triggers on insert/delete/update. Uses the **trigram tokenizer** so 3-char fragments and middle-of-word queries match.

#### `events`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment (used as cursor) |
| `team_id` | TEXT | Team scope |
| `event_type` | TEXT | CHECK: LEARNING, BROADCAST, ESCALATION, ERROR, TASK_UPDATE |
| `message` | TEXT | Up to 10k chars |
| `tags` | TEXT | JSON array |
| `created_by` | TEXT | Agent ID or "system:reaper" |
| `created_at` | TEXT | ISO 8601 |

#### `tasks`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `description` | TEXT | Up to 10k chars |
| `status` | TEXT | CHECK: open, claimed, completed, escalated, abandoned |
| `result` | TEXT | Completion result or escalation reason |
| `created_by` | TEXT | Creator agent |
| `claimed_by` | TEXT | Claiming agent (NULL if unclaimed) |
| `claimed_at` | TEXT | ISO 8601 (NULL if unclaimed) |
| `version` | INTEGER | Optimistic lock counter (default 1) |
| `priority` | TEXT | CHECK: P0, P1, P2, P3 (default P2) |
| `assigned_to` | TEXT | Agent the task is assigned to (nullable) |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601 |

#### `task_dependencies`
| Column | Type | Notes |
|--------|------|-------|
| `task_id` | INTEGER FK | References tasks(id) |
| `depends_on` | INTEGER FK | References tasks(id) |

PK: (`task_id`, `depends_on`). Blocks claim until all dependencies are completed.

#### `agents`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT | Agent identifier |
| `team_id` | TEXT | Team scope |
| `capabilities` | TEXT | JSON array of strings |
| `status` | TEXT | CHECK: online, offline, busy |
| `metadata` | TEXT | JSON object |
| `last_heartbeat` | TEXT | ISO 8601 |
| `registered_at` | TEXT | ISO 8601 |

PK: (`team_id`, `id`). Indexed on (`team_id`, `last_heartbeat`) for stale detection.

#### `messages`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `from_agent` | TEXT | Sender agent ID |
| `to_agent` | TEXT | Recipient agent ID |
| `message` | TEXT | Up to 10k chars |
| `tags` | TEXT | JSON array |
| `created_at` | TEXT | ISO 8601 |

Indexed on (`team_id`, `to_agent`, `id`) for recipient queries.

#### `artifacts`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `key` | TEXT | UNIQUE(team_id, key). Upsert semantics. |
| `content_type` | TEXT | MIME type (text/plain, text/markdown, text/html, application/json, text/x-typescript, etc.) |
| `content` | TEXT | Up to 1 MB |
| `metadata` | TEXT | JSON object |
| `size` | INTEGER | Byte count |
| `created_by` | TEXT | Agent ID |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601 |

Indexed on (`team_id`, `content_type`).

#### `playbooks`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `name` | TEXT | UNIQUE(team_id, name) |
| `description` | TEXT | Up to 10k chars |
| `tasks_json` | TEXT | JSON array of `{description, role?, depends_on_index?[]}` |
| `created_by` | TEXT | Agent ID |
| `created_at` | TEXT | ISO 8601 |

#### `agent_profiles`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `name` | TEXT | UNIQUE(team_id, name) |
| `description` | TEXT | Role description |
| `system_prompt` | TEXT | Up to 100k chars |
| `default_capabilities` | TEXT | JSON array |
| `default_tags` | TEXT | JSON array |
| `created_by` | TEXT | Agent ID |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601 |

#### `workflow_runs`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `playbook_name` | TEXT | Name of the playbook run |
| `started_by` | TEXT | Agent that invoked `run_playbook` |
| `task_ids` | TEXT | JSON array of task IDs created |
| `status` | TEXT | CHECK: running, completed, failed |
| `started_at` | TEXT | ISO 8601 |
| `completed_at` | TEXT | ISO 8601 (NULL while running) |

Indexed on (`team_id`, `started_at`).

#### `webhooks`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `team_id` | TEXT | Team scope |
| `url` | TEXT | Target URL |
| `secret` | TEXT | HMAC-SHA256 signing secret |
| `event_types` | TEXT | JSON array (e.g. `["*"]` or `["LEARNING","ERROR"]`) |
| `active` | INTEGER | 0/1. Auto-disabled after 20 consecutive failures. |
| `failure_count` | INTEGER | Rolling count |
| `created_by` | TEXT | Agent ID |
| `created_at` / `updated_at` | TEXT | ISO 8601 |

Indexed on (`team_id`, `active`).

#### `webhook_deliveries`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `webhook_id` | TEXT FK | CASCADE delete with webhook |
| `event_id` | INTEGER | The event being delivered |
| `status` | TEXT | CHECK: pending, success, failed, dead |
| `response_code` | INTEGER | HTTP status code from target |
| `attempts` | INTEGER | Retry counter |
| `next_retry_at` | TEXT | Exponential backoff (NULL when terminal) |
| `error` | TEXT | Last error message |
| `created_at` / `updated_at` | TEXT | ISO 8601 |

Indexed on (`webhook_id`, `created_at` DESC) and (`status`, `next_retry_at`).

#### `inbound_endpoints`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `endpoint_key` | TEXT UNIQUE | URL path segment (globally unique) |
| `name` | TEXT | Human-readable name |
| `action_type` | TEXT | CHECK: create_task, broadcast_event, save_context |
| `action_config` | TEXT | JSON: per-action settings (templates, tags, etc.) |
| `hmac_secret` | TEXT | Nullable. If set, requests require `X-Lattice-Signature: sha256=<hex>`. |
| `active` | INTEGER | 0/1 |
| `created_by` | TEXT | Agent ID |
| `created_at` / `updated_at` | TEXT | ISO 8601 |

Indexed on (`team_id`).

#### `schedules`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `team_id` | TEXT | Team scope |
| `name` | TEXT | UNIQUE(team_id, name) |
| `playbook_name` | TEXT | Target playbook |
| `cron_expression` | TEXT | e.g. `*/5 * * * *`, `0 9 * * 1` |
| `vars_json` | TEXT | JSON object substituted into `{{vars.KEY}}` at fire time |
| `next_run_at` | TEXT | ISO 8601 — precomputed next fire |
| `last_run_at` | TEXT | ISO 8601 (NULL until first fire) |
| `active` | INTEGER | 0/1 |
| `created_by` | TEXT | Agent ID |
| `created_at` / `updated_at` | TEXT | ISO 8601 |

### Table summary (16 total)

`teams`, `api_keys`, `context_entries` (+ `context_entries_fts`), `events`, `tasks`, `task_dependencies`, `agents`, `messages`, `artifacts`, `playbooks`, `agent_profiles`, `workflow_runs`, `webhooks`, `webhook_deliveries`, `schedules`, `inbound_endpoints`.

---

## 5. Background Services

### Task Reaper

Runs every `TASK_REAP_INTERVAL_MS` (default 60s). Finds tasks with `status=claimed` where `claimed_at` exceeds `TASK_REAP_TIMEOUT_MINUTES` (default 30min). Marks them as `abandoned`, clears `claimed_by`/`claimed_at`, increments version, broadcasts TASK_UPDATE as `system:reaper`.

### Event Cleanup

Runs hourly. Deletes events older than `EVENT_RETENTION_DAYS` (default 30, 0 = keep forever). Also triggers agent heartbeat timeout check.

### Agent Heartbeat Timeout

Runs with event cleanup (hourly). Marks agents as `offline` if no heartbeat within `AGENT_HEARTBEAT_TIMEOUT_MINUTES` (default 10min). Called via `markStaleAgents()`.

### Auto-Registration

Not a service per se — a synchronous check in MCP tool handlers. When an agent calls any tool with `agent_id`, `autoRegisterAgent()` does a silent upsert into the agents table with empty capabilities. Ensures agents appear in `list_agents` without explicit `register_agent` calls.

### Webhook Dispatcher

Runs continuously. Finds `webhook_deliveries` with `status=pending` or `status=failed` where `next_retry_at` is due. POSTs the event JSON to the webhook URL with an HMAC-SHA256 signature header derived from the webhook's secret. 10s timeout. On failure, schedules exponential backoff retry. After 20 consecutive failures the parent webhook is auto-disabled and the delivery marked `dead`.

### Scheduler

`services/scheduler.ts` runs every 30 seconds. Finds active schedules whose `next_run_at` is due, fires `run_playbook` with the schedule's stored `vars`, then recomputes `next_run_at` from the cron expression. Emits LEARNING events tagged `schedule_fired` (or `error` on cron failure). Supported cron forms: `*/N * * * *`, `0 */N * * *`, `0 N * * *`, `0 H * * D`.

### Event Emitter (in-memory pub/sub)

`services/event-emitter.ts` is a Node `EventEmitter` that fires on every `broadcastEvent` / `broadcastInternal`. Two consumers subscribe: the SSE stream route (`/api/v1/events/stream`) and the `wait_for_event` long-poll implementation. Enables low-latency push to clients without DB polling.

---

## 5a. Dashboard v2

Served at `/` as inline HTML from `src/dashboard.ts`. Four tabs:

| Tab | Content |
|-----|---------|
| **Overview** | Live team stats, recent events, active agents, task counts |
| **Task Graph** | DAG visualization (`/api/v1/tasks/graph`) showing nodes + dependency edges |
| **Artifact Browser** | List + inspect artifacts (metadata, content preview) |
| **Playbook Runner** | Define, list, and one-click-run playbooks with `vars` input |

Auth: no server-side session — the dashboard reads an API key from `localStorage` and attaches it to XHR + SSE calls.

## 5b. Docker Deployment

Ships with:

- `Dockerfile` — multi-stage `node:20-alpine` (builder stage installs devDeps + tsc; runtime stage copies `dist/` + prod node_modules)
- `docker-compose.yml` — runs Lattice with a healthcheck on `/health` and a named volume for the SQLite file

One-command deploy:

```bash
docker compose up -d --build
```

See [examples/docker-deploy.md](../agenthub/examples/docker-deploy.md) for env-var overrides, reverse-proxy setup, and backup guidance.

## 6. CLI

```
npx lattice <command>
```

| Command | Description |
|---------|-------------|
| `init` | Interactive setup: team name, team ID, DB path, port. Creates SQLite DB, inserts team + API key, outputs `.mcp.json` snippet. |
| `start` | Boots the Lattice server (imports `src/index.ts`). |
| `status` | Shows server health (GET /health), admin stats (GET /admin/stats if ADMIN_KEY set), and last 5 events (GET /api/v1/events if LATTICE_API_KEY set). Color-coded terminal output. |

### CLI Environment Variables

| Variable | Description |
|----------|-------------|
| `LATTICE_URL` | Server URL (default: `http://localhost:3000`) |
| `ADMIN_KEY` | Admin key for stats display |
| `LATTICE_API_KEY` | Team API key for event display |

---

## 7. Authentication

### API Key Scheme

- Key format: `ah_` + 48 hex characters (24 random bytes)
- Stored as SHA-256 hash in `api_keys` table (plaintext never stored)
- Header: `Authorization: Bearer {api_key}`
- Agent identity: `X-Agent-ID` header (optional, defaults to "anonymous")
- Team scope: All queries filter by `team_id` derived from the key. Zero cross-team access.

### RBAC — Scoped API Keys

Each API key carries a `scope` column: `read`, `write`, or `admin`. Enforcement is method-based in `http/middleware/auth.ts`:

| Scope | Permitted methods |
|-------|-------------------|
| `read` | `GET`, `HEAD` only |
| `write` | all except destructive admin ops |
| `admin` | all methods |

On mismatch the middleware returns HTTP 403 with `{"error": "INSUFFICIENT_SCOPE"}`. The resolved scope is attached to the auth context so route handlers and MCP tools can make finer-grained decisions if needed.

### Admin Key

- Raw string comparison against `ADMIN_KEY` env var
- Returns 503 if `ADMIN_KEY` not configured
- Protects `/admin/*` routes (team creation, key management, stats)

### MCP Auth

- Same Bearer token extracted from HTTP request headers
- Auth context stored in `AsyncLocalStorage` and retrieved via `getMcpAuth()` in tool handlers
- MCP tools also accept `agent_id` param; falls back to `X-Agent-ID` header value

---

## 8. Dog-Food Results

Four rounds of live dog-food testing using Lattice to coordinate real agent teams.

### Round 1 — Market Research (3 agents)

- 3 agents (industry-researcher, biz-strategist, tech-analyst) coordinated via event bus + shared context
- Produced 15 landscape profiles, monetization analysis, 5-domain technical architecture review
- **Issues found**: agents didn't register (invisible in list_agents), duplicate task creation, agents stopped polling after startup

### Round 2 — DX Sprint (5 agents)

- Built `list_tasks`, `get_task`, `send_message`, `get_messages` MCP tools
- Added auto-registration feature
- Added agent preamble templates
- 154 tests passing after this round

### Round 3 — QA Verification

- 14/15 sub-tests PASS, 1 PARTIAL FAIL
- **Verified**: list_tasks filters, get_task, send_message + get_messages, cross-agent context sharing
- **DX issues found**: FTS5 short query gap (3-char queries return empty), Round 1 agents missing from registry (auto-reg not retroactive), message ID gaps

### Round 4 — Landing Page Sprint

- Content researcher, designer, reviewer agents coordinated end-to-end
- Direct messaging pipeline proven (content handoff via `send_message`)
- QA reviewer caught 3 issues, all fixed in-session

### Key Metrics

| Metric | Value |
|--------|-------|
| Events generated | 154+ |
| Context entries | 53+ |
| Tasks | 40+ (12+ completed) |
| Agents coordinated | 9+ |
| Tests passing | 391 across 34 files |
| MCP tools | 35 |
| Database tables | 16 |

---

## 9. Configuration

All via environment variables, loaded in `src/config.ts`.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `DB_PATH` | `./data/lattice.db` | SQLite database file path |
| `POLL_INTERVAL_MS` | `5000` | Suggested client poll interval |
| `TASK_REAP_TIMEOUT_MINUTES` | `30` | Minutes before claimed task is auto-abandoned |
| `TASK_REAP_INTERVAL_MS` | `60000` | Task reaper check interval |
| `EVENT_RETENTION_DAYS` | `30` | Event retention (0 = keep forever) |
| `AGENT_HEARTBEAT_TIMEOUT_MINUTES` | `10` | Minutes before agent marked offline |
| `ADMIN_KEY` | `""` | Admin API auth key (empty = admin routes disabled) |
| `LOG_LEVEL` | `info` | Log verbosity: debug, info, warn, error |

---

## 10. Project Structure

```
agenthub/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Entry point — starts HTTP server + background services
│   ├── config.ts                 # Environment variable loading
│   ├── errors.ts                 # AppError, SecretDetectedError, TaskConflictError, etc.
│   ├── cli.ts                    # CLI: init, start, status commands
│   ├── db/
│   │   ├── schema.ts             # CREATE TABLE + FTS5 + triggers + indexes
│   │   └── connection.ts         # SQLite connection (WAL mode)
│   ├── dashboard.ts              # Inline HTML dashboard served at /
│   ├── models/
│   │   ├── types.ts              # All TypeScript interfaces
│   │   ├── context.ts            # saveContext, getContext
│   │   ├── event.ts              # broadcastEvent, getUpdates, waitForEvent, broadcastInternal
│   │   ├── task.ts               # createTask, updateTask, listTasks, getTask
│   │   ├── agent.ts              # registerAgent, autoRegisterAgent, heartbeat, listAgents, markStaleAgents
│   │   ├── message.ts            # sendMessage, getMessages
│   │   ├── artifact.ts           # saveArtifact, getArtifact, listArtifacts
│   │   ├── playbook.ts           # definePlaybook, listPlaybooks, runPlaybook
│   │   ├── workflow.ts           # listWorkflowRuns, getWorkflowRun
│   │   ├── profile.ts            # defineProfile, listProfiles, getProfile, deleteProfile
│   │   ├── analytics.ts          # getTeamAnalytics, parseSinceDuration
│   │   ├── webhook.ts            # webhook CRUD + delivery record management
│   │   ├── task-graph.ts         # DAG extraction for visualization
│   │   ├── schedule.ts           # schedule CRUD + cron nextRun computation
│   │   ├── export.ts             # full team data export builder
│   │   └── inbound.ts            # inbound endpoint CRUD + action dispatch
│   ├── mcp/
│   │   ├── server.ts             # MCP server with 35 tool registrations
│   │   └── auth-context.ts       # AsyncLocalStorage for MCP auth
│   ├── http/
│   │   ├── app.ts                # Hono app, route mounting, MCP transport, error handler
│   │   ├── middleware/
│   │   │   └── auth.ts           # Bearer auth + X-Team-Override resolution
│   │   └── routes/
│   │       ├── context.ts        # POST/GET /api/v1/context
│   │       ├── events.ts         # POST/GET /api/v1/events + /events/wait
│   │       ├── sse.ts            # GET /api/v1/events/stream (SSE)
│   │       ├── tasks.ts          # POST/GET/PATCH /api/v1/tasks
│   │       ├── agents.ts         # POST/GET /api/v1/agents, POST heartbeat
│   │       ├── messages.ts       # POST/GET /api/v1/messages
│   │       ├── analytics.ts      # GET /api/v1/analytics
│   │       ├── artifacts.ts      # POST/GET/DELETE /api/v1/artifacts
│   │       ├── playbooks.ts      # POST/GET /api/v1/playbooks + /run
│   │       ├── workflow-runs.ts  # GET /api/v1/workflow-runs
│   │       ├── schedules.ts      # POST/GET/DELETE /api/v1/schedules
│   │       ├── export.ts         # GET /api/v1/export
│   │       ├── profiles.ts       # POST/GET/DELETE /api/v1/profiles
│   │       ├── webhooks.ts       # POST/GET/DELETE /api/v1/webhooks + /deliveries
│   │       ├── inbound.ts        # inbound mgmt + public receiver
│   │       ├── teams.ts          # GET /api/v1/teams/mine
│   │       └── admin.ts          # /admin/teams, /admin/stats
│   └── services/
│       ├── secret-scanner.ts     # 20+ regex patterns for secret detection
│       ├── task-reaper.ts        # Background abandoned task reaper
│       ├── event-cleanup.ts      # Event retention + agent heartbeat timeout
│       ├── event-emitter.ts      # In-memory pub/sub for SSE + wait_for_event
│       ├── scheduler.ts          # Cron-based playbook scheduler (30s tick)
│       └── webhook-dispatcher.ts # Outbound webhook delivery with backoff
└── tests/                        # 391 tests across 34 files (Vitest)
```

### Startup Sequence

1. Load config from environment
2. Initialize SQLite database (WAL mode, apply schema)
3. Create Hono app with MCP server factory
4. Start task reaper (interval-based)
5. Start event cleanup (hourly, also marks stale agents)
6. Start scheduler (30s tick, fires due playbooks)
7. Bind HTTP server to configured port

---

## 11. Error Codes

| Code | HTTP | When |
|------|------|------|
| `SECRET_DETECTED` | 422 | Content contains potential API key/token/credential |
| `TASK_CONFLICT` | 409 | Optimistic lock failure (version mismatch) |
| `INVALID_TRANSITION` | 400 | Invalid task status transition |
| `NOT_FOUND` | 404 | Task/resource not found |
| `UNAUTHORIZED` | 401 | Missing/invalid API key |
| `FORBIDDEN` | 403 | Agent not authorized for this task operation |
| `INSUFFICIENT_SCOPE` | 403 | API key scope (`read`/`write`/`admin`) does not permit this HTTP method |
| `VALIDATION_ERROR` | 400 | Invalid input (Zod validation failure) |
| `DEPENDENCY_BLOCKED` | 400 | Task dependencies not yet completed |

### Task State Machine

```
open ──→ claimed ──→ completed
                 ──→ escalated
                 ──→ abandoned ──→ claimed (re-claim)
```

Only the claiming agent (or `system:reaper`) can transition from `claimed`.
