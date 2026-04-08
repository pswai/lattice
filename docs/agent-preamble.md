# Lattice Integration Guide

## Overview

Lattice is an MCP-native coordination layer for AI agent teams — the operations platform for things that survive beyond a single session. It provides shared knowledge, event-driven messaging, task management with dependency graphs, agent discovery, direct messaging, playbook-driven workflows, and inbound webhooks -- all accessible via 35 MCP tools or a REST API.

Lattice is framework-agnostic. Any AI agent that can make MCP tool calls or HTTP requests can participate in a Lattice workspace.

### When to use Lattice vs built-in tools

| Need | Use Lattice | Use built-in tools |
|------|------------|-------------------|
| Knowledge that persists across sessions | `save_context` / `get_context` | MEMORY.md (flat, ~200 line cap) |
| Persistent tasks with DAG dependencies | `create_task` / `update_task` | TodoWrite (session-scoped) |
| Automated pipelines & cron | `define_playbook`, `define_schedule` | — |
| Multi-agent async messaging | `broadcast`, `send_message` | SendMessage (intra-session) |
| Webhooks from external systems | `define_inbound_endpoint` | — |
| Observability & audit trails | `get_analytics`, `export_workspace_data` | — |

Use built-in tools for session-local scratch work. Reach for Lattice when you need persistence, automation, or cross-agent coordination.

## MCP Tool Reference

### Coordination (Tasks & Workflow)

| Tool | Purpose | Key Params | When to Use |
|------|---------|------------|-------------|
| `create_task` | Create a work item | `agent_id`, `description`, `status?` (open/claimed), `priority?` (P0-P3), `assigned_to?`, `depends_on?` (task ID array) | Starting new work; defaults to auto-claimed for creator |
| `update_task` | Update task status | `agent_id`, `task_id`, `status` (claimed/completed/escalated/abandoned), `version` (required), `result?`, `priority?`, `assigned_to?` | Claiming, completing, escalating, or reassigning work |
| `list_tasks` | List workspace tasks | `status?`, `claimed_by?`, `assigned_to?`, `limit?` (max 200) | Finding available or in-progress work |
| `get_task` | Get task by ID | `task_id` | Fetching current version before update, checking details |
| `get_task_graph` | Get task DAG | `status?` (CSV), `workflow_run_id?`, `limit?` (max 500) | Visualizing dependencies, checking blocked tasks |
| `define_playbook` | Define task templates | `agent_id`, `name`, `description`, `tasks[]` (each: description, role?, depends_on_index?) | Creating reusable multi-step workflows |
| `list_playbooks` | List all playbooks | (none) | Discovering available workflows |
| `run_playbook` | Instantiate a playbook | `agent_id`, `name`, `vars?` (key-value for `{{vars.KEY}}` substitution) | Launching a predefined workflow |
| `define_schedule` | Create cron schedule | `agent_id`, `playbook_name`, `cron_expression`, `enabled?` | Automating recurring playbook runs |
| `list_schedules` | List all schedules | (none) | Reviewing scheduled automations |
| `delete_schedule` | Delete a schedule | `agent_id`, `id` | Removing a scheduled automation |
| `list_workflow_runs` | List playbook runs | `status?` (running/completed/failed), `limit?` (max 200) | Monitoring workflow execution |
| `get_workflow_run` | Get workflow run details | `id` | Checking individual run status and task progress |

### Knowledge (Context & Artifacts)

| Tool | Purpose | Key Params | When to Use |
|------|---------|------------|-------------|
| `save_context` | Save a learning/finding | `agent_id`, `key` (unique), `value` (max 100 KB), `tags?` | Storing insights, analysis results, decisions |
| `get_context` | Search knowledge base | `query` (full-text), `tags?` (OR filter), `limit?` (max 100) | Finding existing knowledge before starting work |
| `save_artifact` | Store a file | `agent_id`, `key`, `content_type` (MIME), `content` (max 1 MB), `metadata?` | Storing structured outputs: HTML, JSON, code, markdown |
| `get_artifact` | Get artifact by key | `key` | Retrieving a stored file with full content |
| `list_artifacts` | List artifacts | `content_type?`, `limit?` (max 200) | Browsing stored outputs (metadata only) |

Supported artifact content types: `text/plain`, `text/markdown`, `text/html`, `application/json`, `text/x-typescript`, `text/x-javascript`, `text/x-python`, `text/css`.

### Communication (Events & Messages)

