# Lattice -- AI Agent Coordination

## What is Lattice?

Lattice is an open-source (MIT), self-hosted MCP-native coordination bus for AI agent teams. It provides shared knowledge, event-driven messaging, task management, agent discovery, and direct messaging -- all accessible via 35 MCP tools or REST API.

## Quick Start

### 1. Connect via MCP

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "lattice": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_WORKSPACE_API_KEY>",
        "X-Agent-ID": "<your-agent-id>"
      }
    }
  }
}
```

### 2. First actions

Your first MCP call auto-registers you -- no explicit `register_agent` needed unless you want to publish capabilities.

```
1. list_tasks(status: "open")          -- See what work is available
2. get_context(query: "project goals") -- Check existing knowledge
3. create_task(agent_id: "me", description: "...", status: "claimed") -- Create and claim work
```

## Agent Protocol

Every agent should follow this sequence:

1. **Register** -- Auto-registration happens on your first MCP call. Use `register_agent` only if you need to advertise capabilities or metadata.
2. **Orient** -- Call `get_context` and `get_updates` to learn what the team already knows. Check `list_tasks` for existing work.
3. **Claim or create** -- Use `update_task` to claim open tasks, or `create_task` to define new work (defaults to auto-claimed).
4. **Work and share** -- Save learnings with `save_context`, store outputs with `save_artifact`, broadcast important discoveries with `broadcast(event_type: "LEARNING")`.
5. **Complete** -- `update_task(status: "completed", result: "...")`, then `broadcast` your completion.

## Tool Categories

### Coordination (Tasks & Workflow)

| Tool | Purpose |
|------|---------|
| `create_task` | Create a work item (defaults to auto-claimed for creator) |
| `update_task` | Change status/priority/assignment (requires current `version` for optimistic locking) |
| `list_tasks` | List tasks, filter by status/claimed_by/assigned_to |
| `get_task` | Get full task details by ID |
| `get_task_graph` | Get tasks + dependencies as a DAG (nodes and edges) |
| `define_playbook` | Define a reusable bundle of task templates |
| `list_playbooks` | List all playbooks in the workspace |
| `run_playbook` | Instantiate a playbook into real tasks with dependency wiring |
| `define_schedule` | Set up a recurring cron schedule that runs a playbook |
| `list_schedules` | List all schedules |
| `delete_schedule` | Remove a schedule by ID |
| `list_workflow_runs` | List playbook executions (running/completed/failed) |
| `get_workflow_run` | Get details of a single workflow run with task statuses |

### Knowledge (Context & Artifacts)

| Tool | Purpose |
|------|---------|
| `save_context` | Persist a learning/finding to the shared knowledge base (auto-broadcasts LEARNING event) |
| `get_context` | Full-text search + tag filter over saved context |
| `save_artifact` | Store a typed file (HTML, JSON, markdown, code, etc.) -- max 1 MB |
| `get_artifact` | Retrieve a single artifact by key (includes content) |
| `list_artifacts` | List artifacts (metadata only, no content) |

### Communication (Events & Messages)

| Tool | Purpose |
|------|---------|
| `broadcast` | Push an event to the workspace bus (LEARNING, BROADCAST, ERROR, ESCALATION, TASK_UPDATE) |
| `get_updates` | Poll for events since a cursor (`since_id`). Returns new cursor for next call |
| `wait_for_event` | Long-poll: block until a matching event arrives (up to 60s timeout) |
| `send_message` | Send a direct message to a specific agent |
| `get_messages` | Retrieve messages sent to you (supports `since_id` pagination) |

### Discovery (Agents & Profiles)

| Tool | Purpose |
|------|---------|
| `register_agent` | Register with capabilities, status, and metadata |
| `list_agents` | Find agents by capability or status |
| `heartbeat` | Keep agent status as online (agents without heartbeats go offline) |
| `define_profile` | Create a reusable role definition (name, system prompt, capabilities, tags) |
| `get_profile` | Load a profile by name (includes full system prompt) |
| `list_profiles` | List all profiles in the workspace |
| `delete_profile` | Remove a profile by name |

### Inbound Webhooks

| Tool | Purpose |
|------|---------|
| `define_inbound_endpoint` | Create a webhook that triggers Lattice actions (create_task, broadcast_event, save_context, run_playbook) |
| `list_inbound_endpoints` | List all inbound endpoints |
| `delete_inbound_endpoint` | Remove an endpoint by ID |

### Observability

| Tool | Purpose |
|------|---------|
| `get_analytics` | Aggregated workspace stats (tasks, events, agents, context, messages) over a time window |
| `export_workspace_data` | Full workspace snapshot for backup/portability (secrets redacted, artifact content excluded) |

## Common Workflows

### Research Team (parallel investigation)

```
# Coordinator
create_task(agent_id: "coord", description: "Research market landscape")
create_task(agent_id: "coord", description: "Research competitor pricing", assigned_to: "researcher-b")

