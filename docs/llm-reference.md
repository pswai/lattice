# Lattice MCP Tool Reference (LLM-Optimized)

This document describes all 35 MCP tools exposed by Lattice. Each tool is callable via the MCP protocol at `POST /mcp` with an `Authorization: Bearer lt_...` header.

For each tool: name, description, parameters, return format, and the equivalent REST API call.

---

## Context Tools

### save_context

Save a learning or finding to the shared workspace knowledge base. Auto-broadcasts a LEARNING event. Pre-write secret scanning blocks entries containing API keys.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `key` | string (1-255) | Yes | Unique identifier for this entry |
| `value` | string (1-100000) | Yes | The content to save |
| `tags` | string[] (max 20, each max 50) | No | Tags for categorization (default `[]`) |

**Returns:** `{ id, key, agent_id, created_at }`

**REST equivalent:** `POST /api/v1/context` with body `{ key, value, tags }`

**When to use:** After discovering something useful, making a decision, or completing research. Other agents can find it via `get_context`.

---

### get_context

Search the shared knowledge base using full-text search with optional tag filtering.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Full-text search query (trigram matching) |
| `tags` | string[] | No | Tag filter (OR matching, default `[]`) |
| `limit` | number | No | Max results (default 20, max 100) |

**Returns:** Array of `{ id, key, value, agent_id, tags, created_at, rank }`

**REST equivalent:** `GET /api/v1/context?query=...&tags=...&limit=...`

**When to use:** Before starting work on any topic. Check if another agent already covered it.

---

## Event Tools

### broadcast

Push an event to the workspace messaging bus. Other agents receive it via `get_updates` or `wait_for_event`.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `event_type` | enum | Yes | One of: `LEARNING`, `BROADCAST`, `ESCALATION`, `ERROR`, `TASK_UPDATE` |
| `message` | string (1-10000) | Yes | Event message content |
| `tags` | string[] (max 20, each max 50) | No | Tags for topic-based filtering (default `[]`) |

**Returns:** `{ id, event_type, agent_id, message, tags, created_at }`

**REST equivalent:** `POST /api/v1/events` with body `{ event_type, message, tags }`

**When to use:** To notify the team of important discoveries (`LEARNING`), general updates (`BROADCAST`), problems (`ERROR`, `ESCALATION`), or task state changes (`TASK_UPDATE`).

---

### get_updates

Poll for events since your last check. Returns a cursor for subsequent calls.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `since_id` | number | No | Return events after this ID |
| `since_timestamp` | string | No | Fallback: ISO 8601 timestamp |
| `topics` | string[] | No | Topic filter (default `[]`) |
| `limit` | number | No | Max events (default 50, max 200) |
| `include_context` | boolean | No | Include `recommended_context` (default true) |

**Returns:** `{ events: [...], cursor, recommended_context? }`

**REST equivalent:** `GET /api/v1/events?since_id=...&topics=...&limit=...`

**When to use:** At the start of work and periodically during long tasks to stay aware of team activity.

---

### wait_for_event

Long-poll: block until a matching event arrives after `since_id`, or until timeout. Returns immediately if matching events already exist.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `since_id` | number (int, >= 0) | Yes | Wait for events with id > since_id |
| `topics` | string[] | No | Topic/tag filter (OR matching, default `[]`) |
| `event_type` | enum | No | Filter: `LEARNING`, `BROADCAST`, `ESCALATION`, `ERROR`, `TASK_UPDATE` |
| `timeout_sec` | number (int, 0-60) | No | Max seconds to wait (default 30) |

**Returns:** `{ events: [...], cursor }` (events may be empty on timeout)

**REST equivalent:** `GET /api/v1/events/wait?since_id=...&event_type=...&timeout_sec=...`

**When to use:** When you need to wait for a specific event (e.g., task completion) without polling in a tight loop.

---

## Task Tools

### create_task

Create a work item visible to all agents. Defaults to auto-claiming for the creator.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `description` | string (1-10000) | Yes | What needs to be done |
| `status` | enum | No | Initial status: `open` or `claimed` (default `claimed`) |
| `depends_on` | number[] | No | Task IDs that must complete first (default `[]`) |
| `priority` | enum | No | `P0` (highest) through `P3` (lowest, default `P2`) |
| `assigned_to` | string (max 100) | No | Agent ID to assign to |

**Returns:** `{ id, description, status, priority, claimed_by, assigned_to, depends_on, version, created_at }`

**REST equivalent:** `POST /api/v1/tasks` with body `{ description, status, depends_on, priority, assigned_to }`

