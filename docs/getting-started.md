# Getting Started with Lattice

Lattice is an open-source (MIT) coordination layer for AI agent teams. It provides shared knowledge, event-driven messaging, task management, agent discovery, and direct messaging -- all via 35 MCP tools or REST API.

## Prerequisites

- **Node.js 18+** (for npm install or building from source)
- **Docker 20.10+** and Docker Compose v2 (for Docker install)
- A shell with `curl` for the setup commands below

## Installation

### Option 1: npm (quickest)

```bash
npx lattice init
```

This interactive wizard prompts for workspace name, ID, database path, and port. It creates the SQLite database, inserts the workspace, generates an API key, and outputs a `.mcp.json` snippet.

```bash
npx lattice start   # Start the server
npx lattice status  # Check health
```

### Option 2: Docker (recommended for production)

```bash
git clone https://github.com/pswai/lattice.git
cd lattice
ADMIN_KEY=your-secret-key docker compose up -d --build
```

The bundled `docker-compose.yml` includes a healthcheck and a bind mount (`./data`) for SQLite persistence.

### Option 3: From source

```bash
git clone https://github.com/pswai/lattice.git
cd lattice
npm install
npm run build
ADMIN_KEY=your-secret-key node dist/index.js
```

## Creating a Team and API Key

If you used `npx lattice init`, your team and API key were created automatically. For Docker or from-source installs, use the admin API:

```bash
# Create a team
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-team", "name": "My Team"}'
```

The response includes your API key (prefixed `lt_`):

```json
{
  "workspace_id": "my-team",
  "name": "My Team",
  "api_key": "lt_abc123...",
  "scope": "write",
  "role": "owner"
}
```

**Save the `api_key`** -- it is shown only once. If you lose it, generate a new one:

```bash
curl -X POST http://localhost:3000/admin/teams/my-team/keys \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"label": "dev", "scope": "write"}'
```

## Configuring MCP

Add this to your `.mcp.json` (used by Claude Code, Cursor, and other MCP clients):

```json
{
  "mcpServers": {
    "lattice": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer lt_abc123...",
        "X-Agent-ID": "my-agent"
      }
    }
  }
}
```

The `Authorization` header carries your workspace API key. The `X-Agent-ID` header sets a default agent identity (individual tool calls can override it via the `agent_id` parameter).

## First MCP Tool Calls

Once MCP is configured, your AI agents can immediately start coordinating.

### 1. Register an Agent

```
Tool: register_agent
  agent_id: "backend-dev"
  capabilities: ["typescript", "api-design", "databases"]
  status: "online"
```

Agents are also auto-registered on first use of any tool that takes `agent_id`.

### 2. Save Shared Context

```
Tool: save_context
  agent_id: "backend-dev"
  key: "auth-design-decisions"
  value: "Using JWT with refresh tokens. Session table in Postgres. 30-day TTL."
  tags: ["architecture", "auth"]
```

### 3. Create a Task

```
Tool: create_task
  agent_id: "lead"
  description: "Implement user authentication flow"
  priority: "P1"
  assigned_to: "backend-dev"
```

### 4. Search Context

```
Tool: get_context
  query: "auth"
  tags: ["architecture"]
```

### 5. Send Direct Messages

```
Tool: send_message
  agent_id: "lead"
  to: "backend-dev"
  message: "Auth task is ready. Check the context entry 'auth-design-decisions' for requirements."
```

## Authentication

API keys carry scopes: `read` (GET only), `write` (GET + mutations), `admin` (full access including key management).

| Header | Purpose |
|--------|---------|
| `Authorization: Bearer <key>` | API key authentication |
| `X-Agent-ID: <id>` | Identify the calling agent (used by MCP endpoint) |
| `X-Team-Override: <key>` | Switch workspace mid-session using a different API key |

## Configuring AI Agents

For best results, teach your AI agents how to use Lattice by adding instructions to their configuration files.

### Claude Code (CLAUDE.md)

Add a section to your project's `CLAUDE.md`:

```markdown
## Lattice Coordination

You have access to Lattice MCP tools for team coordination. Follow this protocol:

1. On startup: register with `register_agent`, check `get_updates` and `list_tasks` for context
2. Before starting work: search `get_context` to see if another agent already covered the topic
3. Save important findings with `save_context` using descriptive keys and generous tags
4. Create tasks with `create_task` and mark them done with `update_task` when complete
5. Broadcast important discoveries with `broadcast(event_type: "LEARNING")`
6. For long-running work: call `heartbeat` periodically to stay online
```

### Other MCP Clients (AGENTS.md)

For Cursor, Windsurf, or other MCP clients, add equivalent instructions to `AGENTS.md` or your client's configuration file. The same protocol applies.

### Comprehensive Template

For a more detailed agent instruction template covering all tool categories, anti-patterns, and best practices, see [Agent Preamble](./agent-preamble.md).

## What's Next

- [Configuration Reference](./configuration.md) -- all environment variables
- [REST API Reference](./api-reference.md) -- complete endpoint documentation
- [LLM Tool Reference](./llm-reference.md) -- structured tool docs for AI agents
- [LLM Examples](./llm-examples.md) -- multi-agent workflow examples
- [Self-Hosted Guide](./self-hosted-guide.md) -- production deployment
- [Use Cases](./use-cases.md) -- 13 scenarios across individuals, teams, and enterprises
