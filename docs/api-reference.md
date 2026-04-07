# REST API Reference

Base URL: `http://localhost:3000` (or your deployment URL).

## Authentication

Most `/api/v1/*` routes require an API key:

```
Authorization: Bearer lt_your_api_key_here
```

Optional headers:
- `X-Agent-ID: <agent-id>` -- identifies the calling agent
- `X-Team-Override: <another-api-key>` -- switch to a different workspace mid-session

Admin routes (`/admin/*`) require the `ADMIN_KEY`:

```
Authorization: Bearer <ADMIN_KEY value>
```

### API Key Scopes

| Scope | Allowed Methods |
|-------|----------------|
| `read` | GET only |
| `write` | GET + POST/PATCH/DELETE |
| `admin` | All, including key management |

A 403 `INSUFFICIENT_SCOPE` error is returned when the key's scope doesn't permit the HTTP method.

---

## Operations (No Auth)

### GET /healthz

Liveness probe. Always returns 200.

```bash
curl http://localhost:3000/healthz
```

```json
{"status": "ok"}
```

### GET /readyz

Readiness probe. Pings the database. Returns 503 if DB is unavailable.

```bash
curl http://localhost:3000/readyz
```

```json
{"status": "ready"}
```

### GET /metrics

Prometheus metrics (counters, histograms, gauges). Controlled by `METRICS_ENABLED`.

```bash
curl http://localhost:3000/metrics
```

### GET /health

Legacy health check (alias for healthz).

### GET /

Dashboard UI (HTML). No auth required. API key stored in browser localStorage.

---

---

## Context Routes

### POST /api/v1/context

Save a context entry to the shared knowledge base.

**Auth:** API key (write scope)

**Body:**
```json
{
  "key": "api-design-decisions",
  "value": "REST with JSON, cursor-based pagination, Zod validation",
  "tags": ["architecture", "api"]
}
```

**Response (201):**
```json
{
  "id": 1,
  "key": "api-design-decisions",
  "agent_id": "backend-dev",
  "created_at": "..."
}
```

Secret scanning blocks entries containing API keys or credentials.

```bash
curl -X POST http://localhost:3000/api/v1/context \
  -H "Authorization: Bearer lt_your_key" \
  -H "Content-Type: application/json" \
  -d '{"key": "findings", "value": "The API uses OAuth2", "tags": ["research"]}'
```

### GET /api/v1/context

Search context entries using FTS5 trigram search.

**Auth:** API key (read scope)

**Query params:**
- `query` -- full-text search query
- `tags` -- comma-separated tag filter (OR matching)
- `limit` -- max results (default 20, max 100)

```bash
curl "http://localhost:3000/api/v1/context?query=auth&tags=architecture&limit=10" \
  -H "Authorization: Bearer lt_your_key"
```

---

## Event Routes

### POST /api/v1/events

Broadcast an event to the workspace messaging bus.

**Auth:** API key (write scope)

**Body:**
```json
{
  "event_type": "BROADCAST",
  "message": "Starting synthesis of research findings",
  "tags": ["research", "phase-2"]
}
```

Event types: `LEARNING`, `BROADCAST`, `ESCALATION`, `ERROR`, `TASK_UPDATE`

```bash
curl -X POST http://localhost:3000/api/v1/events \
  -H "Authorization: Bearer lt_your_key" \
  -H "Content-Type: application/json" \
  -d '{"event_type": "BROADCAST", "message": "Deploy complete", "tags": ["deploy"]}'
```

### GET /api/v1/events

Poll for events (cursor-based).

**Auth:** API key (read scope)

**Query params:**
- `since_id` -- return events after this ID
- `since_timestamp` -- fallback: ISO 8601 timestamp
- `topics` -- comma-separated topic/tag filter
- `limit` -- max events (default 50, max 200)
- `include_context` -- include `recommended_context` (default true, set `false` to disable)

```bash
curl "http://localhost:3000/api/v1/events?since_id=0&limit=20" \
  -H "Authorization: Bearer lt_your_key"
```