| Tool | Purpose | Key Params | When to Use |
|------|---------|------------|-------------|
| `broadcast` | Push event to workspace bus | `agent_id`, `event_type` (LEARNING/BROADCAST/ESCALATION/ERROR/TASK_UPDATE), `message` (max 10 KB), `tags?` | Announcing findings, errors, status changes |
| `get_updates` | Poll for events | `since_id?`, `since_timestamp?`, `topics?`, `limit?` (max 200), `include_context?` | Checking what happened since your last poll |
| `wait_for_event` | Long-poll for events | `since_id`, `topics?`, `event_type?`, `timeout_sec?` (max 60, default 30) | Blocking until a specific event arrives |
| `send_message` | Direct message an agent | `agent_id` (sender), `to` (recipient), `message` (max 10 KB), `tags?` | Handoffs, questions, targeted notifications |
| `get_messages` | Get your messages | `agent_id` (recipient), `since_id?`, `limit?` (max 200) | Checking your inbox |

### Discovery (Agents & Profiles)

| Tool | Purpose | Key Params | When to Use |
|------|---------|------------|-------------|
| `register_agent` | Register with capabilities | `agent_id`, `capabilities?`, `status?` (online/offline/busy), `metadata?` | Publishing what you can do so others discover you |
| `list_agents` | Find agents | `capability?`, `status?` | Discovering collaborators by skill or availability |
| `heartbeat` | Stay online | `agent_id`, `status?` | Preventing offline marking and task reaper |
| `define_profile` | Define a role template | `agent_id`, `name`, `description`, `system_prompt` (max 100 KB), `default_capabilities?`, `default_tags?` | Creating reusable role definitions |
| `get_profile` | Load a profile | `name` | Loading a role's system prompt and defaults |
| `list_profiles` | List all profiles | (none) | Browsing available roles |
| `delete_profile` | Delete a profile | `agent_id`, `name` | Removing an obsolete role |

### Inbound Webhooks

| Tool | Purpose | Key Params | When to Use |
|------|---------|------------|-------------|
| `define_inbound_endpoint` | Create webhook receiver | `agent_id`, `name`, `action_type` (create_task/broadcast_event/save_context/run_playbook), `action_config?`, `hmac_secret?` | Connecting external systems (GitHub, Slack, CI) to Lattice |
| `list_inbound_endpoints` | List endpoints | (none) | Reviewing configured webhooks |
| `delete_inbound_endpoint` | Delete endpoint | `agent_id`, `endpoint_id` | Removing a webhook |

### Observability

| Tool | Purpose | Key Params | When to Use |
|------|---------|------------|-------------|
| `get_analytics` | Workspace stats | `since?` ("24h", "7d", "30d") | Dashboards, health checks, retrospectives |
| `export_workspace_data` | Full workspace export | (none) | Backup, migration, auditing (secrets redacted) |

## REST API Alternative

All MCP tools are also available as REST endpoints for non-MCP agents.

### Base URL

```
http://localhost:3000/api/v1
```

### Authentication

```
Authorization: Bearer <WORKSPACE_API_KEY>
X-Agent-ID: <your-agent-id>
```

### Key Endpoints

| Method | Path | Equivalent MCP Tool |
|--------|------|-------------------|
| POST | `/context` | `save_context` |
| GET | `/context?query=...&tags=...` | `get_context` |
| POST | `/events` | `broadcast` |
| GET | `/events?since_id=...` | `get_updates` |
| GET | `/events/wait` | `wait_for_event` |
| POST | `/tasks` | `create_task` |
| PATCH | `/tasks/:id` | `update_task` |
| GET | `/tasks` | `list_tasks` |
| GET | `/tasks/:id` | `get_task` |
| GET | `/tasks/graph` | `get_task_graph` |
| POST | `/agents` | `register_agent` |
| GET | `/agents` | `list_agents` |
| POST | `/agents/:id/heartbeat` | `heartbeat` |
| POST | `/messages` | `send_message` |
| GET | `/messages?agent_id=...` | `get_messages` |
| POST | `/artifacts` | `save_artifact` |
| GET | `/artifacts/:key` | `get_artifact` |
| GET | `/artifacts` | `list_artifacts` |
| POST | `/playbooks` | `define_playbook` |
| GET | `/playbooks` | `list_playbooks` |
| POST | `/playbooks/:name/run` | `run_playbook` |
| POST | `/schedules` | `define_schedule` |
| GET | `/schedules` | `list_schedules` |
| DELETE | `/schedules/:id` | `delete_schedule` |
| GET | `/workflow-runs` | `list_workflow_runs` |
| GET | `/workflow-runs/:id` | `get_workflow_run` |
| POST | `/profiles` | `define_profile` |
| GET | `/profiles` | `list_profiles` |
| GET | `/profiles/:name` | `get_profile` |
| DELETE | `/profiles/:name` | `delete_profile` |
| POST | `/inbound` | `define_inbound_endpoint` |
| GET | `/inbound` | `list_inbound_endpoints` |
| DELETE | `/inbound/:id` | `delete_inbound_endpoint` |
| GET | `/analytics` | `get_analytics` |
| GET | `/export` | `export_workspace_data` |
| POST | `/inbound/:endpoint_key` | (webhook trigger) |

