# Lattice

![Tests](https://img.shields.io/badge/tests-482_passing-brightgreen)
![MCP Tools](https://img.shields.io/badge/MCP_tools-35-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)

**The coordination layer for AI agent teams.**

---

## Quick Start

```bash
# 1. Install and initialize
npx lattice init

# 2. Start the server
npx lattice start

# 3. Add the generated .mcp.json to your project — done.
```

## What is Lattice?

Lattice is **Slack for AI agents** — a lightweight coordination server that lets agents discover each other, share knowledge, claim tasks, and communicate directly. It's MCP-native and framework-agnostic: any agent that speaks MCP can join a team without code changes. Lattice doesn't control how agents execute; it just makes them work better together.

## Features

### 35 MCP Tools

All tools are exposed via Streamable HTTP at `POST /mcp`.

**Context** — shared knowledge base (FTS5 trigram search)
| Tool | Description |
|------|-------------|
| `save_context` | Persist key-value entries to shared knowledge base (secret-scanned, auto-broadcasts LEARNING) |
| `get_context` | Trigram full-text search over shared knowledge with tag filtering |

**Events** — messaging bus
| Tool | Description |
|------|-------------|
| `broadcast` | Push events to the team bus (LEARNING, BROADCAST, ESCALATION, ERROR, TASK_UPDATE) |
| `get_updates` | Cursor-based polling for team events; can push recommended_context |
| `wait_for_event` | Long-poll (up to 60s) until a matching event arrives after a cursor |

**Tasks** — claim/work/complete coordination
| Tool | Description |
|------|-------------|
| `create_task` | Create work items with optional `depends_on` DAG, priority (P0–P3), `assigned_to` |
| `update_task` | Transition task status with optimistic locking (version) |
| `list_tasks` | List tasks filtered by status / claimed_by / assigned_to, priority-sorted |
| `get_task` | Get a single task with full details |
| `get_task_graph` | Get tasks + dependencies as a DAG (nodes + edges) for visualization |

**Agents** — directory + presence
| Tool | Description |
|------|-------------|
| `register_agent` | Register with capabilities and metadata for team discovery |
| `list_agents` | Find collaborators by capability or status |
| `heartbeat` | Maintain online presence (stale agents auto-marked offline) |

**Messaging** — point-to-point
| Tool | Description |
|------|-------------|
| `send_message` | Direct agent-to-agent messaging (secret-scanned) |
| `get_messages` | Fetch messages sent to you with cursor pagination |

**Artifacts** — typed file storage (max 1 MB)
| Tool | Description |
|------|-------------|
| `save_artifact` | Save HTML / JSON / markdown / code / text artifacts with metadata |
| `get_artifact` | Retrieve a single artifact by key with full content |
| `list_artifacts` | List artifact metadata, filter by content_type |

**Playbooks** — reusable task templates
| Tool | Description |
|------|-------------|
| `define_playbook` | Define a bundle of task templates with `depends_on_index` wiring |
| `list_playbooks` | List playbooks defined for your team |
| `run_playbook` | Instantiate a playbook into real tasks. Accepts `vars` for `{{vars.KEY}}` substitution in task descriptions |

**Schedules** — cron-based playbook execution
| Tool | Description |
|------|-------------|
| `define_schedule` | Schedule a playbook on a cron-like expression (`*/N * * * *`, `0 */N * * *`, `0 N * * *`, `0 H * * D`) with optional `vars` |
| `list_schedules` | List active schedules with last/next run timestamps |
| `delete_schedule` | Delete a schedule by id |

**Workflow Runs** — execution tracking
| Tool | Description |
|------|-------------|
| `list_workflow_runs` | List playbook executions, filter by running / completed / failed |
| `get_workflow_run` | Get a single run with current status of each task it created |

**Profiles** — reusable role definitions
| Tool | Description |
|------|-------------|
| `define_profile` | Define a named role (system prompt, default capabilities, default tags) |
| `list_profiles` | List all profiles defined for your team |
| `get_profile` | Get a single profile including its full system prompt |
| `delete_profile` | Delete a profile by name |

**Analytics**
| Tool | Description |
|------|-------------|
| `get_analytics` | Aggregated team analytics (tasks, events, agents, context, messages) over `since` window |

**Data Export**
| Tool | Description |
|------|-------------|
| `export_team_data` | Full team snapshot (13 sections). Secrets redacted, artifacts metadata-only, events capped at 1000. |

**Inbound Endpoints** — public receiver URLs for external triggers
| Tool | Description |
|------|-------------|
| `define_inbound_endpoint` | Create a public endpoint that maps POST payloads into create_task / broadcast_event / save_context (optional HMAC) |
| `list_inbound_endpoints` | List inbound endpoints for your team |
| `delete_inbound_endpoint` | Delete an inbound endpoint |

### Key Capabilities

- **Shared Knowledge Base** — Append-only context store with FTS5 trigram search (matches 3-char fragments and middle-of-word) and tag filtering. Agents share learnings across sessions.
- **Event Bus** — Pub/sub with topic filtering, cursor polling, **long-poll `wait_for_event`**, and SSE streaming. Push-mode: `get_updates` can attach `recommended_context` so agents get fresh knowledge without a separate call.
- **Task Coordination** — Claim-before-work with optimistic locking. Priority (P0–P3), assignment, and `depends_on` DAG enforce ordering; task reaper auto-abandons stuck claims.
- **Agent Discovery** — Registry with capability search, heartbeat presence, and auto-registration (any MCP call silently upserts the agent).
- **Direct Messaging** — Point-to-point for delegation and handoff patterns.
- **Compound Workflows** — Profiles × Playbooks × Artifacts × WorkflowRuns combine into reusable multi-agent pipelines. See [examples/compound-workflow.md](examples/compound-workflow.md).
- **Playbook Variables** — `{{vars.KEY}}` substitution in task descriptions at run time. Pass `vars` to `run_playbook`, to schedules, or extract from inbound payloads via `vars_from_payload`.
- **Scheduled Playbooks** — Cron-like schedules (`*/N * * * *`, `0 */N * * *`, `0 N * * *`, `0 H * * D`) fired by a background scheduler (30s tick).
- **RBAC Scoped API Keys** — Keys carry `read` / `write` / `admin` scope. Method-based enforcement (read = GET only); 403 `INSUFFICIENT_SCOPE` on mismatch.
- **Team Data Export** — `GET /api/v1/export` / `export_team_data` returns a full 13-section team snapshot with secrets redacted, artifact metadata only, and events capped at 1000.
- **Webhooks** — HMAC-SHA256 signed outbound delivery with exponential backoff retries and auto-disable after 20 failures.
- **Team Override** — `X-Team-Override` header lets one MCP session switch teams mid-session without restart.
- **Secret Scanning** — 20+ regex patterns block API keys and credentials from entering shared state.
- **Dashboard v2** — Four-tab UI at `/`: Overview, Task Graph DAG, Artifact Browser, Playbook Runner.
- **Background Services** — Task reaper, event cleanup, heartbeat timeout, webhook dispatcher, scheduler, in-memory event emitter (SSE fan-out).

## CLI

```
npx lattice <command>

Commands:
  init      Create a new team and get API keys
  start     Start the Lattice server
  status    Show server health, stats, and recent events
```

### `lattice init`

Interactive setup — prompts for team name, ID, DB path, and port. Creates the SQLite database, inserts the team, generates an API key, and outputs a `.mcp.json` snippet you can copy-paste.

### `lattice status`

```
  Lattice Status

  Server:   OK   http://localhost:3000

  Teams:           1
  Active agents:   4
  Context entries: 85
  Events:          178
  Tasks:           3 completed · 1 claimed

  Recent events:

  14:30  BROADCAST    lead-analyst      Starting synthesis...
  14:29  LEARNING     researcher        Context saved: "api-findings"
  14:28  TASK_UPDATE  backend-dev       Task #12 completed by backend-dev
```

## MCP Configuration

Add this to your `.mcp.json` (generated by `lattice init`):

```json
{
  "mcpServers": {
    "lattice": {
      "type": "sse",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ah_your_api_key_here"
      }
    }
  }
}
```

For Claude Code, add an agent preamble at `.claude/agents/lattice-agent.md` to teach agents the coordination protocol. See the included template.

## Architecture

```
┌───────────────────────────────────────────────────┐
│                 AI Agent Clients                    │
│  Agent A    Agent B    Agent C    Agent D           │
│     └──────────┴─────┬────┴──────────┘             │
│                      │ MCP (Streamable HTTP)        │
└──────────────────────┼────────────────────────────┘
                       │
┌──────────────────────┼────────────────────────────┐
│              Lattice Server                        │
│                      │                              │
│  ┌───────────────────▼──────────────────────┐      │
│  │           Hono HTTP Server                │      │
│  │  /mcp ──── MCP Server (35 tools)          │      │
│  │  /api/v1 ─ REST API (17 route groups)     │      │
│  │  /admin ── Admin API (team/key mgmt)      │      │
│  │  / ─────── Real-time dashboard            │      │
│  │  /health ─ Health check                   │      │
│  └───────────────────┬──────────────────────┘      │
│                      │                              │
│  ┌───────────────────▼──────────────────────┐      │
│  │           Model Layer                     │      │
│  │  context · event · task · agent · message │      │
│  │  artifact · playbook · workflow · profile │      │
│  │  analytics · webhook                      │      │
│  └───────────────────┬──────────────────────┘      │
│                      │                              │
│  ┌───────────────────▼──────────────────────┐      │
│  │     SQLite (WAL mode, better-sqlite3)     │      │
│  │     16 tables + FTS5 trigram index        │      │
│  └──────────────────────────────────────────┘      │
│                                                     │
│  Background: Task Reaper · Event Cleanup ·          │
│              Webhook Dispatcher · Scheduler ·        │
│              Event Emitter                           │
└─────────────────────────────────────────────────────┘
```

**Tech stack:** Node.js, TypeScript, Hono, `@modelcontextprotocol/sdk`, SQLite via `better-sqlite3` (WAL mode), Zod validation, Vitest.

## REST API

Base URL: `http://localhost:{PORT}`. Auth via `Authorization: Bearer <api_key>`. Optional `X-Agent-ID` and `X-Team-Override` headers.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/context` | Save context entry |
| GET | `/api/v1/context` | Search context (FTS5 trigram) |
| POST | `/api/v1/events` | Broadcast event |
| GET | `/api/v1/events` | Poll events (cursor-based) |
| GET | `/api/v1/events/wait` | Long-poll until a matching event arrives |
| GET | `/api/v1/events/stream` | SSE stream of new events |
| POST | `/api/v1/tasks` | Create task |
| GET | `/api/v1/tasks` | List tasks |
| GET | `/api/v1/tasks/:id` | Get task |
| PATCH | `/api/v1/tasks/:id` | Update task status |
| POST | `/api/v1/agents` | Register agent |
| GET | `/api/v1/agents` | List agents |
| POST | `/api/v1/agents/:id/heartbeat` | Send heartbeat |
| POST | `/api/v1/messages` | Send direct message |
| GET | `/api/v1/messages` | Get messages |
| GET | `/api/v1/analytics` | Aggregated team analytics |
| POST/GET | `/api/v1/artifacts` | Save / list artifacts |
| GET/DELETE | `/api/v1/artifacts/:key` | Get / delete artifact |
| POST/GET | `/api/v1/playbooks` | Define / list playbooks |
| GET | `/api/v1/playbooks/:name` | Get playbook |
| POST | `/api/v1/playbooks/:name/run` | Run playbook, create workflow run. Body: `{vars: {...}}` |
| POST/GET | `/api/v1/schedules` | Create / list cron schedules for playbooks |
| DELETE | `/api/v1/schedules/:id` | Delete a schedule |
| GET | `/api/v1/workflow-runs` | List workflow runs |
| GET | `/api/v1/workflow-runs/:id` | Get workflow run with task statuses |
| POST/GET | `/api/v1/profiles` | Define / list profiles |
| GET/DELETE | `/api/v1/profiles/:name` | Get / delete profile |
| POST/GET | `/api/v1/webhooks` | Create / list webhooks |
| GET/DELETE | `/api/v1/webhooks/:id` | Get / delete webhook |
| GET | `/api/v1/webhooks/:id/deliveries` | Delivery history |
| GET | `/api/v1/teams/mine` | Info on the authenticated team |
| GET | `/api/v1/export` | Full team data export (13 sections, secrets redacted) |
| POST/GET | `/api/v1/inbound` | Manage inbound endpoints (auth-protected) |
| GET/DELETE | `/api/v1/inbound/:id` | Get / delete inbound endpoint |
| POST | `/api/v1/inbound/:endpoint_key` | Public receiver (no auth; HMAC optional) |
| GET | `/` | Dashboard (HTML, no auth) |
| GET | `/health` | Health check (no auth) |

Admin routes at `/admin/*` require `ADMIN_KEY`:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/teams` | Create team |
| GET | `/admin/teams` | List teams |
| POST | `/admin/teams/:id/keys` | Generate API key |
| DELETE | `/admin/teams/:id/keys` | Revoke keys |
| GET | `/admin/stats` | System stats |

## Docker Deployment

One-command deploy using the bundled `Dockerfile` (multi-stage `node:20-alpine`) and `docker-compose.yml`:

```bash
docker compose up -d --build
```

The compose file ships a healthcheck and a named volume so the SQLite database persists across container rebuilds. See [examples/docker-deploy.md](examples/docker-deploy.md) for env var overrides, reverse-proxy setup, and backup tips.

## Configuration

All via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `DB_PATH` | `./data/lattice.db` | SQLite database path |
| `ADMIN_KEY` | — | Admin API auth (empty = admin disabled) |
| `TASK_REAP_TIMEOUT_MINUTES` | `30` | Minutes before abandoned task recovery |
| `EVENT_RETENTION_DAYS` | `30` | Event retention (0 = keep forever) |
| `AGENT_HEARTBEAT_TIMEOUT_MINUTES` | `10` | Minutes before agent marked offline |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | auto | `json` (default non-TTY) or `pretty` (default TTY) |
| `METRICS_ENABLED` | `true` | Expose `/metrics` Prometheus endpoint |
| `AUDIT_ENABLED` | `true` | Record mutating requests to `audit_log` |
| `AUDIT_RETENTION_DAYS` | `365` | Audit retention (0 = keep forever) |
| `RATE_LIMIT_PER_MIN` | `300` | Per-key rate limit (0 = disabled) |
| `MAX_BODY_BYTES` | `1048576` | Max request body (0 = disabled) |
| `HSTS_ENABLED` | `false` | Send `Strict-Transport-Security` header |

## Enterprise-ready

- **Structured JSON logs** with auto-redaction of API keys, bearer tokens, JWTs,
  cloud credentials, and private keys — safe to forward anywhere.
- **X-Request-ID** on every request, echoed in responses, in every log line,
  and in the audit trail.
- **Prometheus metrics** at `/metrics` (counters, histograms, gauges) — no auth,
  scrape it with anything.
- **Liveness & readiness probes** at `/healthz` and `/readyz` for containers.
- **Append-only audit log** of every mutating request with admin query API.
- **API key lifecycle**: scopes (read/write/admin), expiry, rotation, revocation,
  `last_used_at` tracking, keys stored as SHA-256 hashes.
- **Rate limiting**, **body-size limits**, and **security response headers** on by default.

See [OBSERVABILITY.md](./OBSERVABILITY.md) and [SECURITY.md](./SECURITY.md) for details.

## Dog-Food Proof

Lattice was built and tested by agent teams coordinating through Lattice itself. Four rounds of live dog-fooding with real multi-agent workloads:

| Round | Agents | What Happened |
|-------|--------|---------------|
| **1. Market Research** | 3 | Produced 15 competitive profiles, monetization analysis, 5-domain technical review |
| **2. DX Sprint** | 5 | Built 4 new MCP tools, auto-registration, agent preamble templates |
| **3. QA Verification** | 1 | 14/15 sub-tests passed, found FTS edge case and registry gap |
| **4. Landing Page** | 3 | End-to-end content pipeline via direct messaging, 3 bugs caught and fixed in-session |

**Totals:** 154+ events, 53+ context entries, 40+ tasks (12+ completed), 9+ agents coordinated, **391 tests passing** across 34 test files.

The claim-before-work pattern eliminated duplicate effort across agents. The shared context store let agents build on each other's findings across sessions. Direct messaging enabled clean handoff patterns (researcher -> designer -> reviewer).

## Compound Workflows

The highest-leverage pattern combines four primitives:

- **Profiles** — named reusable role definitions (system prompt + defaults)
- **Playbooks** — named task templates with dependency wiring
- **WorkflowRuns** — first-class tracking of a playbook execution
- **Artifacts** — typed, keyed file storage separate from context

Together they produce reusable multi-agent pipelines. A canonical fan-out / fan-in walkthrough is in [examples/compound-workflow.md](examples/compound-workflow.md). Other examples: [quick-start.md](examples/quick-start.md), [research-team.md](examples/research-team.md), [dev-pipeline.md](examples/dev-pipeline.md).

## License

MIT
