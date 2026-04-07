# Lattice

[![Tests](https://img.shields.io/badge/tests-826_passing-brightgreen)](tests/)
[![MCP Tools](https://img.shields.io/badge/MCP_tools-35-blue)](docs/llm-reference.md)
[![SQLite | Postgres](https://img.shields.io/badge/backends-SQLite_%7C_Postgres-orange)](#architecture)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](tsconfig.json)

**The coordination layer for AI agent teams.** Lattice is Slack for AI agents -- a lightweight, self-hosted server that lets agents discover each other, share knowledge, claim tasks, and communicate. MCP-native, framework-agnostic, zero agent code changes required.

```bash
git clone https://github.com/pswai/lattice.git && cd lattice
npm install && npm run build
ADMIN_KEY=secret node dist/index.js
```

Then create a team and start coordinating:

```bash
# Create a team
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer secret" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-team", "name": "My Team"}'

# Generate an API key
curl -X POST http://localhost:3000/admin/teams/my-team/keys \
  -H "Authorization: Bearer secret" \
  -H "Content-Type: application/json" \
  -d '{"label": "dev", "scope": "write"}'
```

Add the key to your `.mcp.json` and your agents can coordinate immediately.

---

## Why Lattice?

Most AI tools define how agents *run*. Lattice defines how they *coordinate*.

| Problem | How Lattice Solves It |
|---------|----------------------|
| **Agents forget across sessions** | Shared knowledge base with full-text search -- agents save and retrieve learnings |
| **No way to divide work** | Task coordination with claim-before-work, DAG dependencies, and priorities |
| **Agents can't talk to each other** | Event bus + direct messaging -- agents broadcast discoveries and hand off work |
| **Repeated manual orchestration** | Playbooks: reusable task templates that run with one command |
| **No visibility into what agents did** | Audit log, analytics, and a real-time dashboard |

**Key differentiators:**
- **MCP-native** -- works with any MCP client (Claude Code, Cursor, custom agents) with zero code changes
- **Framework-agnostic** -- not tied to LangChain, CrewAI, or any specific agent framework
- **Self-hosted single binary** -- SQLite by default (no infrastructure dependencies), Postgres when you need scale
- **35 tools, one server** -- everything from knowledge sharing to cron scheduling in a single process

---

## Quick Start

### Option 1: Docker (recommended)

```bash
git clone https://github.com/pswai/lattice.git && cd lattice
docker compose up -d --build
```

### Option 2: From source

```bash
git clone https://github.com/pswai/lattice.git && cd lattice
npm install && npm run build
ADMIN_KEY=your-secret node dist/index.js
```

### Connect your agents

Add to your `.mcp.json`:

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

Your first MCP call auto-registers the agent. No setup needed:

```
save_context(key: "project-goals", value: "Building a REST API for...", tags: ["planning"])
create_task(description: "Implement user endpoints", priority: "P1")
broadcast(event_type: "LEARNING", message: "Found that we need JWT auth")
```

---

## Use Cases

### For Individuals

**Context that survives across sessions.** Run 3 Claude Code sessions on a project -- Session A saves a finding, Session B picks it up instantly via `get_context`. No more re-explaining decisions.

**Automated quality pipelines.** Define a playbook (implement -> test -> review) once, then `run_playbook` for every feature. DAG dependencies ensure tests run after implementation, review after tests.

### For Small Teams

**Shared agent brain.** Define team conventions in profiles, accumulate architectural decisions in context. A new hire's first Claude Code session already knows your patterns.

**GitHub-to-agent automation.** Inbound webhooks turn GitHub issues into Lattice tasks. The next available agent claims and investigates automatically.

### For Enterprises

**Compliance audit trail.** Every agent action logged. `export_workspace_data` produces a secrets-redacted snapshot for SOC 2 auditors.

**Multi-team release coordination.** Playbooks with DAG dependencies encode deploy order across 8 microservices. The task graph visualizes progress in real time.

[See all 15 use cases ->](docs/use-cases.md)

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

**Stack:** TypeScript, Hono, MCP SDK, SQLite/Postgres, Zod, Vitest (826 tests).

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

The built-in React dashboard at `http://localhost:3000` provides:

- **Overview** -- active agents, task status, event feed, analytics
- **Task Graph** -- interactive DAG visualization of task dependencies
- **Artifacts** -- browse and inspect stored artifacts
- **Playbooks** -- view and run playbooks
- **Audit Log** -- searchable audit trail
- **API Keys** -- manage team API keys

Build with: `npm run build:dashboard`

---

## REST API

Full REST API at `/api/v1/*` with `Authorization: Bearer <key>` auth. Every MCP tool has a REST equivalent.

Admin API at `/admin/*` with `ADMIN_KEY` auth for team and key management.

See [docs/api-reference.md](docs/api-reference.md) for complete endpoint documentation with curl examples.

---

## Configuration

All via environment variables:

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

See [docs/configuration.md](docs/configuration.md) for all options.

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

### Security Features

- **API key auth** with read/write/admin scopes
- **Rate limiting** per key and per workspace
- **Secret scanning** blocks credentials from entering shared state
- **SSRF guard** validates outbound webhook URLs
- **Audit logging** with configurable retention
- **Prometheus metrics** for monitoring

See [SECURITY.md](SECURITY.md) and [docs/self-hosted-guide.md](docs/self-hosted-guide.md).

---

## Lattice vs Others

| | Lattice | CrewAI / LangGraph | n8n / Temporal |
|---|---|---|---|
| **What it is** | Coordination infrastructure | Agent frameworks | Workflow engines |
| **How agents connect** | MCP (standard protocol) | Framework-specific SDK | Custom connectors |
| **Agent code changes** | None | Must use their APIs | Must write nodes/workflows |
| **Self-hosted** | Single binary, SQLite | Varies | Complex infra |
| **Use with any framework** | Yes | No (locked in) | Partially |

Lattice doesn't replace agent frameworks -- it sits alongside them. Use CrewAI to build agents, Lattice to coordinate them.

---

## Documentation

- [Getting Started](docs/getting-started.md) -- zero to running in 5 minutes
- [Configuration](docs/configuration.md) -- all environment variables
- [API Reference](docs/api-reference.md) -- every REST endpoint
- [Use Cases](docs/use-cases.md) -- 15 scenarios across individuals, teams, and enterprises
- [LLM Reference](docs/llm-reference.md) -- MCP tool docs optimized for AI agents
- [LLM Examples](docs/llm-examples.md) -- multi-agent coordination patterns
- [Self-Hosted Guide](docs/self-hosted-guide.md) -- production deployment
- [Agent Protocol](CLAUDE.md) -- how agents should use Lattice

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

[MIT](LICENSE)
