# Changelog

All notable changes to Lattice will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

Complete rewrite. Lattice is now a durable, push-first message bus for AI agent communication. See [MANIFESTO.md](MANIFESTO.md) and [RFC 0002](docs/rfcs/0002-lattice-as-a-message-bus.md) for the design rationale.

### Added
- **Broker core** — WebSocket server with SQLite (WAL) persistence, at-least-once delivery, per-recipient FIFO ordering, monotonic cursor, topic routing, back-pressure via inbox limits
- **Wire protocol** — 4 client ops (`hello`, `send`, `subscribe`, `ack`), 4 server ops (`welcome`, `message`, `gap`, `error`), versioned at protocol_version 1
- **TypeScript SDK** (`packages/sdk-ts`) — `Bus` client with auto-reconnect (exponential backoff + jitter), `messages()` async iterator, `request()` with correlation IDs, idempotency dedup via LRU
- **Claude Code channel shim** (`packages/shim-claude-code`) — MCP server with real push via `notifications/claude/channel`, `lattice_send_message` and `lattice_subscribe` tools
- **Generic MCP long-poll shim** (`packages/shim-mcp`) — MCP server with `lattice_wait`, `lattice_send_message`, and `lattice_subscribe` tools for any MCP host
- **Webhook dispatcher** — HTTP POST delivery with HMAC-SHA256 signatures, exponential backoff retry, dead-letter recording on permanent failure
- **CLI** — `lattice init`, `lattice start`, `lattice token create`, `lattice token revoke`
- **Auth** — per-agent bearer tokens (SHA-256 hashed storage), admin/agent scopes, immediate revocation
- **Replay on reconnect** — configurable replay cap (1000 messages or 5 min wallclock), `gap` op when exceeded
- **Retention cleanup** — daily job with configurable retention (7d–forever), dead-letter recording for unacked messages
- **Observability** — `/healthz`, `/readyz`, `/bus_stats` endpoints, structured JSON logging to stderr
- **Fault injection harness** — 100-iteration randomized test suite (kill broker mid-flight, verify no message loss)
- **148 unit/integration tests** across 18 test files

### Removed
- All v0.1 components: 35 MCP tools, React dashboard, REST API, Hono server, task coordination, playbooks, knowledge base, agent registry, cron scheduling, Postgres backend, Docker deployment
- v0.1 documentation (api-reference, llm-reference, llm-examples, agent-protocol, agent-preamble, use-cases, getting-started, configuration, self-hosted-guide, architecture, observability, security)

### Changed
- Project identity: from "operations platform for AI agent workflows" to "primary communication channel for AI agents"
- Storage: single SQLite file per workspace (no Postgres)
- Auth: bearer tokens per agent (no API key scopes)
- Protocol: WebSocket (no HTTP/REST)

## [0.1.0] - 2026-04-07

### Added
- 35 MCP tools for AI agent coordination
- Shared knowledge base with full-text search (FTS5 trigram matching)
- Event bus with pub/sub, long-polling, and SSE streaming
- Task coordination with claim-before-work, DAG dependencies, and priority levels
- Agent registry with capability discovery and heartbeat presence
- Direct agent-to-agent messaging
- Artifact storage (HTML, JSON, code, markdown) up to 1 MB
- Playbooks: reusable task templates with variable substitution
- Cron scheduling for automated playbook execution
- Workflow run tracking for playbook executions
- Agent profiles: reusable role definitions with system prompts
- Inbound webhooks: receive events from GitHub, PagerDuty, etc.
- Outbound webhooks with exponential backoff retry
- Analytics: aggregated team metrics over configurable time windows
- Full workspace data export (secrets auto-redacted)
- React dashboard with Overview, Task Graph, Artifacts, and Playbooks tabs
- SQLite (WAL mode) and PostgreSQL dual-backend support
- API key authentication with read/write/admin scopes
- Rate limiting (per-key and per-workspace)
- Audit logging with configurable retention
- Secret scanning (20+ patterns) blocks credentials from shared state
- SSRF guard for outbound webhook URLs
- Prometheus metrics endpoint
- Docker and docker-compose deployment
- CLI: `lattice init`, `lattice start`, `lattice status`
- Comprehensive documentation: API reference, LLM reference, examples