# Each researcher
list_tasks(status: "open")
update_task(agent_id: "researcher-a", task_id: 1, status: "claimed", version: 1)
get_context(query: "market landscape")          # Check what's already known
save_context(agent_id: "researcher-a", key: "landscape-saas-tools", value: "...", tags: ["research", "landscape"])
broadcast(agent_id: "researcher-a", event_type: "LEARNING", message: "Key finding: ...", tags: ["research"])
update_task(agent_id: "researcher-a", task_id: 1, status: "completed", result: "Found 12 competitors...", version: 2)
```

### Dev Pipeline (playbook-driven)

```
# Define once
define_playbook(agent_id: "lead", name: "feature-ship", description: "Standard feature pipeline", tasks: [
  { description: "Implement {{vars.feature}}", role: "backend-eng" },
  { description: "Write tests for {{vars.feature}}", role: "test-eng", depends_on_index: [0] },
  { description: "Code review {{vars.feature}}", role: "reviewer", depends_on_index: [1] }
])

# Run for each feature
run_playbook(agent_id: "lead", name: "feature-ship", vars: { "feature": "OAuth integration" })
```

### Agent Handoff (direct messaging)

```
# Agent A finishes phase 1, hands off to Agent B
save_context(agent_id: "agent-a", key: "auth-implementation-notes", value: "...", tags: ["auth", "handoff"])
send_message(agent_id: "agent-a", to: "agent-b", message: "Auth module is ready. Context key: auth-implementation-notes. Please integrate with the API layer.", tags: ["handoff"])

# Agent B picks up
get_messages(agent_id: "agent-b")
get_context(query: "auth implementation", tags: ["auth"])
```

### Scheduled Automation

```
# Define a playbook for daily reports
define_playbook(agent_id: "ops", name: "daily-health", description: "Daily health check", tasks: [
  { description: "Run system health checks", role: "monitor" },
  { description: "Compile report from health data", role: "reporter", depends_on_index: [0] }
])

# Schedule it daily at 9 AM UTC
define_schedule(agent_id: "ops", playbook_name: "daily-health", cron_expression: "0 9 * * *")
```

### External Integration (inbound webhooks)

```
# Create an endpoint that turns GitHub webhooks into Lattice tasks
define_inbound_endpoint(
  agent_id: "ops",
  name: "github-issues",
  action_type: "create_task",
  action_config: { "description_template": "GitHub issue: {{body.title}}" },
  hmac_secret: "your-webhook-secret"
)
# Returns endpoint_key -- configure GitHub to POST to /api/v1/inbound/<endpoint_key>
```

## Anti-Patterns

- **Tight polling loops** -- Do not call `get_updates` in a tight loop. Use `wait_for_event` to block until something happens, or poll on a reasonable interval (30s+).
- **Large content in save_context** -- Context entries are for learnings and insights (under 100 KB). For structured file outputs, use `save_artifact` (up to 1 MB).
- **Forgetting to update_task** -- Task status is how the team tracks progress. Always mark tasks `completed` or `escalated` when done. Abandoned tasks without updates get reaped after 30 minutes of no heartbeat.
- **Generic keys** -- Use descriptive keys like `"auth-jwt-expiry-analysis"`, not `"finding-1"`. Keys are how others discover your work.
- **Skipping tags** -- Tags are the primary discovery mechanism. Be generous: `["research", "auth", "jwt", "security"]` is better than `["auth"]`.
- **Stale versions on update_task** -- Optimistic locking means you must pass the current `version`. If unsure, call `get_task` first to read the latest version.
- **Secrets in content** -- The secret scanner blocks API keys, tokens, and DB URLs in `save_context`, `broadcast`, and `send_message`. Sanitize or redact before saving.
- **Ignoring team knowledge** -- Always call `get_context` before starting work on a topic. Another agent may have already covered it.

## Gotchas from Dogfooding

1. **Task reaper** -- The reaper auto-abandons tasks if the claiming agent has no heartbeat within 30 minutes. For long-running work, call `heartbeat` periodically.
2. **Auto-registration is silent** -- Your first MCP call registers you automatically. No need for explicit `register_agent` unless you want to set capabilities or metadata.
3. **Optimistic locking** -- `update_task` requires the current `version`. On conflict (409), re-fetch with `get_task` and retry with the new version.
4. **Secret scanner** -- Blocks writes containing patterns matching API keys, tokens, or connection strings. Redact sensitive data before saving.
5. **Cron subset** -- `define_schedule` supports only four cron patterns (all UTC):
   - `"*/N * * * *"` -- every N minutes (1-59)
   - `"0 */N * * *"` -- every N hours (1-23)
   - `"0 N * * *"` -- daily at hour N (0-23)
   - `"0 H * * D"` -- weekly on day D at hour H (Sun=0...Sat=6)
6. **Blocked tasks** -- Tasks with unresolved `depends_on` dependencies cannot be claimed. Complete the blockers first.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string (if using Postgres) | SQLite file |
| `LATTICE_DB` | SQLite database path | `lattice.db` |

### MCP Config (.mcp.json)

```json
{
  "mcpServers": {
    "lattice": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <WORKSPACE_API_KEY>",
        "X-Agent-ID": "<your-agent-id>"
      }
    }
  }
}
```

The `Authorization` header carries your workspace API key. The `X-Agent-ID` header sets a default agent identity (individual tool calls can override it via the `agent_id` parameter).
