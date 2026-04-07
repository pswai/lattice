# Getting Started with Lattice

Lattice is an open-source (MIT) coordination layer for AI agent teams. It provides shared knowledge, event-driven messaging, task management, agent discovery, and direct messaging -- all via 35 MCP tools or REST API.

## Quick Start (npm)

1. **Initialize:**

```bash
npx lattice init
```

This interactive wizard prompts for workspace name, ID, database path, and port. It creates the SQLite database, inserts the workspace, generates an API key, and outputs a `.mcp.json` snippet.

2. **Start the server:**

```bash
npx lattice start
```

3. **Check status:**

```bash
npx lattice status
```

## Docker

```bash
# Clone and start
git clone https://github.com/pswai/lattice.git
cd lattice
ADMIN_KEY=your-secret-key docker compose up -d --build
```

The bundled `docker-compose.yml` includes a healthcheck and a bind mount (`./data`) for SQLite persistence.

Then create a team and API key via the admin API:

```bash
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

## Building from Source

```bash
git clone https://github.com/pswai/lattice.git
cd lattice
npm install
npm run build
npm start
```

## Configure MCP

Add this to your `.mcp.json`:

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

## What's Next

- [Configuration Reference](./configuration.md) -- all environment variables
- [REST API Reference](./api-reference.md) -- complete endpoint documentation
- [LLM Tool Reference](./llm-reference.md) -- structured tool docs for AI agents
- [LLM Examples](./llm-examples.md) -- multi-agent workflow examples
