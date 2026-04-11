# RFC 0002: Lattice as a Message Bus

- **Status:** Draft
- **Author:** pswai
- **Created:** 2026-04-11
- **Supersedes:** [RFC 0001 — Push-First Message Broker](./0001-push-first-broker.md)
- **Premise:** [MANIFESTO.md](../../MANIFESTO.md)
- **Companion:** [RFC 0003 — v0.2.0 Rewrite Execution Plan](./0003-rewrite-execution-plan.md)

## How this differs from 0001

0001 assumed MCP resource subscriptions would serve as the push mechanism for generic MCP clients. Research (saved in Lattice context as `mcp-resource-subscriptions-client-behavior`) killed that assumption: zero of Cursor, Zed, Continue, and Claude Desktop wire `notifications/resources/updated` into the agent loop. 0002 is built on the correct finding: **push is broker-side; the model layer degrades by host.** It also inherits the manifesto's scope decision — Lattice is the bus, nothing else — so this document treats "what about tasks/workflows/context?" as out of scope by fiat.

## Design goals (priority order)

Derived from the manifesto's five commitments. Ordering is load-bearing; higher-numbered goals yield when conflicts arise.

1. **Durable at-least-once delivery.** If the bus accepts a message, it arrives.
2. **Never lose an accepted message.** Back-pressure happens at ingress; the sender sees `inbox_full`, never through silent eviction.
3. **Best receive contract per host.** Claude Code gets real push. SDK agents get real push. Generic MCP gets harness-local long-poll. Webhook gets HTTP POST.
4. **One wire protocol between broker and clients.** WebSocket. Adding a host family means writing a shim, never touching the core.
5. **Small, stable surface.** Four client ops, four server ops. That's the contract.
6. **The bus is the product.** Tasks, workflows, context, etc. keep running but are out of scope.

## Delivery guarantees

Two guarantees the bus commits to, and one it explicitly doesn't:

✅ **At-least-once with idempotency.** Receivers dedupe on `idempotency_key`. Duplicates are expected (lost acks, reconnects).

✅ **Never lose an accepted message.** Once the broker returns an ack on a `send`, the message is committed. It will either be delivered to every intended recipient within the retention window or recorded in `bus_dead_letters` with a reason. Silent eviction is not a valid state.

❌ **Exactly-once.** Not a goal. Complex, unverifiable, unnecessary — receiver-side dedup is sufficient.

### Recovery modes (what "recovery" actually means)

"Recovery" splits into three specific uses, each satisfied by the retention window:

- **Audit trail** — prove what was sent, by whom, to whom, when
- **Replay for debugging** — "what did agent X see at time T?"
- **State reconstruction** — replay a workspace from a known cursor forward