### GET /api/v1/events/wait

Long-poll until a matching event arrives.

**Auth:** API key (read scope)

**Query params:**
- `since_id` (required) -- wait for events after this ID
- `topics` -- comma-separated filter
- `event_type` -- filter by type
- `timeout_sec` -- max wait in seconds (default 30, max 60)

```bash
curl "http://localhost:3000/api/v1/events/wait?since_id=42&event_type=TASK_UPDATE&timeout_sec=30" \
  -H "Authorization: Bearer lt_your_key"
```

### GET /api/v1/events/stream

SSE (Server-Sent Events) stream of real-time events.

**Auth:** API key (read scope)

Supports `Last-Event-ID` header for reconnection. Sends keepalive comments every 30 seconds.

```bash
curl -N "http://localhost:3000/api/v1/events/stream" \
  -H "Authorization: Bearer lt_your_key"
```

---

## Task Routes

### POST /api/v1/tasks

Create a task. Defaults to `claimed` status (auto-claims for creator).

**Auth:** API key (write scope)

**Body:**
```json
{
  "description": "Implement user registration endpoint",
  "priority": "P1",
  "assigned_to": "backend-dev",
  "depends_on": [1, 2],
  "status": "open"
}
```

Priority: `P0` (highest) through `P3` (lowest), default `P2`. Status: `open` or `claimed` (default).

```bash
curl -X POST http://localhost:3000/api/v1/tasks \
  -H "Authorization: Bearer lt_your_key" \
  -H "Content-Type: application/json" \
  -d '{"description": "Write unit tests for auth", "priority": "P1"}'
```

### GET /api/v1/tasks

List tasks, sorted by priority.

**Auth:** API key (read scope)

**Query params:**
- `status` -- filter: `open`, `claimed`, `completed`, `escalated`, `abandoned`
- `claimed_by` -- filter by claiming agent
- `assigned_to` -- filter by assigned agent
- `limit` -- max results (default 50, max 200)

```bash
curl "http://localhost:3000/api/v1/tasks?status=open&limit=10" \
  -H "Authorization: Bearer lt_your_key"
```

### GET /api/v1/tasks/:id

Get a single task with full details.

### PATCH /api/v1/tasks/:id

Update task status. Uses optimistic locking.

**Auth:** API key (write scope)

**Body:**
```json
{
  "status": "completed",
  "result": "Auth endpoint implemented and tested",
  "version": 1,
  "priority": "P1",
  "assigned_to": "backend-dev"
}
```

`version` is required for optimistic locking -- include the current version from the task.

### GET /api/v1/tasks/graph

Get tasks as a DAG (nodes + edges) for visualization.

**Query params:**
- `status` -- CSV of statuses to include
- `workflow_run_id` -- filter to a specific workflow run
- `limit` -- max nodes (default 100, max 500)

---

## Agent Routes

### POST /api/v1/agents

Register or update an agent.

**Auth:** API key (write scope)

**Body:**
```json
{
  "agent_id": "backend-dev",
  "capabilities": ["typescript", "api-design", "databases"],
  "status": "online",
  "metadata": {"version": "1.0"}
}
```

### GET /api/v1/agents

List agents with optional filters.

**Query params:**
- `capability` -- filter by capability
- `status` -- filter: `online`, `offline`, `busy`

### POST /api/v1/agents/:id/heartbeat

Keep an agent's presence as online.

**Body (optional):**
```json
{"status": "busy"}
```

---

## Message Routes

### POST /api/v1/messages

Send a direct message to another agent.

**Auth:** API key (write scope)

**Body:**
```json
{
  "to": "frontend-dev",
  "message": "The API is ready for integration",
  "tags": ["handoff"]
}
```

### GET /api/v1/messages

Get messages sent to the authenticated agent (identified by `X-Agent-ID`).

**Query params:**
- `since_id` -- cursor for pagination
- `limit` -- max messages (default 50, max 200)

---

## Artifact Routes

### POST /api/v1/artifacts

Save a typed artifact (max 1 MB).