## Integration Patterns

### Pattern 1: Task Worker

An agent that polls for open tasks, claims them, does the work, and reports results.

```
loop:
  tasks = list_tasks(status: "open")
  for task in tasks:
    if task matches my capabilities:
      update_task(agent_id: "worker-1", task_id: task.id, status: "claimed", version: task.version)
      # ... do the work ...
      save_context(agent_id: "worker-1", key: "task-{task.id}-result", value: "...", tags: ["result"])
      update_task(agent_id: "worker-1", task_id: task.id, status: "completed", version: task.version + 1, result: "Done: ...")
  heartbeat(agent_id: "worker-1")
  wait_for_event(since_id: last_cursor, event_type: "TASK_UPDATE", timeout_sec: 30)
```

Key points:
- Always fetch the task first to get the current `version` before updating.
- Call `heartbeat` periodically to prevent the task reaper from abandoning your claimed tasks (30-minute timeout).
- Use `wait_for_event` instead of tight polling loops.

### Pattern 2: Research Coordinator

A coordinator spawns parallel research agents, each saving findings to shared context. The coordinator synthesizes at the end.

```
# Coordinator creates tasks for each research area
create_task(agent_id: "coord", description: "Research area A", assigned_to: "researcher-a")
create_task(agent_id: "coord", description: "Research area B", assigned_to: "researcher-b")
broadcast(agent_id: "coord", event_type: "BROADCAST", message: "Research kicked off: areas A, B", tags: ["research"])

# Each researcher works independently
get_context(query: "area A prior work")              # Check existing knowledge
save_context(agent_id: "researcher-a", key: "area-a-market-size", value: "...", tags: ["research", "area-a"])
broadcast(agent_id: "researcher-a", event_type: "LEARNING", message: "Key finding: ...", tags: ["research"])
update_task(agent_id: "researcher-a", task_id: 1, status: "completed", result: "...", version: 2)

# Coordinator waits and synthesizes
wait_for_event(since_id: 0, event_type: "TASK_UPDATE", timeout_sec: 60)
get_context(query: "research", tags: ["research"])    # Gather all findings
save_context(agent_id: "coord", key: "research-synthesis", value: "...", tags: ["research", "synthesis"])
```

### Pattern 3: Pipeline Stage (Playbook-Driven)

Define a multi-stage pipeline once, then instantiate it per feature/ticket. Each stage agent claims its task when dependencies are met.

```
# Define the pipeline (one-time setup)
define_playbook(agent_id: "lead", name: "pr-review", description: "PR review pipeline", tasks: [
  { description: "Lint and type-check {{vars.pr}}", role: "ci-agent" },
  { description: "Run test suite for {{vars.pr}}", role: "test-agent", depends_on_index: [0] },
  { description: "Security scan {{vars.pr}}", role: "security-agent", depends_on_index: [0] },
  { description: "Final review {{vars.pr}}", role: "reviewer", depends_on_index: [1, 2] }
])

# Instantiate for a specific PR
run_playbook(agent_id: "lead", name: "pr-review", vars: { "pr": "PR #42: Add OAuth" })

# Each stage agent watches for claimable tasks
list_tasks(status: "open", assigned_to: "ci-agent")
# Task becomes open only after its depends_on tasks are all completed
```

### Pattern 4: External Trigger (Inbound Webhook)

Let external systems drive Lattice workflows without any agent code changes.

```
# Create an inbound endpoint
define_inbound_endpoint(
  agent_id: "ops",
  name: "deploy-notify",
  action_type: "run_playbook",
  action_config: { "playbook_name": "post-deploy-checks" },
  hmac_secret: "webhook-signing-secret"
)
# Returns endpoint_key: "abc123..."

# External system POSTs to:
# POST /api/v1/inbound/abc123...
# Headers: X-Lattice-Signature: sha256=<hmac-hex>
# Body: { "environment": "production", "version": "1.2.3" }
```

## Example: Full Workflow (Step by Step)

Scenario: An orchestrator agent coordinates two specialists to research and write a report.

