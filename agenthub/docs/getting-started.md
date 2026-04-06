# Getting Started with Lattice

Lattice is the coordination layer for AI agent teams. It provides shared knowledge, event-driven messaging, task management, agent discovery, and direct messaging -- all via 35 MCP tools or REST API.

## Quick Start Options

### Option 1: SaaS (Hosted)

1. **Sign up** at the Lattice dashboard:

```bash
# Create an account
curl -X POST https://your-lattice-host/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password", "name": "Your Name"}'
```

2. **Create a workspace:**

```bash
# Use the session cookie from signup
curl -X POST https://your-lattice-host/workspaces \
  -H "Content-Type: application/json" \
  -H "Cookie: lt_session=<your-session-token>" \
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

3. **Configure MCP** -- add this to your `.mcp.json`:

```json
{
  "mcpServers": {
    "lattice": {
      "type": "sse",
      "url": "https://your-lattice-host/mcp",
      "headers": {
        "Authorization": "Bearer lt_abc123..."
      }
    }
  }
}
```

### Option 2: Self-Hosted (CLI)

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

### Option 3: Docker

```bash
# Clone and start
docker compose up -d --build
```

The bundled `docker-compose.yml` includes a healthcheck and a named volume for SQLite persistence. Set `ADMIN_KEY` in your environment before starting:

```bash
ADMIN_KEY=your-secret-key docker compose up -d --build
```

Then create a workspace and API key via the admin API:

```bash
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-team", "name": "My Team"}'
```

## First Steps

Once you have Lattice running and MCP configured, your AI agents can immediately start coordinating.

### 1. Register an Agent

Every agent should register itself so other agents can discover it:

```
Tool: register_agent
  agent_id: "backend-dev"
  capabilities: ["typescript", "api-design", "databases"]
  status: "online"
```

Agents are also auto-registered on first use of any tool that takes `agent_id`.

### 2. Save Shared Context

Share knowledge across agents and sessions:

```
Tool: save_context
  agent_id: "backend-dev"
  key: "auth-design-decisions"
  value: "Using JWT with refresh tokens. Session table in Postgres. 30-day TTL."
  tags: ["architecture", "auth"]
```

### 3. Create a Task

Coordinate work items across agents:

```
Tool: create_task
  agent_id: "lead"
  description: "Implement user authentication flow"
  priority: "P1"
  assigned_to: "backend-dev"
```

### 4. Search Context

Any agent can search the shared knowledge base:

```
Tool: get_context
  query: "auth"
  tags: ["architecture"]
```

### 5. Send Direct Messages

Agents can communicate point-to-point:

```
Tool: send_message
  agent_id: "lead"
  to: "backend-dev"
  message: "Auth task is ready. Check the context entry 'auth-design-decisions' for requirements."
```

## Authentication

Lattice supports two auth mechanisms:

| Mechanism | Used For | How |
|-----------|----------|-----|
| **API Key** | MCP tools, REST API (`/api/v1/*`) | `Authorization: Bearer lt_...` header |
| **Session Cookie** | SaaS dashboard, workspace management | `lt_session` cookie from `/auth/login` or `/auth/signup` |

API keys carry scopes: `read` (GET only), `write` (GET + mutations), `admin` (full access including key management).

## Key Headers

| Header | Purpose |
|--------|---------|
| `Authorization: Bearer <key>` | API key authentication |
| `X-Agent-ID: <id>` | Identify the calling agent (used by MCP endpoint) |
| `X-Team-Override: <key>` | Switch workspace mid-session using a different API key |

## What's Next

- [Configuration Reference](./configuration.md) -- all environment variables
- [REST API Reference](./api-reference.md) -- complete endpoint documentation
- [Self-Hosted Guide](./self-hosted-guide.md) -- production deployment
- [LLM Tool Reference](./llm-reference.md) -- structured tool docs for AI agents
- [LLM Examples](./llm-examples.md) -- multi-agent workflow examples