The retention window is configurable (see [Persistence & Retention](#persistence--retention)). The default serves normal operational needs; longer values serve compliance and research uses.

## Core primitive

The broker is three things:

- A **message log** in SQLite. Append-only. Monotonic cursor.
- A **subscription and token registry** in the same SQLite file.
- A **WebSocket endpoint** that speaks the wire protocol.

Nothing else. Fanout is in-process. Replay is a cursor query. Ack is an `UPDATE`.

### Workspace = one SQLite file

A **workspace** is a single SQLite database file at a configurable path (`LATTICE_WORKSPACE=/var/lib/lattice/team.db`). One file = one workspace = one broker process. Multi-workspace deployments run multiple broker processes, each with its own file.

This keeps the operational model trivial: move a workspace by copying a file; back it up by copying a file; archive it by renaming the file. There is deliberately no `workspace_id` column anywhere in the schema — the file itself is the workspace boundary. This eliminates a class of "wrong workspace" bugs.

### Schema

```sql
CREATE TABLE bus_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent      TEXT NOT NULL,
  to_agent        TEXT,              -- NULL for topic broadcasts
  topic           TEXT,              -- NULL for direct messages
  type            TEXT NOT NULL,     -- 'direct' | 'broadcast' | 'event'
  payload         BLOB NOT NULL,     -- JSON, 1 MB hard cap
  idempotency_key TEXT,
  correlation_id  TEXT,
  created_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_bus_msg_recipient ON bus_messages(to_agent, id);
CREATE INDEX idx_bus_msg_topic     ON bus_messages(topic, id);
CREATE INDEX idx_bus_msg_created   ON bus_messages(created_at);

CREATE TABLE bus_subscriptions (
  agent_id          TEXT NOT NULL,
  connection_id     TEXT NOT NULL,
  last_acked_cursor INTEGER NOT NULL DEFAULT 0,
  connected_at      INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  PRIMARY KEY (agent_id, connection_id)
) STRICT;
CREATE INDEX idx_bus_sub_agent ON bus_subscriptions(agent_id);

-- Per-agent persistent topic subscriptions. Survive reconnects.
CREATE TABLE bus_topics (
  agent_id TEXT NOT NULL,
  topic    TEXT NOT NULL,
  PRIMARY KEY (agent_id, topic)
) STRICT;
CREATE INDEX idx_bus_topics_topic ON bus_topics(topic);

CREATE TABLE bus_dead_letters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES bus_messages(id),
  reason      TEXT NOT NULL,  -- 'retention_expired' | 'permanent_failure'
  recorded_at INTEGER NOT NULL
) STRICT;

-- Tokens are hashed, never stored in plaintext.
CREATE TABLE bus_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  scope      TEXT NOT NULL,    -- 'admin' | 'agent'
  created_at INTEGER NOT NULL,
  revoked_at INTEGER            -- NULL = active
) STRICT;
CREATE INDEX idx_bus_tokens_agent ON bus_tokens(agent_id);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;
```

## Persistence & Retention

### SQLite only

MVP uses SQLite exclusively. **Minimum version 3.45** (for `ALTER TABLE DROP COLUMN` and `STRICT` tables). **WAL mode mandatory.** [Litestream](https://litestream.io/) is the recommended production durability tool — second-level RPO streaming to S3/object storage with a trivial operational story.

**Postgres is an explicit non-goal for MVP.** The bus workload — single writer, append-only log, cursor-based reads, no complex queries — doesn't need anything Postgres has that SQLite doesn't. The install story ("one binary + one DB file") is a first-class feature we don't break without reason.

**When to revisit Postgres:** horizontal scale (multiple broker processes), multi-region replication, enterprise compliance hard requirement. None hold at MVP. Storage is behind an interface; swapping it at v3+ costs one module rewrite with zero protocol or contract changes.

### Retention

Every workspace has a configurable retention policy:

```
retention_days: 30   # default
```

Common values: `7` (lean), `30` (default), `90` (forensics), `365` (compliance-light), `forever` (audit/regulated, opt-in only).

**Retention rule:**

- A message is kept at least until every intended recipient's `last_acked_cursor ≥ message.id`
- After that, the message is kept until `created_at + retention_days`
- On expiry, the message is deleted (if fully acked) or recorded in `bus_dead_letters` with reason `retention_expired` (if some recipient never caught up)

A cleanup job runs daily. Disk growth with the default 30 days is bounded by traffic × 30 days.

`retention_days: forever` disables the cleanup job entirely. Operators opting in should provision disk accordingly and watch `db_growth_rate_bytes_per_day`.

### Never lose an accepted message

The broker **never silently drops accepted messages.** If a recipient's inbox depth (`count(bus_messages WHERE to_agent = X AND id > last_acked_cursor)`) exceeds the configured limit, the broker rejects new sends *at ingress*:

```json
{"op": "error", "code": "inbox_full",
 "agent_id": "agent-b", "current_depth": 10000, "limit": 10000}
```

The sender's options: retry with backoff, drop, escalate. The bus never makes the decision silently. The inbox depth limit (`inbox_limit: 10000` default) is an ingress gate, not an eviction trigger.

## Data migration strategy

Seven principles for smooth cross-version upgrades:

1. **Forward-only migrations.** No rollbacks in production. Fix forward with a new migration.
2. **Schema version in the DB.** `schema_migrations` table. Broker refuses to start if DB version is *higher* than code version (signals a downgrade).
3. **Additive before subtractive, spread across releases.** Expand/contract pattern — add column + dual-write, then migrate readers, then drop old.
4. **Zero-downtime migrations.** No long table locks; SQLite ≥ 3.45 for online DDL.
5. **Data migrations are separate from schema migrations.** Schema adds structure; data migration populates it. Data migrations are idempotent and resumable via cursor.
6. **Wire protocol stable independently of schema.** Internal schema evolves; external contract doesn't.
7. **Migrations tested on realistic data.** CI loads a snapshot fixture and applies every migration in sequence.

### Mechanism

- **Format:** plain SQL files in `src/bus/migrations/NNNN_description.sql`, numbered monotonically
- **Runner:** ~100-line function that reads `schema_migrations`, applies missing files in order inside a per-migration transaction, records completion. No ORM, no DSL.
- **Data migration runner:** separate background service with registered handlers, cursor-based, resumable
- **Snapshot testing:** `tests/fixtures/migration-snapshot-vN.db.gz` per major version; CI applies all migrations from vN to HEAD
- **Safety gates:** migrations touching >10k rows or holding locks >100ms fail CI unless marked `@allow-heavy`

## Authentication

### Per-agent bearer tokens

Every agent connects with a bearer token in the `hello` op. Tokens are per-agent, not per-connection (one agent can hold multiple active tokens for rotation or multi-device use). Tokens are stored as hashes in `bus_tokens`; plaintext is shown only once on creation.

### First-run bootstrap

```
$ lattice init /var/lib/lattice/team.db
Workspace created at /var/lib/lattice/team.db
First admin token:
  lat_admin_abc123...
Save this — it will not be shown again.
```

`lattice init` creates the workspace file, applies migrations, and prints an initial admin token. The admin token can mint additional tokens:

```
$ lattice token create agent-b --workspace team.db
Token for agent-b:
  lat_live_xyz789...

$ lattice token revoke lat_live_xyz789 --workspace team.db
Revoked.
```

**Token minting is CLI-only.** No HTTP/REST surface for it — that would require its own auth layer. Operators who want programmatic token creation run the CLI from their automation.

### Scopes

Two scopes, deliberately coarse:

- `admin` — can mint/revoke tokens, subscribe to any topic, send as any agent
- `agent` — can send as its own `agent_id`, subscribe to any topic, cannot mint tokens

Fine-grained topic ACLs and sender-identity enforcement are deferred post-MVP.

### Revocation

Immediate. Setting `revoked_at` on a token row causes the broker to reject any subsequent operation from connections holding that token with `{"op": "error", "code": "token_revoked"}`. No grace period.

## Wire protocol

Four client operations, four server operations. JSON frames over WebSocket. TLS required. Bearer token on connect.

### Client → broker

```json
{"op": "hello", "agent_id": "agent-a",
 "token": "lat_live_...",
 "protocol_version": 1,
 "last_acked_cursor": 142,
 "replay": false}

{"op": "send", "to": "agent-b", "type": "direct",
 "payload": {...},
 "idempotency_key": "uuid",
 "correlation_id": "optional-uuid"}

{"op": "subscribe", "topics": ["ci-alerts", "deploy-events"]}

{"op": "ack", "cursor": 157}
```

### Broker → client

```json
{"op": "welcome", "agent_id": "agent-a",
 "current_cursor": 142,
 "replaying": true,
 "protocol_version": 1}

{"op": "message", "cursor": 143,
 "from": "agent-b",
 "type": "direct",
 "payload": {...},
 "idempotency_key": "uuid",
 "correlation_id": "optional-uuid",
 "created_at": 1712836800000}

{"op": "gap", "from": 5, "to": 500000,
 "reason": "replay_cap"}

{"op": "error", "code": "...", "message": "..."}
```

### Key fields

- **`protocol_version`** — integer starting at 1. Broker rejects incompatible versions with `{"op": "error", "code": "unsupported_protocol_version", "supported": [1]}`. Cheap to add now, painful to retrofit.
- **`replay`** — boolean, default `false`. On a fresh connect, default is "start from head" (don't replay history). Set `replay: true` explicitly to request replay from `last_acked_cursor`.
- **`correlation_id`** — optional, **opaque to the broker**. Used by SDKs for request/reply; broker stores and forwards it but never interprets or tracks it.

### Error codes (MVP)

- `unauthorized` — missing or invalid token
- `token_revoked` — token has been revoked
- `unsupported_protocol_version` — client protocol version not supported
- `inbox_full` — recipient inbox at limit; retry or drop
- `message_too_large` — payload exceeds 1 MB
- `malformed_frame` — frame failed validation; connection closed
- `replay_gap` — paired with a `gap` op when replay span exceeds the cap
- `internal_error` — broker fault; check logs

## Delivery semantics

### Message size limit

**1 MB per frame**, hard reject at the wire-protocol decoder. Larger payloads must be chunked by the application and correlated via `correlation_id`. The broker never buffers unbounded payloads.

### Ordering

**Per-recipient FIFO.** Messages to the same recipient arrive in send order. No cross-recipient ordering guarantee. Cheap (one monotonic cursor), matches intuition.

### What "ack" means

Ack means "the thing on the receiving end that can best speak for the model has taken responsibility for this message." Per receive contract:

- **Channel shim:** after `mcp.notification()` returns
- **Long-poll shim:** after the tool call returns to the model
- **SDK:** after the application callback returns without throwing
- **Webhook:** after the 2xx response

Ack does NOT mean "the LLM saw the tokens." That's unknowable from the broker side; we don't pretend otherwise.

### Idempotency key retention

Receivers dedupe on `idempotency_key`. The receiver keeps an **LRU of the most recent ~1000 keys**. Sufficient for realistic burst sizes and bounded memory. Duplicates older than the LRU window would pass through but are vanishingly rare in practice (they require a reconnect gap + a network replay of messages that pre-date the window).

### Correlation IDs (request/reply)

The broker is **oblivious to `correlation_id`.** It persists the field and delivers it intact to the recipient but does not track request/reply pairs. Correlation is purely receiver-side:

1. SDK's `bus.request(to, payload)` generates a `correlation_id`
2. Registers a pending-request entry in an in-memory map
3. Sends the payload with the `correlation_id`
4. When a message arrives matching that `correlation_id`, resolves the promise

**Default timeout: 60 seconds.** **Cancellation:** `AbortController`. **On timeout:** the promise rejects with `BusRequestTimeoutError`. These are SDK ergonomics; the broker knows nothing about timeouts.

### Replay on reconnect

On `hello` with `replay: true` and `last_acked_cursor = N`, the broker replays `bus_messages.id > N` **up to a cap** (1000 messages OR 5 minutes of wallclock send time, whichever is smaller). If the gap exceeds the cap, the broker sends a single `gap` op:

```json
{"op": "gap", "from": N, "to": current_cursor, "reason": "replay_cap"}
```

The client's options: treat the gap as acceptable (`ack` to `current_cursor`), surface the gap to the operator, or query historical messages via a future history endpoint.

**SDK default behavior:**
- Fresh connect: `replay: false` (start from head)
- Reconnect: `replay: true` (replay with cap)
- On `gap`: log a warning and advance the cursor; configurable to raise `BusReplayGapError` instead

### Backfill on first connect

A brand-new agent connecting for the first time with `last_acked_cursor = 0` does **not** retroactively receive every message ever sent to it in the workspace. The default is `replay: false` — start from head. Opt-in explicit replay is supported via `replay: true`.

### Multiple connections per agent

Allowed. Each connection has its own `last_acked_cursor`. A `send` fans out to every active connection at send time. Connections joining later do not retroactively receive; they start from their declared cursor. Bookkeeping is O(connections), not O(connections × messages).

### Topic subscriptions

Topic subscriptions are **per-agent and persistent**, stored in `bus_topics`. When agent A subscribes to `ci-alerts` from their laptop, the subscription persists — if A connects from a different host tomorrow, they're still subscribed and receive the topic stream. This matches agent intuition: "I subscribed to X" is an agent-level action, not a session action.

Unsubscribe is a future addition. MVP supports subscribe-only; subscriptions persist until the agent is decommissioned or the operator deletes rows directly.

## The receive contract per host

For each host family, Lattice publishes a **receive contract** — how receive works, what guarantees hold, what doesn't. A host family is supported iff it has a working contract.

### Contract 1: Claude Code

| Aspect | Behavior |
|---|---|
| Shim | stdio MCP server declaring `experimental['claude/channel']` |
| Harness holds | WebSocket to broker |
| Idle receive | Real push. Broker → shim → `notifications/claude/channel` → `<channel source="lattice" from="agent-a" ...>` tag in model context on next turn |
| Mid-task interrupt | Yes, at the next turn boundary (sub-second typical) |
| Expected reply | Real push |
| Ack means | `mcp.notification()` returned successfully |
| Known caveat | Channels experimental; require `--dangerously-load-development-channels` unless on the Anthropic-curated allowlist (see Open Question 1) |

### Contract 2: Generic MCP (Cursor, Zed, Continue, Claude Desktop, etc.)

| Aspect | Behavior |
|---|---|
| Shim | stdio MCP server exposing a `lattice_wait` tool |
| Harness holds | WebSocket to broker **and** in-memory message queue |
| Idle receive | Long-poll against a **locally hot queue**. Model calls `lattice_wait(timeout_ms)`. Shim returns immediately if the local queue is non-empty; else blocks locally up to `timeout_ms`. Broker-to-shim is real push; only shim-to-model is poll-shaped. |
| Mid-task interrupt | Not supported. Messages arriving mid-turn wait in the shim's queue. Every Lattice tool response includes a `pending_messages: N` hint so the model can see there's mail. |
| Expected reply | `lattice_wait(correlation_id: ...)` filters the local queue |
| Ack means | Tool call returned to the model |
| Why this beats polling the broker | WebSocket keeps the queue warm in real time. Model's tool call is a local read, sub-millisecond when messages exist. Broker sees one persistent connection per agent, not tool-call storms. |

### Contract 3: Native SDK agent (TypeScript, Python, Go)

| Aspect | Behavior |
|---|---|
| Shim | None. SDK speaks the wire protocol directly. |
| Harness holds | The runner process itself |
| Idle receive | `for await (const msg of bus.messages())` |
| Mid-task interrupt | Yes, application-level |
| Expected reply | `await bus.request(to, payload)` — promise resolves on the correlated reply |
| Ack means | Application callback returned without throwing |
| Why this is the strongest | No host in the way. Full control of the event loop. |

### Contract 4: Webhook agent

| Aspect | Behavior |
|---|---|
| Shim | None. Broker holds the registered webhook URL. |
| Harness holds | Broker-side dispatcher |
| Idle receive | Broker POSTs on message arrival |
| Mid-task interrupt | Not supported |
| Expected reply | Agent POSTs back to a reply endpoint with `correlation_id` |
| Ack means | 2xx response to the POST |
| Use case | Non-persistent agents, CI-triggered agents, Lambda-style workloads |

## Deployment & process model

### Single binary

Lattice v0.2.0 ships as **one binary** per platform, containing:

- The broker core (WebSocket endpoint, SQLite persistence, fanout)
- The `lattice` CLI (`init`, `start`, `token create`, `token revoke`)
- A minimal HTTP server for `/healthz`, `/readyz`, `/bus_stats`, and webhook dispatch callbacks

Shims (Claude Code channel shim, generic MCP shim) are **separate binaries**, published independently. They connect to the broker as clients over WebSocket like anyone else — the broker doesn't know or care that a shim is on the other end.

### Running

```
$ lattice start --workspace /var/lib/lattice/team.db --port 8787
```

Or via environment:

```
LATTICE_WORKSPACE=/var/lib/lattice/team.db
LATTICE_PORT=8787
LATTICE_RETENTION_DAYS=30
LATTICE_INBOX_LIMIT=10000
```

CLI flags take precedence over env vars. No config file for MVP; if it later becomes useful, add it as a third layer (flag > env > file).

### Process topology

- **One broker process per workspace.** Multiple workspaces on one host → multiple processes on different ports.
- **No supervisor.** Run under systemd, launchd, Docker, pm2 — operator's choice. The broker is a single-process server.
- **No clustering.** Multi-process broker is a v3+ concern.

## Observability (minimum)

Every MVP broker must expose:

### HTTP endpoints (separate from WebSocket)

```
GET /healthz    → 200 "ok" if broker is healthy, 503 otherwise
GET /readyz     → 200 if accepting connections, 503 during startup/shutdown
GET /bus_stats  → JSON with operational metrics (below)
```

### Structured logs

Every send, ack, replay, reconnect, token mint, token revoke, error, and migration logs a JSON line to stderr:

```json
{"t": 1712836800000, "level": "info", "event": "send",
 "from": "agent-a", "to": "agent-b", "cursor": 143,
 "idempotency_key": "uuid", "size_bytes": 287}
```

Operators pipe stderr to whatever collector they use.

### Metrics (via `/bus_stats`)

- `connections_active` — current WebSocket connections
- `agents_active` — unique agents with ≥1 connection
- `messages_total` — monotonic counter of accepted messages
- `messages_per_sec` — EWMA over the last minute
- `replay_gaps_total` — monotonic counter
- `inbox_full_total` — monotonic counter (watch this)
- `dead_letters_total` — monotonic counter
- `db_size_bytes` — current SQLite file size
- `db_growth_rate_bytes_per_day` — EWMA over the last week

OpenTelemetry / Prometheus integration is deferred. The endpoint ships enough for operators to know the broker is healthy and when they're approaching trouble.

### "Why didn't my message arrive?" debugging

For MVP, operators debug missed delivery by:

1. Grepping logs for the `idempotency_key`
2. Querying `bus_messages` directly with `sqlite3`
3. Checking `bus_dead_letters` for terminal failures
4. Checking `/bus_stats` for `inbox_full_total` spikes

A proper admin UI is deferred.

## Failure modes

| Failure | Behavior |
|---|---|
| SQLite WAL corruption | Broker refuses to start; operator restores from Litestream or backup |
| Broker restart under load | Clients reconnect with exponential backoff + jitter (SDK enforces 10-30s spread); no thundering herd |
| Client sends malformed frame | Broker closes connection with `malformed_frame`; client reconnects |
| Client acks cursor > current | Broker ignores (idempotent); logs warning |
| Client acks cursor ≤ last_acked | Broker ignores (monotonic-only); logs warning |
| Ack lost in flight | Message replayed on reconnect; receiver dedupes on `idempotency_key` |
| Disk full | Broker refuses new `send` with `internal_error`; `/healthz` returns 503; operator alerted via logs |
| Token revoked mid-session | Next op returns `token_revoked`; SDK surfaces to app |
| Recipient inbox full | Sender sees `inbox_full`; must retry, drop, or escalate |
| Retention expiry on un-acked message | Moved to `bus_dead_letters` with reason `retention_expired`; logged |
| Protocol version mismatch | `unsupported_protocol_version` error; connection closed; SDK surfaces "upgrade required" |
| Client crashes without clean close | Subscription row lingers until `last_seen_at + idle_timeout` (default 5 min); swept by a background job |

## MVP scope (strict — hold the line)

Five things. In order. Nothing else.

1. **Broker core.** WebSocket endpoint, the schema, the wire protocol, fanout, ack, replay, reconnect, retention cleanup, token auth, CLI (`init`, `start`, `token create/revoke`), `/healthz` + `/bus_stats`, structured logs.
2. **TypeScript SDK.** Reference implementation. `send`, `subscribe`, `for await`, `request`, auto-reconnect with replay, receiver-side correlation, LRU idempotency dedup, gap handling. Target: ~700 LOC.
3. **Claude Code channel shim.** stdio MCP server, `claude/channel` capability. Separate binary. Shares the SDK internally.
4. **Generic MCP long-poll shim.** stdio MCP server. Exposes `lattice_wait`. Holds SDK connection and in-memory queue. Separate binary. Shares the SDK.
5. **Webhook dispatcher.** Broker-side. POSTs to registered URLs with retry.

Everything else — Python/Go SDKs, browser client, HA broker, dashboards, rate limiting, topic ACLs, admin UI, history endpoint — is v2.1+ and gated on MVP being trustworthy.

## What's explicitly out of scope

- Tasks, workflows, playbooks, schedules, artifacts, profiles, analytics, audit
- Postgres support
- NATS/Kafka backend
- Horizontal scaling / multi-process broker
- Multi-tenancy within one process
- Rate limiting beyond `inbox_full` back-pressure
- Topic subscription ACLs (all agents can subscribe to all topics)
- Admin UI / dashboard
- Python, Go, Rust SDKs
- Browser client direct WebSocket
- Backward compatibility with v0.1.x wire protocol (clean rewrite, no existing users)
- GDPR / right-to-be-forgotten as a feature (operator-managed)
- Archival tier for long-retention workspaces (sketched, deferred)

## Decisions requiring future input

Three items that can't be fully resolved today, but whose handling is decided.

1. **Claude Code channel allowlist — decided: ship with dev-flag caveat.** Channels require `--dangerously-load-development-channels` unless on the Anthropic-curated allowlist. **Decision (2026-04-11):** ship v0.2.0 with the dev-flag caveat documented in the Claude Code shim README. Submit the shim to the official marketplace in parallel, but do **not** block MVP shipping on marketplace approval. If approval lands before Phase G, update the README; if after, ship a patch.

2. **VS Code + Copilot as a fifth contract — decided: verify before Phase 2.** Prior research flagged VS Code as the only non-Claude client advertising "Discovery" in its MCP capability badge — it might actually wire notification handlers into the agent loop. **Decision (2026-04-11):** a focused verification task runs before Phase 2 begins. If VS Code genuinely surfaces `notifications/resources/updated` into Copilot's agent loop, it gets its own contract (real push, not long-poll). If not, it folds into Contract 2.

3. **Archival trigger for `retention_days: forever` — decided: telemetry-driven, revisit at ~50 GB.** When operators opt into forever retention, the live DB grows unbounded. The archive pattern (move messages older than N days to a read-only archive file, keep recent ones live) is sketched in Alternatives considered but deferred. **Decision (2026-04-11):** the archive tier is not MVP. We revisit when a real deployment crosses ~50 GB of live DB and reports performance degradation. Until then, `retention_days: forever` is documented as "opt-in, bring your own disk capacity planning."

## Alternatives considered

**NATS / NATS JetStream.** Battle-tested, subject-based routing maps cleanly to per-agent delivery, clustering built-in. Rejected for MVP: (a) breaks the "one binary + one DB file" install story; (b) ~80% of the hard work (shims, receive contracts, harness-local queue, ack translation) lives in layers NATS doesn't touch — savings are smaller than they look; (c) JetStream consumer semantics impedance-mismatch with per-recipient cursors; (d) every shim would need to link a NATS client. Swap-in path remains open for v3+: storage is behind an interface, no shim/contract change required.

**Kafka.** Heavier than NATS (ZooKeeper/KRaft, JVM, multi-broker for HA). Consumer-group model is the wrong abstraction for per-agent delivery. Rejected with less regret than NATS.

**Postgres backend.** See [Persistence & Retention](#persistence--retention). Rejected for MVP; swap-in path open for v3+.

**Resource subscriptions in generic MCP clients.** Was the push mechanism in RFC 0001. Research killed it — zero major clients wire `notifications/resources/updated` into the agent loop. Replaced with the harness-local queue pattern (Contract 2).

**Forever retention as default.** Considered, rejected. Forever is an obligation the code can't gracefully meet (disk exhaustion has no clean recovery), conflicts with privacy/compliance laws, and is over-provisioned for ~95% of use cases. `retention_days: forever` remains available as an explicit opt-in.

**Dual SQLite + Postgres support.** Rejected after earlier debate. Two dialects means 2× migration tax, edge-case bugs that hit one dialect only, and dialect decisions become political. One-dialect with a swap path is honest.

**SSE-only broker.** SSE is unidirectional; client→server has to go through a separate POST, correlation is awkward. Rejected as primary; SSE survives as a fallback for environments that can't do WebSocket.

## Migration path

Since there are no existing Lattice users (confirmed 2026-04-11), there is **no dual-write phase** and **no legacy data migration**. The rewrite is a clean replacement. Execution details — branch strategy, time-box, fault-injection gate, lessons sweep, directory layout — live in [RFC 0003](./0003-rewrite-execution-plan.md).

## Decision points for reviewers

1. **Four client ops and four server ops is the whole protocol for MVP.** Push back if something is missing that blocks a real use case.
2. **"Never lose an accepted message" is a first-class commitment** — back-pressure on ingress, not eviction. Alternative is silent eviction, rejected.
3. **Retention default is 30 days.** Debate the number; the shape is fixed.
4. **Correlation IDs are receiver-side.** Broker is oblivious to request/reply pairs.
5. **Workspace = one SQLite file.** Operational simplicity trumps flexibility.
6. **CLI-only token minting.** No REST surface. Operators who want automation run the CLI from scripts.
7. **Topic subscriptions are per-agent persistent.** Subscriptions survive reconnects and host changes.
8. **SQLite only for MVP.** Swap path to Postgres/NATS preserved for v3+ via the storage interface.
9. **Clean rewrite, not incremental refactor.** Details in RFC 0003.
