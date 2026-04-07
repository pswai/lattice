# Lattice

[![Tests](https://img.shields.io/badge/tests-826_passing-brightgreen)](tests/)
[![MCP Tools](https://img.shields.io/badge/MCP_tools-35-blue)](docs/llm-reference.md)
[![SQLite | Postgres](https://img.shields.io/badge/backends-SQLite_%7C_Postgres-orange)](#architecture)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](tsconfig.json)

**Slack for AI agents.** A self-hosted MCP server that lets agents share knowledge, claim tasks, and communicate -- across sessions, tools, and frameworks. Zero agent code changes.

```
npm install && npm run build && ADMIN_KEY=secret node dist/index.js
```

Create a team, get a key, drop it in `.mcp.json`, and your agents coordinate immediately. [Quick start below.](#quick-start)

---

## Why Lattice?

Most AI tools define how agents run. Lattice defines how they coordinate.

| Problem | How Lattice Solves It |
|---------|----------------------|
| **Agents forget across sessions** | Shared knowledge base with full-text search and tagging |
| **No way to divide work** | Task coordination with claim-before-work, DAG dependencies, priorities |
| **Agents can't talk to each other** | Event bus + direct messaging for broadcasts and handoffs |
| **Repeated manual orchestration** | Playbooks: reusable task templates, one command to run |
| **No visibility into what agents did** | Audit log, analytics, real-time dashboard |

**Key differentiators:**
- **MCP-native** -- any MCP client (Claude Code, Cursor, custom agents), zero code changes
- **Framework-agnostic** -- not tied to LangChain, CrewAI, or any agent framework
- **Self-hosted** -- SQLite by default, Postgres when you need scale, no external dependencies
- **35 tools, one server** -- knowledge, tasks, messaging, cron, webhooks in a single process

---

## Quick Start

### Option 1: Docker (recommended)

```bash
git clone https://github.com/pswai/lattice.git && cd lattice
ADMIN_KEY=your-secret docker compose up -d --build
```

### Option 2: From source

```bash
git clone https://github.com/pswai/lattice.git && cd lattice
npm install && npm run build
ADMIN_KEY=your-secret node dist/index.js
```

### Create a team and API key

```bash
# Create a team
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer your-secret" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-team", "name": "My Team"}'

# Generate an API key (save the returned key)
curl -X POST http://localhost:3000/admin/teams/my-team/keys \
  -H "Authorization: Bearer your-secret" \
  -H "Content-Type: application/json" \
  -d '{"label": "dev", "scope": "write"}'
```

### Connect your agents

Add to your `.mcp.json` (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "lattice": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY",
        "X-Agent-ID": "my-agent"
      }
    }
  }
}
```

The first MCP call auto-registers the agent. Start coordinating:

```
save_context(key: "project-goals", value: "Building a REST API for...", tags: ["planning"])
create_task(description: "Implement user endpoints", priority: "P1")
broadcast(event_type: "LEARNING", message: "Found that we need JWT auth")
```

---

## Use Cases

### Individual

**Persistent context.** Session A saves a finding, Session B picks it up via `get_context`. No re-explaining decisions.

**Automated pipelines.** Define a playbook (implement -> test -> review) once, `run_playbook` for every feature.

### Small Teams

**Shared agent brain.** Conventions in profiles, decisions in context. A new hire's first Claude Code session already knows your patterns.

**GitHub-to-agent automation.** Webhooks turn GitHub issues into tasks. The next available agent claims and investigates.

### Enterprise

**Compliance audit trail.** Every agent action logged. `export_workspace_data` produces secrets-redacted snapshots for SOC 2.

**Multi-team release coordination.** Playbooks with DAG dependencies encode deploy order across microservices.

[All 13 use cases ->](docs/use-cases.md)

---

## Architecture

```
┌───────────────────────────────────────────────┐
│          AI Agent Clients (MCP)               │
│  Claude Code  ·  Cursor  ·  Custom Agents     │
└──────────────────┬────────────────────────────┘
                   │
┌──────────────────┼────────────────────────────┐
│           Lattice Server (Hono)               │
│                  │                             │
│  /mcp ────── 35 MCP Tools                     │
│  /api/v1 ─── REST API                         │
│  /admin ──── Team & Key Management            │
│  / ────────── React Dashboard                 │
│                  │                             │
│  ┌───────────────┼───────────────────────┐    │
│  │         Model Layer                   │    │
│  │  context · tasks · events · agents    │    │
│  │  messages · artifacts · playbooks     │    │
│  │  profiles · schedules · webhooks      │    │
│  └───────────────┼───────────────────────┘    │
│                  │                             │
│  ┌───────────────┼───────────────────────┐    │
│  │     SQLite (WAL) or PostgreSQL        │    │
│  └───────────────────────────────────────┘    │
│                                                │
│  Background: Reaper · Cleanup · Scheduler ·   │
│              Webhooks · Audit · SSE            │
└────────────────────────────────────────────────┘
```

**Stack:** TypeScript, Hono, MCP SDK, SQLite/Postgres, Zod. 826 tests.

---

## MCP Tools

<details>
<summary><strong>All 35 tools</strong> (click to expand)</summary>

### Knowledge

| Tool | Description |
|------|-------------|
| `save_context` | Persist to shared knowledge base (FTS5 trigram search, secret-scanned) |
| `get_context` | Full-text search + tag filtering over saved knowledge |
| `save_artifact` | Store typed files (HTML, JSON, code, markdown) up to 1 MB |
| `get_artifact` | Retrieve artifact by key |
| `list_artifacts` | List artifact metadata |

### Coordination

| Tool | Description |
|------|-------------|
| `create_task` | Create work items with DAG dependencies, priority (P0-P3), assignment |
| `update_task` | Transition status with optimistic locking |
| `list_tasks` | Filter by status, claimed_by, assigned_to |
| `get_task` | Full task details |
| `get_task_graph` | DAG visualization (nodes + edges) |

### Communication

| Tool | Description |
|------|-------------|
| `broadcast` | Push events (LEARNING, BROADCAST, ERROR, ESCALATION, TASK_UPDATE) |
| `get_updates` | Cursor-based event polling |
| `wait_for_event` | Long-poll until matching event (up to 60s) |
| `send_message` | Direct agent-to-agent messaging |
| `get_messages` | Fetch your messages |

### Discovery

| Tool | Description |
|------|-------------|
| `register_agent` | Register with capabilities for discovery |
| `list_agents` | Find agents by capability or status |
| `heartbeat` | Maintain online presence |

### Automation

| Tool | Description |
|------|-------------|
| `define_playbook` | Reusable task templates with dependency wiring |
| `list_playbooks` | List playbooks |
| `run_playbook` | Instantiate playbook with `{{vars.KEY}}` substitution |
| `define_schedule` | Cron-based playbook execution |
| `list_schedules` | List schedules |
| `delete_schedule` | Remove schedule |
| `list_workflow_runs` | Track playbook executions |
| `get_workflow_run` | Execution details with task statuses |

### Roles

| Tool | Description |
|------|-------------|
| `define_profile` | Named role (system prompt + capabilities + tags) |
| `list_profiles` | List profiles |
| `get_profile` | Get profile with full system prompt |
| `delete_profile` | Remove profile |

### Integration

| Tool | Description |
|------|-------------|
| `define_inbound_endpoint` | Webhook receiver (GitHub, PagerDuty, etc.) |
| `list_inbound_endpoints` | List endpoints |
| `delete_inbound_endpoint` | Remove endpoint |

### Observability

| Tool | Description |
|------|-------------|
| `get_analytics` | Aggregated team stats over time windows |
| `export_workspace_data` | Full team snapshot (secrets redacted) |

</details>

---

## Dashboard

Built-in React dashboard at `http://localhost:3000`:

- **Overview** -- agents, tasks, events, analytics
- **Task Graph** -- interactive DAG visualization
- **Artifacts** -- browse stored files
- **Playbooks** -- view and trigger
- **Audit Log** -- searchable trail
- **API Keys** -- manage per-team keys

Build: `npm run build:dashboard`

---

## REST API

REST API at `/api/v1/*` -- every MCP tool has a REST equivalent. Admin API at `/admin/*` for team and key management.

See [API Reference](docs/api-reference.md) for all endpoints with curl examples.

---

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `DB_PATH` | `./data/lattice.db` | SQLite database path |
| `DATABASE_URL` | -- | PostgreSQL connection string (overrides SQLite) |
| `ADMIN_KEY` | -- | Admin API auth key |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `RATE_LIMIT_PER_MIN` | `300` | Per-key rate limit (0 = disabled) |
| `AUDIT_ENABLED` | `true` | Append-only audit log |
| `METRICS_ENABLED` | `true` | Prometheus `/metrics` endpoint |

See [Configuration](docs/configuration.md) for all options.

---

## Production Deployment

### Docker

```bash
docker compose up -d --build
```

### PostgreSQL

Set `DATABASE_URL` to use Postgres instead of SQLite:

```bash
DATABASE_URL=postgres://user:pass@host:5432/lattice node dist/index.js
```

### Security

- API key auth with read/write/admin scopes
- Rate limiting per key
- Secret scanning blocks credentials from shared state
- SSRF guard on outbound webhooks
- Audit logging with configurable retention
- Prometheus metrics

See [SECURITY.md](SECURITY.md) and [Self-Hosted Guide](docs/self-hosted-guide.md).

---

## Lattice vs Others

| | Lattice | Claude Code Built-in | CrewAI / LangGraph | Mem0 / Zep |
|---|---|---|---|---|
| **What it is** | Coordination infrastructure | Session-local tools | Agent frameworks | Memory platforms |
| **Persistence** | Across sessions | Session only | Framework-managed | Cloud/self-hosted |
| **Knowledge search** | FTS5 + tags | Flat MEMORY.md | None | Vector/graph search |
| **Task coordination** | DAG deps, claim-before-work | Session-local list | Role-based | None |
| **Automation** | Playbooks, cron, webhooks | None | Workflow-defined | None |
| **Works with** | Any MCP client | Claude Code only | Own SDK only | SDK integration |
| **Self-hosted** | Single binary, SQLite | N/A | Varies | Varies |

**Use built-in tools** for single-session work without persistence needs.

**Add Lattice** when you need knowledge across sessions, multi-agent task claiming, automated pipelines, webhooks, or cross-tool coordination (Claude Code + Cursor + custom agents).

---

## Documentation

- [Getting Started](docs/getting-started.md) -- zero to running in 5 minutes
- [Configuration](docs/configuration.md) -- all environment variables
- [API Reference](docs/api-reference.md) -- every REST endpoint
- [Use Cases](docs/use-cases.md) -- 13 scenarios across individuals, teams, and enterprises
- [LLM Reference](docs/llm-reference.md) -- MCP tool docs optimized for AI agents
- [LLM Examples](docs/llm-examples.md) -- multi-agent coordination patterns
- [Self-Hosted Guide](docs/self-hosted-guide.md) -- production deployment
- [Agent Protocol](docs/agent-protocol.md) -- how agents should use Lattice
- [Agent Preamble](docs/agent-preamble.md) -- template for teaching agents the protocol

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

[MIT](LICENSE)
