# Configuration Reference

All Lattice configuration is via environment variables. No config files needed. Lattice is self-hosted only.

## Server

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | HTTP server port |
| `NODE_ENV` | — | No | Set to `production` for secure defaults |

## Database

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DB_PATH` | `./data/lattice.db` | No | SQLite database file path. Only used when `DATABASE_URL` is not set. |
| `DATABASE_URL` | — | No | Postgres connection string (e.g. `postgresql://user:pass@host:5432/lattice`). When set, Lattice uses Postgres instead of SQLite. |

Lattice auto-detects the backend: if `DATABASE_URL` is set and non-empty, it uses Postgres. Otherwise it uses SQLite in WAL mode via `better-sqlite3`.

## Authentication

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `ADMIN_KEY` | — | For admin routes | Secret key for `/admin/*` endpoints. If empty, admin routes return 503. |

## Background Services

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `TASK_REAP_TIMEOUT_MINUTES` | `30` | No | Minutes before a claimed task with no heartbeat is auto-abandoned |
| `TASK_REAP_INTERVAL_MS` | `60000` | No | How often the task reaper runs (ms) |
| `EVENT_RETENTION_DAYS` | `30` | No | Auto-delete events older than this. `0` = keep forever. |
| `AGENT_HEARTBEAT_TIMEOUT_MINUTES` | `10` | No | Minutes before an agent without heartbeat is marked offline |
| `POLL_INTERVAL_MS` | `5000` | No | Internal poll interval for background services (ms) |

## Rate Limits

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `RATE_LIMIT_PER_MIN` | `300` | No | Max API requests per key per minute. `0` = disabled. |
| `RATE_LIMIT_PER_MIN_WORKSPACE` | `1000` | No | Max API requests per workspace per minute (aggregated across all keys). `0` = disabled. |
| `MAX_BODY_BYTES` | `1048576` (1 MB) | No | Max request body size in bytes. `0` = disabled. |

## Security

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `HSTS_ENABLED` | `false` | No | Send `Strict-Transport-Security` header. Enable when behind HTTPS. |
| `CORS_ORIGINS` | — (disabled) | No | Comma-separated allowed origins, or `*` for all. Empty = CORS disabled. |

## Observability

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `LOG_LEVEL` | `info` | No | Log level: `silent`, `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | auto | No | `json` (default for non-TTY) or `pretty` (default for TTY) |
| `METRICS_ENABLED` | `true` | No | Expose Prometheus metrics at `/metrics` |
| `AUDIT_ENABLED` | `true` | No | Record mutating requests to the append-only audit log |
| `AUDIT_RETENTION_DAYS` | `365` | No | Auto-delete audit entries older than this. `0` = keep forever. |

## Minimal .env Example

```bash
# Server
PORT=3000

# Database (SQLite)
DB_PATH=./data/lattice.db

# Admin
ADMIN_KEY=your-secret-admin-key-here

# Logging
LOG_LEVEL=info
NODE_ENV=development
```

## Production .env Example

```bash
# Server
PORT=3000
NODE_ENV=production

# Database (Postgres)
DATABASE_URL=postgresql://lattice:secret@db:5432/lattice

# Admin
ADMIN_KEY=a-strong-random-secret

# Security
HSTS_ENABLED=true
CORS_ORIGINS=https://app.example.com

# Observability
LOG_LEVEL=info
LOG_FORMAT=json
METRICS_ENABLED=true
AUDIT_ENABLED=true

# Rate limits
RATE_LIMIT_PER_MIN=300
RATE_LIMIT_PER_MIN_WORKSPACE=1000
MAX_BODY_BYTES=1048576
```
