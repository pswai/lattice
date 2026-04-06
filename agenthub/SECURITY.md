# Lattice Security

A practical guide to the security controls Lattice ships with, how to configure
them, and what threat model they address. Aimed at operators and security
reviewers evaluating Lattice for production use.

## Threat model

Lattice is a coordination bus for AI agent teams. Per-team data is the primary
asset: context entries, messages, artifacts, tasks, events. The main threats:

| Threat | Control |
|---|---|
| Credential theft / unauthorized team access | Hashed API keys, scopes (read/write/admin), expiry, revocation |
| Key leakage via logs | Automatic secret redaction on every emitted log line |
| Stolen key kept live indefinitely | Key rotation + revocation endpoints + `expires_at` |
| Tenant data crossover | All queries scoped by `team_id`; no cross-team access paths |
| Abuse / DoS from compromised client | Per-key rate limiting + body-size limits |
| Webhook spoofing (inbound/outbound) | HMAC-SHA256 signatures |
| Untracked privileged actions | Append-only audit log of every mutating request |
| Content injection of secrets | Secret scanner blocks obvious secrets on write |

## Authentication

Two separate key systems:

- **Team API keys** (`lt_…`, 24 random bytes). Required on every `/api/v1/*`
  and `/mcp` request as `Authorization: Bearer <key>`. Stored as SHA-256
  hashes — the raw key is only returned at creation/rotation.
- **Admin key** (`ADMIN_KEY` env var). Gates `/admin/*` routes: team CRUD,
  key management, audit queries.

### Scopes

Team keys carry a scope:
- `read` — `GET`/`HEAD` only
- `write` — any method (default)
- `admin` — any method (reserved for future granular controls)

### Lifecycle

Every key has optional `expires_at`, `last_used_at`, and `revoked_at` columns.
`last_used_at` is updated at most once per minute per key (throttled). Expired
or revoked keys return `401 UNAUTHORIZED` immediately.

| Endpoint | What it does |
|---|---|
| `POST /admin/teams/:id/keys` (+ `expires_in_days`) | Issue a key, optionally time-boxed |
| `POST /admin/teams/:id/keys/:keyId/rotate` | Issue a fresh key, revoke the old one, return new raw key once |
| `POST /admin/keys/:keyId/revoke` | Immediate revoke |
| `GET /admin/teams/:id/keys` | List keys (never returns the hash or raw key) |

## Rate limiting

In-memory sliding window per API key.

```
RATE_LIMIT_PER_MIN   default 300    (0 disables)
```

When exceeded, Lattice returns `429 RATE_LIMITED` with `Retry-After`,
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers. The
default (300 req/min/key) is generous for agent workloads; tune to your fleet.

> **Note:** rate-limit state is per-process. Multi-node deployments should
> front Lattice with a shared limiter (e.g. Cloudflare, NGINX, a Redis
> bucket) if you need globally-consistent limits.

## Request body size limit

Content-Length based. Requests over `MAX_BODY_BYTES` get `413 PAYLOAD_TOO_LARGE`.

```
MAX_BODY_BYTES   default 1048576    (1 MiB; 0 disables)
```

## Security response headers

Set on every response:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (`SAMEORIGIN` on `/` so the dashboard loads)
- `Referrer-Policy: no-referrer`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` *(opt-in)*

```
HSTS_ENABLED   default false    (enable once you terminate TLS in front)
```

Content-Security-Policy is intentionally not set — the dashboard's inline
scripts would need allowlisting first. Add it via a reverse proxy if you need it.

## Audit log

Every successful mutating request (`POST`/`PUT`/`PATCH`/`DELETE` with status
`< 400`) is recorded to an append-only `audit_log` table.

Fields captured: `team_id`, `actor` (agent_id), `action` (e.g. `task.create`),
`resource_type`, `resource_id`, `metadata` (query params), `ip`, `request_id`,
`created_at`. Request bodies are **never** recorded.

```
AUDIT_ENABLED            default true
AUDIT_RETENTION_DAYS     default 365    (0 keeps forever)
```

Query via `GET /admin/audit-log?team_id=…` with optional filters: `actor`,
`action`, `resource_type`, `since`, `until`, `limit` (max 1000), `before_id`
(cursor pagination).

There is **no** API for modifying or deleting individual audit records.
Retention cleanup runs daily and only deletes rows older than the cutoff.

## Secrets & logs

- The logger (`src/logger.ts`) scrubs API keys, bearer tokens, Stripe/OpenAI/
  Anthropic/AWS/GitHub/Google/GCP secrets, JWTs, and private-key blocks from
  every emitted line before writing to stdout.
- The secret scanner (`src/services/secret-scanner.ts`) blocks writes of
  obvious secrets to `context_entries`, `messages`, `artifacts`, and event
  payloads. Matches return `422 SECRET_DETECTED` with a redacted preview.

## Webhooks (inbound + outbound)

- **Outbound webhooks** (`POST /api/v1/webhooks`) sign every delivery with
  `X-Lattice-Signature: sha256=<hmac>` using the webhook's secret.
  Deliveries are retried with exponential backoff and marked `dead` after
  repeated failure.
- **Inbound endpoints** (`POST /admin/inbound/...`) can require HMAC
  verification of the incoming payload via an `hmac_secret`. The endpoint
  key in the URL IS the other half of the auth.

## Deployment recommendations

1. **Terminate TLS upstream.** Lattice serves HTTP; put it behind a
   reverse proxy (NGINX, Caddy, a load balancer) that terminates TLS.
2. **Enable HSTS** (`HSTS_ENABLED=true`) once TLS is confirmed working.
3. **Set a strong `ADMIN_KEY`** — at least 32 random bytes. Rotate regularly.
4. **Restrict `/admin/*`** network access (VPN, IP allowlist, mTLS) in
   addition to the admin key.
5. **Back up `./data/lattice.db`.** It contains team data, audit log,
   and key hashes.
6. **Monitor 401/429/413 rates** via the Prometheus metrics endpoint.
7. **Forward JSON logs** to your log aggregator; redaction is already done.

## Reporting vulnerabilities

Email `security@<your-domain>` (placeholder). Include reproduction steps and
affected version.
