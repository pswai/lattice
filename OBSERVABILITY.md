# Lattice Observability

Lattice exports structured logs, Prometheus metrics, and liveness/readiness
probes out of the box. No agents to install. No external services required.

## Structured logs

- **Format:** one JSON object per line, on stdout.
- **Fields:** `ts`, `level`, `msg`, plus any request/service context
  (`req_id`, `team_id`, `agent_id`, `component`, `method`, `path`, `status`,
  `duration_ms`, …).
- **Auto-redacted:** API keys, bearer tokens, Stripe/OpenAI/Anthropic/AWS/
  GitHub/Google API keys, JWTs, and private-key blocks are scrubbed before
  writing. Safe to forward anywhere.

```
LOG_LEVEL    silent | error | warn | info (default) | debug
LOG_FORMAT   json (default for non-TTY) | pretty
```

Every HTTP request emits exactly one `http_request` line:

```json
{"ts":"2026-04-05T10:12:34.567Z","level":"info","msg":"http_request",
 "req_id":"550e8400-e29b-41d4-a716-446655440000","method":"POST",
 "path":"/api/v1/tasks","status":201,"duration_ms":12,
 "team_id":"research","agent_id":"code-reviewer"}
```

## Request IDs

Every request is tagged with an `X-Request-ID`. If the client sends one that
matches `[A-Za-z0-9_.-]{6,64}` it's honored; otherwise a UUID v4 is generated.
The ID is:

- Echoed back in the response `X-Request-ID` header
- Attached to every log line emitted during the request
- Recorded in the audit log

Plumb your client's trace ID through this header to get end-to-end correlation.

## Prometheus metrics

```
GET /metrics          → text/plain; version=0.0.4
METRICS_ENABLED       → default true
```

No authentication — scrape it with any Prometheus-compatible agent.

### Exposed metrics

| Metric | Type | Labels |
|---|---|---|
| `lattice_up` | gauge | — |
| `lattice_http_requests_total` | counter | `method,route,status,team` |
| `lattice_http_request_duration_ms` | histogram | `method,route` |
| `lattice_active_agents` | gauge | `team` |
| `lattice_tasks` | gauge | `team,status` |
| `lattice_events_total` | counter | `team,event_type` |

Histogram buckets: `5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000` ms.

Route labels collapse numeric IDs (`/tasks/123` → `/tasks/:id`) to keep
cardinality bounded. Gauges refresh from SQLite at scrape time, rate-limited
to once per 5 seconds.

### Example PromQL

```promql
# p95 latency
histogram_quantile(0.95,
  sum by (le, route) (rate(lattice_http_request_duration_ms_bucket[5m]))
)

# error rate
sum by (route) (rate(lattice_http_requests_total{status=~"5.."}[5m]))
  / sum by (route) (rate(lattice_http_requests_total[5m]))

# tasks stuck in "claimed"
lattice_tasks{status="claimed"}

# rate-limit incidents
sum by (team) (rate(lattice_http_requests_total{status="429"}[5m]))
```

## Health and readiness probes

```
GET /healthz   → 200 {"status":"ok"}          (liveness — process responsive)
GET /readyz    → 200 {"status":"ready"}       (readiness — DB reachable)
                 503 {"status":"unready",…}   (DB problem)
```

Kubernetes example:

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /readyz, port: 3000 }
  periodSeconds: 5
```

## Audit trail

See [SECURITY.md § Audit log](./SECURITY.md#audit-log). Every mutating call
records `team_id`, `actor`, `action`, `resource_type`, `resource_id`, `ip`,
`request_id`, and the request query. Query via
`GET /admin/audit-log?team_id=…`.

## Stats endpoint (legacy)

```
GET /admin/stats   → {teams, active_agents, context_entries, events, tasks:{…}}
```

Simple JSON snapshot gated by the admin key. The Prometheus endpoint is the
richer alternative; `/admin/stats` remains for quick-look debugging.

## Log shipping

Because logs are newline-delimited JSON with secrets already redacted, any
shipper works out of the box:

- **Loki** — promtail / grafana-agent `docker` scrape
- **CloudWatch** — `awslogs` driver on the container
- **Datadog** — `datadog-agent` docker socket tailing
- **Fluent Bit** — `parser json`

A minimal promtail config:

```yaml
scrape_configs:
  - job_name: lattice
    static_configs:
      - targets: [localhost]
        labels: { job: lattice, __path__: /var/log/lattice/*.log }
    pipeline_stages:
      - json:
          expressions:
            level: level
            team_id: team_id
            req_id: req_id
      - labels: { level, team_id }
```

## What Lattice intentionally does NOT ship

- No built-in OpenTelemetry tracer (add `@opentelemetry/auto-instrumentations-node`
  with the Node SDK if you need distributed traces — the `req_id` is already
  wired for correlation).
- No embedded dashboard for logs — forward to Grafana/Kibana/Datadog/etc.
- No built-in alerting — wire Prometheus alertmanager to the metrics above.