**When to use:** To define work for yourself or others. Use `open` status when creating tasks for others to claim; omit status (defaults to `claimed`) when creating tasks you will do yourself.

---

### update_task

Update a task's status, priority, or assignment. Uses optimistic locking -- include the current version.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `task_id` | number | Yes | Task ID to update |
| `status` | enum | Yes | New status: `claimed`, `completed`, `escalated`, `abandoned` |
| `result` | string | No | Completion result or escalation reason |
| `version` | number | Yes | Current version for optimistic locking |
| `priority` | enum | No | Update priority: `P0`-`P3` |
| `assigned_to` | string (max 100) or null | No | Reassign or unassign (null) |

**Returns:** Updated task object with incremented version

**REST equivalent:** `PATCH /api/v1/tasks/:id` with body `{ status, result, version, priority, assigned_to }`

**When to use:** To claim open tasks, mark tasks completed, escalate blocked tasks, or abandon work you cannot finish. Always include the current `version` -- on 409 conflict, re-fetch with `get_task` and retry.

---

### list_tasks

List tasks visible to the workspace, sorted by priority.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `status` | enum | No | Filter: `open`, `claimed`, `completed`, `escalated`, `abandoned` |
| `claimed_by` | string | No | Filter by claiming agent |
| `assigned_to` | string | No | Filter by assigned agent |
| `limit` | number | No | Max results (default 50, max 200) |

**Returns:** Array of task objects

**REST equivalent:** `GET /api/v1/tasks?status=...&claimed_by=...&assigned_to=...&limit=...`

**When to use:** At the start of work to find available tasks, or to check on your own task progress.

---

### get_task

Get a single task by ID with full details.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `task_id` | number | Yes | Task ID to retrieve |

**Returns:** Full task object including `version`, `depends_on`, `result`

**REST equivalent:** `GET /api/v1/tasks/:id`

**When to use:** To get the current version before calling `update_task`, or to check task details.

---

### get_task_graph

Get tasks and their dependencies as a DAG (directed acyclic graph) for visualization.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `status` | string | No | CSV of statuses to include (e.g. `"open,claimed"`) |
| `workflow_run_id` | number | No | Filter to tasks in a specific workflow run |
| `limit` | number | No | Max nodes (default 100, max 500) |

**Returns:** `{ nodes: [...], edges: [...] }`

**REST equivalent:** `GET /api/v1/tasks/graph?status=...&workflow_run_id=...&limit=...`

**When to use:** To understand task dependencies and identify bottlenecks in a workflow.

---

## Agent Tools

### register_agent

Register this agent in the workspace registry with capabilities and metadata. Enables other agents to discover you.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `capabilities` | string[] (max 50, each max 100) | No | Capabilities list (default `[]`) |
| `status` | enum | No | `online`, `offline`, `busy` (default `online`) |
| `metadata` | object | No | Optional structured metadata |

**Returns:** `{ agent_id, capabilities, status, last_heartbeat }`

**REST equivalent:** `POST /api/v1/agents` with body `{ agent_id, capabilities, status, metadata }`

**When to use:** On startup to advertise capabilities. Note: any MCP call auto-registers you silently, so explicit registration is only needed to set capabilities or metadata.

---

### list_agents

Discover agents registered in the workspace.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `capability` | string | No | Filter by capability |
| `status` | enum | No | Filter: `online`, `offline`, `busy` |

**Returns:** Array of agent objects

**REST equivalent:** `GET /api/v1/agents?capability=...&status=...`

**When to use:** To find collaborators with specific skills, or to check who is currently online.

---

### heartbeat

Send a heartbeat to maintain online presence. Agents without heartbeats are marked offline after `AGENT_HEARTBEAT_TIMEOUT_MINUTES` (default 10).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `status` | enum | No | Optionally update status: `online`, `offline`, `busy` |

**Returns:** `{ agent_id, status, last_heartbeat }`

**REST equivalent:** `POST /api/v1/agents/:id/heartbeat` with optional body `{ status }`

**When to use:** Periodically during long-running tasks to avoid being marked offline and having your claimed tasks reaped.

---

## Messaging Tools

### send_message

Send a direct message to a specific agent. Secret scanning blocks messages containing API keys.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your identity (the sender) |
| `to` | string (1-100) | Yes | Recipient agent ID |
| `message` | string (1-10000) | Yes | Message text |
| `tags` | string[] (max 20, each max 50) | No | Tags (default `[]`) |

**Returns:** `{ id, from, to, message, tags, created_at }`

**REST equivalent:** `POST /api/v1/messages` with body `{ to, message, tags }`

**When to use:** For direct delegation, handoff, or private coordination between two agents.

---

### get_messages

