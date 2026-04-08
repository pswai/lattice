# Architecture

Lattice is an MCP-native coordination layer for AI agent teams. It provides persistent state, task management, messaging, and automation through three interfaces: MCP tools (for AI agents), a REST API (for programmatic access), and a React dashboard (for human operators).

## System Overview

Lattice runs as a single process serving both MCP and HTTP traffic. Background services handle housekeeping (reaping stale tasks, delivering webhooks, executing scheduled playbooks). All state lives in SQLite (default) or PostgreSQL, with workspace-level tenant isolation.

```
                          Clients
                 +-----------+-----------+
                 |           |           |
            MCP Client   REST Client   Browser
                 |           |           |
                 v           v           v
         +-------+-----------+-----------+-------+
         |                  Hono                  |
         |  /mcp         /api/v1/*     /dashboard |
         +---+---------------+---------------+---+
             |               |               |
             v               v               v
     +-----------+    +-----------+    +-----------+
     | MCP Server|    |HTTP Routes|    |Static SPA |
     |  (per-req)|    |           |    |  (React)  |
     +-----+-----+    +-----+-----+    +-----------+
           |               |
           v               v
     +-----------+   +-----------+
     |   Tool    |   |  Route    |
     | Registry  |   | Handlers  |
     +-----+-----+   +-----+-----+
           |               |
           +-------+-------+
                   |
                   v
           +-------+-------+
           |    Models      |
           | (domain logic) |
           +-------+-------+
                   |
                   v
           +----------------+
           |   DbAdapter    |
           | SQLite|Postgres |
           +----------------+
                   |
                   v
              [Database]

     Background Services (independent loops):
       task-reaper | event-cleanup | webhook-dispatcher
       scheduler   | audit-cleanup
```

## Component Diagram

```
src/
  index.ts              Entry point: init DB, HTTP, MCP, start services
  config.ts             Env-based configuration (AppConfig)
  cli.ts                CLI argument parsing

  mcp/
    server.ts           MCP server factory, assembles all tool groups
    auth-context.ts     AsyncLocalStorage for per-request auth (workspace, agent, scope)
    tools/
      types.ts          ToolDefinition, ToolContext, ToolTier
      registry.ts       Registration loop: validation, audit, secret scan, error handling
      context.ts        save_context, get_context (FTS5 search)
      tasks.ts          create_task, update_task, list_tasks, get_task, get_task_graph
      events.ts         broadcast, get_updates, wait_for_event
      agents.ts         register_agent, list_agents, heartbeat
      messages.ts       send_message, get_messages
      automation.ts     define_playbook, run_playbook, define_schedule, define_inbound_endpoint, ...
      observe.ts        get_analytics, define_profile, export_workspace_data
      artifacts.ts      save_artifact, get_artifact, list_artifacts
      helpers.ts        arrayParam() for MCP client array stringification

  http/
    app.ts              Hono app: middleware stack, route mounting, SPA fallback
    routes/             Route handlers per domain (context, tasks, events, ...)
    middleware/          Auth, rate-limit, audit, CORS, metrics

  models/               Domain logic per entity (context, tasks, agents, ...)
    types.ts            Shared TypeScript interfaces

  db/
    adapter.ts          DbAdapter interface, SqliteAdapter, PgAdapter, SQL dialect helpers
    connection.ts       Adapter factory, schema init, migrations
    schema.ts           SQLite DDL (tables, indexes, FTS5, triggers)

  services/
    task-reaper.ts      Auto-abandon claimed tasks past timeout
    event-cleanup.ts    Prune old events, mark stale agents offline
    webhook-dispatcher.ts  Deliver webhooks with exponential backoff
    scheduler.ts        Cron-based playbook execution
    audit-cleanup.ts    Prune old audit log entries
    secret-scanner.ts   Detect API keys/tokens before storage
    ssrf-guard.ts       Block webhooks to private IPs
    event-emitter.ts    Internal event bus for webhook triggering

  dashboard/            React SPA (built separately, served as static files)
```

## Data Flow

A complete MCP tool call traverses this path:

1. **Transport** -- An MCP client sends a JSON-RPC request to `POST /mcp`. Hono routes it to `createMcpServer()` in `src/http/app.ts`, which instantiates a fresh `McpServer` per request (stateless mode) using `WebStandardStreamableHTTPServerTransport`.