```
# Step 1: Orchestrator creates the workspace tasks
create_task(agent_id: "orch", description: "Research competitor pricing models", priority: "P1", assigned_to: "researcher")
# Returns: { id: 1, version: 1 }

create_task(agent_id: "orch", description: "Write pricing analysis report", priority: "P1", assigned_to: "writer", depends_on: [1])
# Returns: { id: 2, version: 1 }
# Task 2 is blocked until task 1 completes

# Step 2: Researcher claims and works
get_task(task_id: 1)
# Returns: { id: 1, status: "open", version: 1, assigned_to: "researcher" }

update_task(agent_id: "researcher", task_id: 1, status: "claimed", version: 1)
# Returns: { id: 1, status: "claimed", version: 2 }

# Research happens here...

save_context(agent_id: "researcher", key: "pricing-competitor-analysis", value: "Competitor A charges $X/seat...", tags: ["pricing", "research", "competitors"])

broadcast(agent_id: "researcher", event_type: "LEARNING", message: "Found 3 pricing tiers across all competitors: free/pro/enterprise", tags: ["pricing"])

save_artifact(agent_id: "researcher", key: "pricing-raw-data", content_type: "application/json", content: "{...}", metadata: { "sources": 5 })

update_task(agent_id: "researcher", task_id: 1, status: "completed", version: 2, result: "Analyzed 5 competitors across 3 pricing dimensions")
# Returns: { id: 1, status: "completed", version: 3 }
# Task 2 is now unblocked

# Step 3: Writer picks up
get_messages(agent_id: "writer")
# Or: wait_for_event(since_id: 0, event_type: "TASK_UPDATE")

get_task(task_id: 2)
# Returns: { id: 2, status: "open", version: 1 }  -- now unblocked

update_task(agent_id: "writer", task_id: 2, status: "claimed", version: 1)

get_context(query: "pricing competitors", tags: ["research"])
# Returns the researcher's findings

get_artifact(key: "pricing-raw-data")
# Returns the full JSON dataset

# Writer produces the report...

save_artifact(agent_id: "writer", key: "pricing-report", content_type: "text/markdown", content: "# Pricing Analysis\n...")

update_task(agent_id: "writer", task_id: 2, status: "completed", version: 2, result: "Report saved as artifact: pricing-report")

broadcast(agent_id: "writer", event_type: "BROADCAST", message: "Pricing analysis complete. Report: pricing-report", tags: ["pricing", "complete"])
```

## Best Practices

### Identity

- **Use a consistent `agent_id`** across all calls in a session. Never change it mid-workflow. The ID is how other agents and the system track your activity.
- **Set `X-Agent-ID` in your MCP config** as a default, and pass `agent_id` explicitly in tool calls.

### Tagging and Keys

- **Tag generously.** Tags are the primary discovery mechanism. Use 3-5 relevant tags per entry.
- **Use descriptive keys.** `"auth-jwt-rotation-policy"` is findable; `"finding-3"` is not.
- **Namespace keys by topic.** Pattern: `"{topic}-{subtopic}"` (e.g., `"pricing-enterprise-tiers"`).

### Task Management

- **Optimistic locking is mandatory.** Every `update_task` call requires the current `version`. On conflict, call `get_task` to get the latest version and retry.
- **Don't claim blocked tasks.** Tasks with unresolved `depends_on` dependencies cannot be claimed. Complete or remove the blockers first.
- **Mark tasks done.** Always set status to `completed` with a `result` summary, or `escalated` with a reason. The task reaper abandons tasks from agents with no heartbeat for 30 minutes.

### Communication

- **Search before creating.** Call `get_context` before starting research to avoid duplicating another agent's work.
- **Broadcast important discoveries immediately.** Don't wait until task completion to share key findings.
- **Use `wait_for_event` instead of polling loops.** It blocks efficiently for up to 60 seconds.
- **Use direct messages for handoffs.** `send_message` is for targeted communication; `broadcast` is for workspace-wide announcements.

### Security

- **Never include secrets in content.** The secret scanner rejects API keys, tokens, and connection strings in `save_context`, `broadcast`, and `send_message`. Sanitize before saving.
- **Use HMAC on inbound endpoints.** Set `hmac_secret` when defining inbound endpoints to verify webhook authenticity.

### Heartbeat and Liveness

- **Call `heartbeat` during long-running work.** The task reaper auto-abandons tasks from agents that haven't sent a heartbeat within 30 minutes. If your work takes longer, send periodic heartbeats.
- **Auto-registration is silent.** Your first MCP call registers you. Explicit `register_agent` is only needed to publish capabilities or metadata.

### Artifacts vs. Context

- **Context** (`save_context`): Short insights, learnings, decisions -- under 100 KB. Searchable via full-text search.
- **Artifacts** (`save_artifact`): Structured file outputs -- up to 1 MB. Typed by MIME content type. Not full-text searchable.
- Rule of thumb: if another agent needs to *find* it by keyword, use context. If they need to *retrieve* it by key, use artifact.
