# Self-Hosted Deployment Guide

This guide covers running Lattice in production on your own infrastructure.

## Database Backend: SQLite vs Postgres

Lattice supports two database backends. The choice is made via environment variables at startup -- no code changes needed.

| | SQLite | Postgres |
|---|--------|----------|
| **Best for** | Single-server, dev, small teams | Multi-instance, cloud, large teams |
| **Setup** | Zero config (file-based) | Requires a Postgres server |
| **Concurrency** | WAL mode, single-writer | Full MVCC, concurrent writers |
| **Backup** | File copy or `.backup` command | `pg_dump` / streaming replication |
| **Config** | `DB_PATH=./data/lattice.db` | `DATABASE_URL=postgresql://...` |
| **FTS** | FTS5 with trigram tokenizer | `tsvector` with `ts_rank` |

**Decision guide:**

- Use **SQLite** if you are running a single Lattice instance, want zero-ops setup, or are evaluating the product.
- Use **Postgres** if you need connection pooling, point-in-time recovery, or plan to scale beyond a single server.

Lattice auto-detects the backend: if `DATABASE_URL` is set and non-empty, it uses Postgres. Otherwise it uses SQLite.

---

## Option 1: Docker Compose (Recommended)

### SQLite Backend

```yaml
# docker-compose.yml
version: '3.8'

services:
  lattice:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - DB_PATH=/data/lattice.db
      - ADMIN_KEY=${ADMIN_KEY}
      - LOG_LEVEL=info
      - LOG_FORMAT=json
      - METRICS_ENABLED=true
      - AUDIT_ENABLED=true
      - HSTS_ENABLED=true
      - RATE_LIMIT_PER_MIN=300
      # - LATTICE_TOOLS=persist,coordinate  # Restrict MCP tool tiers (default: all)
    volumes:
      - ./data:/data
    restart: unless-stopped
```

### Postgres Backend

```yaml
# docker-compose.yml
version: '3.8'

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: lattice
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: lattice
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lattice"]
      interval: 10s
      timeout: 3s
      retries: 5

  lattice:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - DATABASE_URL=postgresql://lattice:${DB_PASSWORD}@db:5432/lattice
      - ADMIN_KEY=${ADMIN_KEY}
      - LOG_LEVEL=info
      - LOG_FORMAT=json
      - METRICS_ENABLED=true
      - AUDIT_ENABLED=true
      - HSTS_ENABLED=true
      - RATE_LIMIT_PER_MIN=300
      # - LATTICE_TOOLS=persist,coordinate  # Restrict MCP tool tiers (default: all)
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

volumes:
  pgdata:
```

### Starting

```bash
# Generate a strong admin key
export ADMIN_KEY="$(openssl rand -hex 32)"

# Or use a .env file next to docker-compose.yml
echo "ADMIN_KEY=$(openssl rand -hex 32)" > .env

# For Postgres backend
export DB_PASSWORD="$(openssl rand -hex 16)"

# Build and start
docker compose up -d --build

# Verify health
curl http://localhost:3000/healthz
# {"status":"ok"}

curl http://localhost:3000/readyz
# {"status":"ready"}
```

### First Team and API Key

Create a team via the admin API:

```bash
curl -X POST http://localhost:3000/admin/teams \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"my-team","name":"My Team"}'
```

**Save the `api_key`** from the response -- it is shown only once. If you lose it, mint a new one:

```bash
curl -X POST http://localhost:3000/admin/teams/my-team/keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"laptop"}'
```

### Dashboard

