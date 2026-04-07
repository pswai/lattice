# Changelog

All notable changes to Lattice will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-07

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