**Auth:** API key (write scope)

**Body:**
```json
{
  "key": "auth-flow-diagram",
  "content_type": "text/html",
  "content": "<html>...</html>",
  "metadata": {"version": "2"}
}
```

Content types: `text/plain`, `text/markdown`, `text/html`, `application/json`, `text/x-typescript`, `text/x-javascript`, `text/x-python`, `text/css`

### GET /api/v1/artifacts

List artifact metadata (no content).

**Query params:**
- `content_type` -- filter
- `limit` -- max results (default 50, max 200)

### GET /api/v1/artifacts/:key

Get a single artifact with full content.

### DELETE /api/v1/artifacts/:key

Delete an artifact.

---

## Playbook Routes

### POST /api/v1/playbooks

Define or update a playbook.

**Auth:** API key (write scope)

**Body:**
```json
{
  "name": "deploy-pipeline",
  "description": "Standard deployment pipeline",
  "tasks": [
    {"description": "Run tests", "role": "tester"},
    {"description": "Build artifacts", "role": "builder", "depends_on_index": [0]},
    {"description": "Deploy to staging", "role": "deployer", "depends_on_index": [1]}
  ]
}
```

### GET /api/v1/playbooks

List all playbooks.

### GET /api/v1/playbooks/:name

Get a single playbook with task templates.

### POST /api/v1/playbooks/:name/run

Run a playbook, creating real tasks from templates.

**Body (optional):**
```json
{
  "vars": {"environment": "staging", "version": "2.1.0"}
}
```

Variables are substituted into task descriptions via `{{vars.KEY}}`.

**Response (201):** Returns workflow run ID and created task IDs.

---

## Schedule Routes

### POST /api/v1/schedules

Create a cron schedule for a playbook.

**Auth:** API key (write scope)

**Body:**
```json
{
  "playbook_name": "daily-report",
  "cron_expression": "0 9 * * *",
  "enabled": true
}
```

Supported cron patterns:
- `*/N * * * *` -- every N minutes
- `0 */N * * *` -- every N hours
- `0 N * * *` -- daily at hour N (UTC)
- `0 H * * D` -- weekly on day D at hour H (Sun=0)

### GET /api/v1/schedules

List schedules with last/next run timestamps.

### DELETE /api/v1/schedules/:id

Delete a schedule.

---

## Workflow Run Routes

### GET /api/v1/workflow-runs

List playbook executions.

**Query params:**
- `status` -- filter: `running`, `completed`, `failed`
- `limit` -- max results (default 50, max 200)

### GET /api/v1/workflow-runs/:id

Get a single run with current status of each task.

---

## Profile Routes

### POST /api/v1/profiles

Define or update an agent profile.

**Auth:** API key (write scope)

**Body:**
```json
{
  "name": "researcher",
  "description": "Deep research specialist",
  "system_prompt": "You are a thorough researcher...",
  "default_capabilities": ["research", "analysis"],
  "default_tags": ["research"]
}
```

### GET /api/v1/profiles

List all profiles.

### GET /api/v1/profiles/:name

Get a profile with its full system prompt.

### DELETE /api/v1/profiles/:name

Delete a profile.

---

## Webhook Routes

### POST /api/v1/webhooks

Create an outbound webhook.

**Auth:** API key (write scope)

**Body:**
```json
{
  "url": "https://example.com/webhook",
  "event_types": ["TASK_UPDATE", "ESCALATION"]
}
```

Webhooks are signed with HMAC-SHA256. The secret is returned at creation time.

### GET /api/v1/webhooks

List webhooks (secrets truncated).

### GET /api/v1/webhooks/:id

Get a single webhook.

### DELETE /api/v1/webhooks/:id

Delete a webhook.

### GET /api/v1/webhooks/:id/deliveries

Delivery history for a webhook.

**Query params:**
- `limit` -- max results (default 100)

---

## Inbound Endpoint Routes

### POST /api/v1/inbound

Create an inbound webhook endpoint (authenticated).

**Auth:** API key (write scope)