2. **Auth context** -- The HTTP middleware extracts the API key, resolves the workspace and agent identity, and stores the `AuthContext` in `AsyncLocalStorage` (`src/mcp/auth-context.ts`). This makes `workspaceId`, `agentId`, and `scope` available to any downstream code without parameter drilling.

3. **Tool registry** -- `registerTools()` in `src/mcp/tools/registry.ts` has already registered each `ToolDefinition` with the MCP SDK. The SDK dispatches the call to the matching handler. Before invoking the handler, the registry:
   - Filters by enabled tier (`LATTICE_TOOLS` env var)
   - Validates write scope if `tool.write === true`
   - Auto-registers the agent if `tool.autoRegister === true`
   - Scans designated fields for secrets if `tool.secretScan` is set

4. **Handler** -- The tool handler receives a `ToolContext` (`{ db, workspaceId, agentId }`) and validated params. It calls into the appropriate model function.

5. **Model** -- Model functions in `src/models/` execute business logic and issue SQL through the `DbAdapter` interface.

6. **Database** -- `DbAdapter` (`src/db/adapter.ts`) abstracts SQLite vs Postgres. Dialect-aware helpers rewrite `?` placeholders to `$1, $2, ...` and translate SQLite idioms (`INSERT OR IGNORE`) to Postgres equivalents (`ON CONFLICT DO NOTHING`).

7. **Response** -- The handler returns a result object. The registry wraps it as a JSON text content block, writes an audit log entry, and the MCP SDK serializes the JSON-RPC response back to the client.

HTTP REST calls follow a similar path but skip the MCP SDK layer: Hono middleware handles auth and rate limiting, route handlers call model functions directly, and JSON responses are returned.

## Database Schema Design

### Multi-tenant workspace model

Every row in every table carries a `workspace_id` foreign key. Workspace isolation is enforced at the query level -- all model functions scope queries by workspace. API keys are scoped to a workspace with a permission level (`read`, `write`, `admin`).

### Key tables

| Table | Purpose |
|-------|---------|
| `workspaces` | Tenant container |
| `api_keys` | Authentication with scope (read/write/admin), expiry, revocation |
| `context_entries` | Shared knowledge base (key-value with tags) |
| `context_entries_fts` | FTS5 virtual table with trigram tokenizer for substring search |
| `events` | Event bus (LEARNING, BROADCAST, ESCALATION, ERROR, TASK_UPDATE) |
| `tasks` | Work items with status lifecycle, priority (P0-P3), assignment |
| `task_dependencies` | DAG edges between tasks |
| `agents` | Agent registry with capabilities, heartbeat tracking |
| `messages` | Agent-to-agent direct messages |
| `playbooks` | Reusable task templates (JSON step definitions) |
| `workflow_runs` | Playbook execution tracking |
| `artifacts` | Typed file storage (HTML, JSON, code; max 1MB) |
| `agent_profiles` | Reusable agent roles with system prompts |
| `webhooks` | Outbound HTTP webhook subscriptions |
| `webhook_deliveries` | Delivery attempts with retry state |
| `schedules` | Cron-based playbook triggers |
| `inbound_endpoints` | Public webhook receivers (keyed URLs, no auth required) |
| `audit_log` | Append-only audit trail of all mutations |

### Full-text search

`context_entries_fts` is an FTS5 virtual table using a trigram tokenizer. It indexes the `key`, `value`, and `tags` columns, enabling substring and fuzzy matching on knowledge base entries. The FTS index is kept in sync via triggers on `context_entries`.

### Schema evolution

Schema changes use additive column migrations (`ALTER TABLE ADD COLUMN`) executed at startup in `src/db/connection.ts`. This avoids a migration framework while keeping upgrades safe and idempotent.

## Tool Registry Pattern