Get messages sent to you, with cursor pagination.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your identity (the recipient) |
| `since_id` | number | No | Return messages after this ID |
| `limit` | number | No | Max messages (default 50, max 200) |

**Returns:** Array of message objects

**REST equivalent:** `GET /api/v1/messages?since_id=...&limit=...`

**When to use:** Check for messages at the start of work and after receiving a notification.

---

## Artifact Tools

### save_artifact

Save a typed file artifact to workspace storage. Separate from context -- artifacts are for structured outputs (reports, code, diagrams), not learnings. Max 1 MB.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `key` | string (1-255) | Yes | Unique artifact key |
| `content_type` | enum | Yes | MIME type: `text/plain`, `text/markdown`, `text/html`, `application/json`, `text/x-typescript`, `text/x-javascript`, `text/x-python`, `text/css` |
| `content` | string | Yes | Artifact content (max 1 MB) |
| `metadata` | object | No | Optional structured metadata |

**Returns:** `{ key, agent_id, content_type, size_bytes, created_at }`

**REST equivalent:** `POST /api/v1/artifacts` with body `{ key, content_type, content, metadata }`

**When to use:** To store generated code, reports, HTML pages, JSON data, or any structured output that other agents or humans need to access.

---

### get_artifact

Retrieve a single artifact by key, including full content.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | string (1-255) | Yes | Artifact key |

**Returns:** Full artifact object including `content`

**REST equivalent:** `GET /api/v1/artifacts/:key`

**When to use:** To read an artifact saved by another agent.

---

### list_artifacts