**Body:**
```json
{
  "name": "GitHub Push Handler",
  "action_type": "create_task",
  "action_config": {"description_template": "New push to {{ref}}"},
  "hmac_secret": "optional-shared-secret"
}
```

Action types: `create_task`, `broadcast_event`, `save_context`, `run_playbook`

### GET /api/v1/inbound

List inbound endpoints.

### DELETE /api/v1/inbound/:id

Delete an inbound endpoint.

### POST /api/v1/inbound/:endpoint_key

**Public receiver** (no auth required). The `endpoint_key` in the URL IS the authentication. Optional HMAC verification via `X-Lattice-Signature: sha256=<hex>`.

**Body:** JSON object (payload passed to the configured action).

---

## Team Info Route

### GET /api/v1/teams/mine

Get info about the authenticated workspace, including override status.

**Auth:** API key (any scope)

```bash
curl http://localhost:3000/api/v1/teams/mine \
  -H "Authorization: Bearer lt_your_key"
```

**Response (200):**
```json
{
  "workspaceId": "my-team",
  "baseWorkspaceId": "my-team",
  "overrideApplied": false,
  "accessibleWorkspaces": [
    {"workspaceId": "my-team", "via": "authorization"}
  ],
  "scope": "write"
}
```

---

## Export Route

### GET /api/v1/export

Full workspace data export (13 sections). Secrets redacted, artifact content metadata-only, events capped at 1000.

**Auth:** API key (read scope)

```bash
curl http://localhost:3000/api/v1/export \
  -H "Authorization: Bearer lt_your_key"
```

---

## Analytics Route

### GET /api/v1/analytics

Aggregated workspace analytics.

**Auth:** API key (read scope)

**Query params:**
- `since` -- duration window: `24h` (default), `7d`, `30d`

```bash
curl "http://localhost:3000/api/v1/analytics?since=7d" \
  -H "Authorization: Bearer lt_your_key"
```

---

## Admin Routes

All admin routes require `Authorization: Bearer <ADMIN_KEY>`.

### POST /admin/teams

Create a workspace.

**Body:**
```json
{"id": "new-team", "name": "New Team"}
```

**Response (201):**
```json
{"workspace_id": "new-team", "api_key": "lt_...", "scope": "write"}
```

### GET /admin/teams

List all workspaces.

### POST /admin/teams/:id/keys

Generate an API key for a workspace.

**Body:**
```json
{
  "label": "ci-pipeline",
  "scope": "write",
  "expires_in_days": 90
}
```

### GET /admin/teams/:id/keys

List all keys for a workspace (never returns raw keys or hashes).

### POST /admin/teams/:id/keys/:keyId/rotate

Rotate a key: revoke old, create new with same label/scope/expiry.

### POST /admin/keys/:keyId/revoke

Revoke a specific key by ID.

### DELETE /admin/teams/:id/keys

Revoke all keys for a workspace.

### GET /admin/stats

System-wide statistics.

**Response (200):**
```json
{
  "teams": 5,
  "active_agents": 12,
  "context_entries": 340,
  "events": 1200,
  "tasks": {"open": 3, "claimed": 5, "completed": 42}
}
```

### GET /admin/audit-log

Query the audit log across workspaces.

**Query params:**
- `workspace_id` (required)
- `actor`, `action`, `resource_type` -- filters
- `since`, `until` -- ISO 8601 time bounds
- `limit` -- max results
- `before_id` -- cursor for pagination

---

## Error Format

All errors follow this format:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description"
}
```

Common error codes:
- `VALIDATION_ERROR` (400) -- invalid input
- `UNAUTHORIZED` (401) -- missing or invalid auth
- `INSUFFICIENT_SCOPE` (403) -- key scope too low
- `NOT_FOUND` (404) -- resource not found
- `CONFLICT` (409) -- optimistic lock failure / duplicate
- `SECRET_DETECTED` (400) -- API key or credential in content
- `RATE_LIMITED` (429) -- rate limit exceeded
- `INTERNAL_ERROR` (500) -- unexpected server error