The tool system is built around a declarative `ToolDefinition` type (`src/mcp/tools/types.ts`):

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;  // Zod schemas per parameter
  tier: ToolTier;                         // 'automation' | 'persist' | 'coordinate' | 'observe'
  write?: boolean;                        // Requires write scope
  autoRegister?: boolean;                 // Auto-register calling agent
  secretScan?: string[];                  // Fields to scan for leaked secrets
  handler: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>;
}
```

Each domain file (`context.ts`, `tasks.ts`, `events.ts`, etc.) exports an array of `ToolDefinition` objects. `src/mcp/server.ts` assembles all arrays and passes them to `registerTools()`.

`registerTools()` in `src/mcp/tools/registry.ts` iterates over definitions and registers each with the MCP SDK. The registration loop is the single place that handles cross-cutting concerns:

- **Tier filtering** -- Tools are only registered if their tier is in the enabled set (controlled by `LATTICE_TOOLS` env var, defaults to `all`).
- **Auth enforcement** -- Write-scoped tools check that the API key has write or admin scope.
- **Agent auto-registration** -- Tools marked `autoRegister` upsert the calling agent into the `agents` table on first use.
- **Secret scanning** -- Designated fields are scanned for API keys, tokens, and credentials before storage.
- **Audit logging** -- A `TOOL_AUDIT_MAP` maps tool names to resource/verb pairs for the audit log.
- **Error handling** -- `AppError` instances return structured error responses; unexpected errors are logged and re-thrown.

### Tool tiers

The `LATTICE_TOOLS` environment variable controls which tool groups are exposed:

| Tier | Tools | Use case |
|------|-------|----------|
| `persist` | context, tasks, artifacts | Storing and retrieving state |
| `coordinate` | events, agents, messages | Multi-agent communication |
| `automation` | playbooks, schedules, inbound endpoints | Workflow automation |
| `observe` | analytics, profiles, export | Monitoring and introspection |

Set `LATTICE_TOOLS=persist,coordinate` to expose only those tiers, or omit it for all tools.

## Background Services

Five background services run as interval-based loops, started in `src/index.ts`:

| Service | Interval | Purpose |
|---------|----------|---------|
| Task reaper | 60s | Abandon tasks claimed longer than 30min (configurable) |
| Event cleanup | 1h | Delete events older than 30 days, mark stale agents offline |
| Webhook dispatcher | 1s | Deliver pending webhooks with exponential backoff and HMAC signing |
| Scheduler | 30s | Run playbooks on cron schedules |
| Audit cleanup | 24h | Prune audit entries older than 365 days (configurable) |

All timers are `unref()`'d so they do not prevent process exit.

## Extensibility

### Adding a new MCP tool

1. Add a `ToolDefinition` object to the appropriate domain file in `src/mcp/tools/` (or create a new file for a new domain).
2. If creating a new file, import and spread the tools array into `src/mcp/server.ts`.
3. Add an entry to `TOOL_AUDIT_MAP` in `src/mcp/tools/registry.ts` if audit logging is desired.

No other wiring is needed -- the registration loop handles validation, auth, and error handling automatically.

### Adding a new HTTP route

1. Create a route file in `src/http/routes/`.
2. Mount it in `src/http/app.ts` under the appropriate auth boundary (public, API-key-authed, or admin-authed).

### Adding a new background service

1. Create a service file in `src/services/` that exports a start function returning `NodeJS.Timeout`.
2. Call it from `src/index.ts` alongside the existing services.

## Key Design Decisions

**Hono** -- Lightweight, Bun-compatible HTTP framework. Lattice targets both Node.js and Bun runtimes; Hono's standard Web API foundation makes this possible without adapter complexity.

**Zod** -- Schema validation chosen for alignment with the MCP SDK, which uses Zod internally. Tool parameter schemas are Zod objects, eliminating a serialization boundary between tool definitions and the SDK.

**Zero-dep metrics and logger** -- `src/metrics.ts` exposes Prometheus-format counters and histograms without pulling in prom-client. `src/logger.ts` provides structured JSON logging without winston or pino. This keeps the dependency tree minimal -- the only runtime dependencies beyond Node built-ins are the MCP SDK, Hono, better-sqlite3, pg, and Zod.

**Stateless MCP per request** -- Each `/mcp` request creates a fresh `McpServer` instance. This avoids concurrency issues from shared server state and simplifies horizontal scaling.

**DbAdapter abstraction** -- A thin interface over better-sqlite3 and pg allows SQLite for development/single-node and Postgres for production, with dialect-aware SQL rewriting handling the differences transparently.

**AsyncLocalStorage for auth** -- MCP tool handlers receive auth context implicitly via `AsyncLocalStorage` rather than explicit parameter passing. This keeps the `ToolContext` interface clean while ensuring every handler has access to workspace and agent identity.

**Additive migrations** -- Schema changes are `ALTER TABLE ADD COLUMN` statements run at startup, wrapped in try/catch to be idempotent. This avoids the complexity of a migration framework for a schema that evolves additively.
