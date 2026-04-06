# Configuration Reference

All Lattice configuration is via environment variables. No config files needed.

## Server

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | HTTP server port |
| `NODE_ENV` | — | No | Set to `production` for secure defaults (cookie secure, no verification tokens in responses) |

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
| `COOKIE_SECURE` | `true` in production | No | Set `Secure` flag on session cookies. Auto-enabled when `NODE_ENV=production`. |
| `EMAIL_VERIFICATION_RETURN_TOKENS` | `true` in dev, `false` in prod | No | Include verification/invite tokens in API responses. Useful for testing without email. |

## GitHub OAuth

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `GITHUB_OAUTH_CLIENT_ID` | — | For OAuth | GitHub OAuth app client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | — | For OAuth | GitHub OAuth app client secret |
| `GITHUB_OAUTH_REDIRECT_URI` | — | For OAuth | OAuth callback URL (e.g. `https://lattice.example.com/auth/oauth/github/callback`) |

## Email

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `EMAIL_PROVIDER` | `stub` | No | Email delivery provider: `stub` (logs only) or `resend` (Resend API) |
| `RESEND_API_KEY` | — | For Resend | Resend API key for email delivery |
| `EMAIL_FROM` | `noreply@lattice.local` | No | Sender address for verification and invitation emails |
| `APP_BASE_URL` | `http://localhost:3000` | No | Base URL used in email links (verification, invitations) |

## Background Services

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `TASK_REAP_TIMEOUT_MINUTES` | `30` | No | Minutes before a claimed task with no heartbeat is auto-abandoned |
| `TASK_REAP_INTERVAL_MS` | `60000` | No | How often the task reaper runs (ms) |
| `EVENT_RETENTION_DAYS` | `30` | No | Auto-delete events older than this. `0` = keep forever. |
| `AGENT_HEARTBEAT_TIMEOUT_MINUTES` | `10` | No | Minutes before an agent without heartbeat is marked offline |
| `POLL_INTERVAL_MS` | `5000` | No | Internal poll interval for background services (ms) |

## Rate Limits and Quotas

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `RATE_LIMIT_PER_MIN` | `300` | No | Max API requests per key per minute. `0` = disabled. |
| `RATE_LIMIT_PER_MIN_WORKSPACE` | `1000` | No | Max API requests per workspace per minute (aggregated across all keys). `0` = disabled. |
| `MAX_BODY_BYTES` | `1048576` (1 MB) | No | Max request body size in bytes. `0` = disabled. |
| `QUOTA_ENFORCEMENT` | `false` | No | Enable usage quota enforcement (exec count, API calls, storage). Requires plan/subscription tables. |

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
COOKIE_SECURE=true
CORS_ORIGINS=https://app.example.com

# Email (Resend)
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxx
EMAIL_FROM=noreply@example.com
APP_BASE_URL=https://lattice.example.com

# GitHub OAuth
GITHUB_OAUTH_CLIENT_ID=Iv1.xxxx
GITHUB_OAUTH_CLIENT_SECRET=xxxx
GITHUB_OAUTH_REDIRECT_URI=https://lattice.example.com/auth/oauth/github/callback

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