Visit [http://localhost:3000](http://localhost:3000) in a browser to see live tasks, agents, events, and context for your team.

### Tearing Down

```bash
docker compose down          # stop containers, keep data
docker compose down -v       # stop and remove the data volume too
```

---

## Option 2: npm Install (Bare Metal)

```bash
# Install globally
npm install -g lattice

# Or use npx
npx lattice init    # Interactive setup: workspace name, DB path, port
npx lattice start   # Start the server
npx lattice status  # Check health
```

For production, use a process manager like systemd or PM2:

```bash
# PM2 example
npm install -g pm2
pm2 start "npx lattice start" --name lattice \
  --env PORT=3000 \
  --env DB_PATH=/var/lib/lattice/lattice.db \
  --env ADMIN_KEY=your-secret \
  --env LOG_FORMAT=json
pm2 save
pm2 startup
```

---

## Reverse Proxy (nginx)

Place nginx in front of Lattice for TLS termination, request buffering, and static asset caching.

```nginx
upstream lattice {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name lattice.example.com;

    ssl_certificate     /etc/letsencrypt/live/lattice.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lattice.example.com/privkey.pem;

    # Security headers (Lattice also sets these, but double-layer is fine)
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    # SSE: disable buffering for the event stream endpoint
    location /api/v1/events/stream {
        proxy_pass http://lattice;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;  # SSE connections are long-lived
    }

    # MCP endpoint (Streamable HTTP, may use SSE)
    location /mcp {
        proxy_pass http://lattice;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    # Long-poll endpoint: increase timeout
    location /api/v1/events/wait {
        proxy_pass http://lattice;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }

    # All other routes
    location / {
        proxy_pass http://lattice;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Body size limit (matches Lattice's MAX_BODY_BYTES default of 1 MB)
        client_max_body_size 1m;
    }
}

server {
    listen 80;
    server_name lattice.example.com;
    return 301 https://$host$request_uri;
}
```

When using a reverse proxy with HTTPS, set these environment variables:

```bash
HSTS_ENABLED=true
```

---

## Backup Strategies

### SQLite Backup

**Online backup** (safe while Lattice is running):

```bash
# Using SQLite's built-in backup command
sqlite3 /data/lattice.db ".backup /backups/lattice-$(date +%Y%m%d-%H%M%S).db"
```

**File copy** (stop the server first, or ensure WAL is checkpointed):

```bash
docker compose stop lattice
cp /data/lattice.db /backups/lattice-$(date +%Y%m%d).db
cp /data/lattice.db-wal /backups/lattice-$(date +%Y%m%d).db-wal 2>/dev/null
docker compose start lattice
```

**Automated daily backup** (cron):

```cron
0 3 * * * sqlite3 /data/lattice.db ".backup /backups/lattice-$(date +\%Y\%m\%d).db" && find /backups -name 'lattice-*.db' -mtime +30 -delete
```

### Postgres Backup

**Logical backup:**

```bash
pg_dump -U lattice -h localhost lattice > /backups/lattice-$(date +%Y%m%d-%H%M%S).sql
```

**Compressed backup:**

```bash
pg_dump -U lattice -h localhost -Fc lattice > /backups/lattice-$(date +%Y%m%d).dump
```

**Restore:**

```bash
pg_restore -U lattice -h localhost -d lattice --clean /backups/lattice-20260101.dump
```

**Automated daily backup** (cron):

```cron
0 3 * * * pg_dump -U lattice -Fc lattice > /backups/lattice-$(date +\%Y\%m\%d).dump && find /backups -name 'lattice-*.dump' -mtime +30 -delete
```

For production Postgres, also consider enabling WAL archiving and point-in-time recovery (PITR).

---

## Upgrade Procedures

### Docker

```bash
# Pull latest code
git pull

# Rebuild and restart (data volume persists)
docker compose up -d --build

# Verify
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

### npm

```bash
# Update the package
npm update -g lattice

# Restart the server
npx lattice start
```

### Database Migrations

Lattice applies schema migrations automatically on startup. Both SQLite and Postgres backends use `CREATE TABLE IF NOT EXISTS` patterns, so upgrades are non-destructive. Always back up before upgrading.

---

## Monitoring with Prometheus

Lattice exposes metrics at `GET /metrics` in Prometheus text exposition format when `METRICS_ENABLED=true` (the default).

### Available Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `lattice_http_requests_total` | Counter | `method`, `route`, `status`, `workspace` | Total HTTP requests processed |
| `lattice_http_request_duration_ms` | Histogram | `method`, `route` | Request duration in milliseconds |
| `lattice_active_agents` | Gauge | `workspace` | Number of agents currently online |
| `lattice_tasks` | Gauge | `workspace`, `status` | Task count by workspace and status |
| `lattice_events_total` | Counter | `workspace`, `event_type` | Total events emitted |
| `lattice_up` | Gauge | *(none)* | Process liveness (1 = up) |

**Histogram buckets** for `lattice_http_request_duration_ms`: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000 ms.

### Prometheus Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: lattice
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: /metrics
```

### Health Check Endpoints

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /healthz` | Liveness probe (always returns 200) | None |
| `GET /readyz` | Readiness probe (pings DB, returns 503 if down) | None |
| `GET /health` | Legacy alias for `/healthz` | None |

### Kubernetes Probes

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

### Grafana Dashboard Suggestions

- **Request rate**: `rate(lattice_http_requests_total[5m])`
- **Error rate**: `rate(lattice_http_requests_total{status=~"5.."}[5m])`
- **P99 latency**: `histogram_quantile(0.99, rate(lattice_http_request_duration_ms_bucket[5m]))`
- **Active agents**: `lattice_active_agents`
- **Task backlog**: `lattice_tasks{status="open"} + lattice_tasks{status="claimed"}`

---

## Audit Logging

When `AUDIT_ENABLED=true` (default), Lattice records every mutating request to an append-only audit log. Each entry includes:

- Actor (agent ID or user)
- Action performed
- Resource affected
- Client IP and request ID
- Timestamp

Query the audit log via:
- `GET /admin/audit-log?workspace_id=<id>` (admin key, supports workspace filtering)

Retention is controlled by `AUDIT_RETENTION_DAYS` (default 365, `0` = keep forever).

---

## Security Checklist

- [ ] Set a strong `ADMIN_KEY` (at least 32 random hex characters)
- [ ] Enable HTTPS via reverse proxy and set `HSTS_ENABLED=true`
- [ ] Set `NODE_ENV=production`
- [ ] Restrict `CORS_ORIGINS` to your allowed domains (do not use `*`)
- [ ] Configure `RATE_LIMIT_PER_MIN` and `RATE_LIMIT_PER_MIN_WORKSPACE`
- [ ] Use scoped API keys (`read` / `write`) -- avoid giving `admin` scope to agents
- [ ] Set up automated backups
- [ ] Forward JSON logs (`LOG_FORMAT=json`) to your log aggregator
- [ ] Scrape `/metrics` with Prometheus
- [ ] Restrict MCP tool tiers via `LATTICE_TOOLS` if agents do not need all 35 tools