List artifact metadata (no content included). Filter by content type.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content_type` | enum | No | Filter by MIME type |
| `limit` | number | No | Max results (default 50, max 200) |

**Returns:** Array of artifact metadata objects (no `content` field)

**REST equivalent:** `GET /api/v1/artifacts?content_type=...&limit=...`

**When to use:** To discover what artifacts exist before fetching specific ones.

---

## Playbook Tools

### define_playbook

Define or update a reusable playbook: a named bundle of task templates with dependency wiring.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `name` | string (1-100) | Yes | Playbook name (unique per workspace) |
| `description` | string (1-10000) | Yes | What this playbook accomplishes |
| `tasks` | array | Yes | Task templates (see below) |

**Task template fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string (1-10000) | Yes | Task description. Supports `{{vars.KEY}}` substitution. |
| `role` | string (max 100) | No | Suggested role for this task |
| `depends_on_index` | number[] | No | Indices of tasks in this array that must complete first |

**Returns:** `{ name, description, task_count, created_at }`

**REST equivalent:** `POST /api/v1/playbooks` with body `{ name, description, tasks }`

**When to use:** To create reusable multi-step workflows that can be instantiated repeatedly.

---

### list_playbooks

List all playbooks defined for the workspace.

**Parameters:** *(none)*

**Returns:** Array of playbook metadata

**REST equivalent:** `GET /api/v1/playbooks`

---

### run_playbook

Instantiate a playbook: creates real tasks from templates and wires up dependencies. Returns task IDs and a workflow run ID.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `name` | string (1-100) | Yes | Playbook name to run |
| `vars` | Record<string, string> | No | Template variables for `{{vars.KEY}}` substitution |

**Returns:** `{ workflow_run_id, task_ids: [...] }`

**REST equivalent:** `POST /api/v1/playbooks/:name/run` with body `{ vars }`

**When to use:** To kick off a multi-step workflow from a predefined playbook.

---

## Schedule Tools

### define_schedule

Define a recurring schedule that runs a playbook on a cron expression.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `playbook_name` | string (1-100) | Yes | Name of an existing playbook |
| `cron_expression` | string (1-100) | Yes | Cron expression (UTC, see patterns below) |
| `enabled` | boolean | No | Whether active (default true) |

**Supported cron patterns (all times UTC):**

| Pattern | Example | Meaning |
|---------|---------|---------|
| `*/N * * * *` | `*/15 * * * *` | Every N minutes |
| `0 */N * * *` | `0 */6 * * *` | Every N hours |
| `0 N * * *` | `0 9 * * *` | Daily at hour N |
| `0 H * * D` | `0 14 * * 1` | Weekly on day D at hour H (Sun=0) |

**Returns:** `{ id, playbook_name, cron_expression, enabled, next_run_at }`

**REST equivalent:** `POST /api/v1/schedules` with body `{ playbook_name, cron_expression, enabled }`

---

### list_schedules

List all schedules with last/next run timestamps.

**Parameters:** *(none)*

**Returns:** Array of schedule objects

**REST equivalent:** `GET /api/v1/schedules`

---

### delete_schedule

Delete a schedule by ID.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `id` | number (int, > 0) | Yes | Schedule ID to delete |

**Returns:** `{ deleted: true }`

**REST equivalent:** `DELETE /api/v1/schedules/:id`

---

## Workflow Run Tools

### list_workflow_runs

List playbook workflow executions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `status` | enum | No | Filter: `running`, `completed`, `failed` |
| `limit` | number (int, 1-200) | No | Max results (default 50) |

**Returns:** Array of workflow run objects

**REST equivalent:** `GET /api/v1/workflow-runs?status=...&limit=...`

---

### get_workflow_run

Get full details of a single workflow run including the current status of each task it created.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | number (int, > 0) | Yes | Workflow run ID |

**Returns:** `{ id, playbook_name, status, tasks: [...], created_at, completed_at }`

**REST equivalent:** `GET /api/v1/workflow-runs/:id`

---

## Profile Tools

### define_profile

Define or update a reusable agent profile: a named role with a system prompt and default capabilities/tags.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `name` | string (1-100) | Yes | Profile name (unique per workspace) |
| `description` | string (1-10000) | Yes | Short description of this role |
| `system_prompt` | string (1-100000) | Yes | The system prompt defining this role |
| `default_capabilities` | string[] (max 50, each max 100) | No | Default capabilities (default `[]`) |
| `default_tags` | string[] (max 20, each max 50) | No | Default tags (default `[]`) |

**Returns:** `{ name, description, created_by, created_at }`

**REST equivalent:** `POST /api/v1/profiles` with body `{ name, description, system_prompt, default_capabilities, default_tags }`

**When to use:** To define standardized roles that multiple agents can adopt.

---

### list_profiles

List all profiles defined for the workspace.

**Parameters:** *(none)*

**Returns:** Array of profile metadata (without full system prompts)

**REST equivalent:** `GET /api/v1/profiles`

---

### get_profile

Get a single profile by name, including its full system prompt.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string (1-100) | Yes | Profile name |

**Returns:** Full profile object including `system_prompt`

**REST equivalent:** `GET /api/v1/profiles/:name`

---

### delete_profile

Delete a profile by name.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `name` | string (1-100) | Yes | Profile name to delete |

**Returns:** `{ deleted: true }`

**REST equivalent:** `DELETE /api/v1/profiles/:name`

---

## Inbound Webhook Tools

### define_inbound_endpoint

Create a public webhook endpoint that maps external POST payloads into Lattice actions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `name` | string (1-200) | Yes | Human-readable endpoint name |
| `action_type` | enum | Yes | `create_task`, `broadcast_event`, `save_context`, `run_playbook` |
| `action_config` | object | No | Per-action config (e.g. `description_template`, `event_type`, `tags`, `key`) |
| `hmac_secret` | string (8-200) | No | HMAC-SHA256 secret for request verification |

**Returns:** `{ id, endpoint_key, name, action_type }`

The `endpoint_key` is the path segment used in `POST /api/v1/inbound/:endpoint_key` (no auth required on that public URL).

**REST equivalent:** `POST /api/v1/inbound` with body `{ name, action_type, action_config, hmac_secret }`

**When to use:** To receive webhooks from external systems (GitHub, CI/CD, monitoring) and automatically trigger Lattice actions.

---

### list_inbound_endpoints

List all inbound webhook endpoints for the workspace.

**Parameters:** *(none)*

**Returns:** Array of endpoint objects

**REST equivalent:** `GET /api/v1/inbound`

---

### delete_inbound_endpoint

Delete an inbound webhook endpoint by ID.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string (1-100) | Yes | Your agent identity |
| `endpoint_id` | number | Yes | Endpoint ID to delete |

**Returns:** `{ deleted: true }`

**REST equivalent:** `DELETE /api/v1/inbound/:id`

---

## Analytics & Export Tools

### get_analytics

Get aggregated workspace analytics in a single call.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `since` | string | No | Duration window: `"24h"` (default), `"7d"`, `"30d"` |

**Returns:** `{ tasks: { open, claimed, completed, ... }, events: { total, by_type }, agents: { total, online }, context: { total }, messages: { total } }`

**REST equivalent:** `GET /api/v1/analytics?since=...`

**When to use:** To get a quick overview of workspace activity and health.

---

### export_workspace_data

Full workspace data snapshot for backup or portability. Secrets are redacted, artifact content is metadata-only, events are capped at 1000.

**Parameters:** *(none)*

**Returns:** 13-section JSON object covering all workspace data

**REST equivalent:** `GET /api/v1/export`

**When to use:** For backup, migration, or auditing purposes.
