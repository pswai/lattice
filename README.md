# Lattice

[![Tests](https://img.shields.io/badge/tests-148_passing-brightgreen)](packages/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**The primary communication channel for AI agents.** A durable, push-first message bus that any agent in any framework can trust to deliver.

> Send a message. Know it will arrive. Know the receiver will learn about it as fast as its host allows.

```bash
lattice init team.db
lattice start --workspace team.db
```

## Why Lattice?

Agents need to talk to each other reliably. Today they share files, poll dashboards, ping each other through Slack webhooks, and guess. Lattice replaces all of that with one primitive: **`send`**.

- **Durable message log.** Messages survive crashes, restarts, and disconnects.
- **At-least-once delivery.** Explicit ack. No hand-waving.
- **Best push your host supports.** Claude Code gets real push. SDK agents get real push. Generic MCP clients get fast long-poll. Webhooks get HTTP POST.
- **One wire protocol.** WebSocket. Everything else is an adapter.
- **One SQLite file = one workspace.** Move it, back it up, archive it by copying a file.

## Quick Start

```bash
# Build from source
git clone https://github.com/pswai/lattice.git && cd lattice
npm ci && npm run build
npm test                      # 148 tests

# Create a workspace
./dist/cli.js init team.db
# → prints admin token (save it)

# Start the broker
./dist/cli.js start --workspace team.db --port 8787

# Mint agent tokens
./dist/cli.js token create agent-a --workspace team.db
./dist/cli.js token create agent-b --workspace team.db
```

Verify the broker is running:

```bash
curl http://127.0.0.1:8787/healthz    # → {"status":"ok"}
curl http://127.0.0.1:8787/readyz     # → {"status":"ready"}
curl http://127.0.0.1:8787/bus_stats  # → live stats
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   AI Agent Hosts                        │
│  Claude Code  ·  Codex CLI  ·  Cursor  ·  Custom SDK   │
└────────┬──────────┬───────────┬──────────┬──────────────┘
         │          │           │          │
    ┌────┴───┐ ┌────┴────┐ ┌───┴───┐ ┌────┴────┐
    │Channel │ │Long-poll│ │Native │ │Webhook  │
    │  shim  │ │  shim   │ │  SDK  │ │ (HTTP)  │
    └────┬───┘ └────┬────┘ └───┬───┘ └────┬────┘
         │          │          │           │
         └──────────┴────┬─────┴───────────┘
                         │ WebSocket
                ┌────────┴────────┐
                │  Lattice Broker │
                │                 │
                │  Wire protocol  │
                │  Auth + tokens  │
                │  Topic routing  │
                │  Replay + ack   │
                │  Back-pressure  │
                └────────┬────────┘
                         │
                ┌────────┴────────┐
                │  SQLite (WAL)   │
                │  One file =     │
                │  one workspace  │
                └─────────────────┘
```

## Receive Contracts

Lattice adapts delivery to whatever your agent host supports:

| Contract | Host | Transport | Idle receive | Mid-task interrupt |
|----------|------|-----------|-------------|--------------------|
| **Channel shim** | Claude Code | Real push via `notifications/claude/channel` | Yes | Yes (next turn) |
| **Long-poll shim** | Codex CLI, Cursor, etc. | `lattice_wait` MCP tool | On tool call | On tool call |
| **Native SDK** | Custom agents | Direct WebSocket push | Yes | Yes |
| **Webhook** | HTTP endpoints | POST with HMAC signature | N/A | N/A |

## Wire Protocol

Four client ops, four server ops. JSON over WebSocket.

**Client → Broker:**
| Op | Purpose |
|----|---------|
| `hello` | Authenticate and start session |
| `send` | Send a message (direct or broadcast) |
| `subscribe` | Subscribe to topics |
| `ack` | Acknowledge receipt up to cursor |

**Broker → Client:**
| Op | Purpose |
|----|---------|
| `welcome` | Session established |
| `message` | Delivered message |
| `gap` | Replay window exceeded |
| `error` | Error with code |

See [RFC 0002](docs/rfcs/0002-lattice-as-a-message-bus.md) for the full protocol specification.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| **Broker** | `src/bus/` | WebSocket broker, SQLite persistence, auth, retention |
| **SDK** | `packages/sdk-ts/` | TypeScript client — connect, send, receive, request/reply |
| **Claude Code shim** | `packages/shim-claude-code/` | MCP server with channel push for Claude Code |
| **Generic MCP shim** | `packages/shim-mcp/` | MCP server with `lattice_wait` long-poll for any MCP host |

## CLI Reference

```
lattice init <workspace-path>                                Create a new workspace
lattice start --workspace <path> [--port N] [--host H]      Start the broker
lattice token create <agent_id> --workspace <path>           Mint a new token
lattice token revoke <token> --workspace <path>              Revoke a token
```

## Configuration

### Broker flags

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--workspace <path>` | — | — | SQLite DB path (required) |
| `--port <n>` | `LATTICE_PORT` | `8787` | Listen port (0 for auto) |
| `--host <addr>` | — | `127.0.0.1` | Listen address |
| `--retention-days <n\|forever>` | `LATTICE_RETENTION_DAYS` | `30` | Message retention |
| `--inbox-limit <n>` | `LATTICE_INBOX_LIMIT` | `10000` | Per-agent inbox depth cap |

### Shim environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LATTICE_URL` | Yes | — | WebSocket URL, e.g. `ws://127.0.0.1:8787` |
| `LATTICE_AGENT_ID` | Yes | — | This agent's identity |
| `LATTICE_TOKEN` | Yes | — | Bearer token from `lattice token create` |
| `LATTICE_TOPICS` | No | — | Comma-separated topics to auto-subscribe |

## Documentation

- [Manifesto](MANIFESTO.md) — what Lattice is and isn't
- [RFC 0002](docs/rfcs/0002-lattice-as-a-message-bus.md) — protocol specification
- [RFC 0003](docs/rfcs/0003-rewrite-execution-plan.md) — rewrite execution plan
- [Testing Guide](docs/testing-guide.md) — end-to-end testing across hosts
- [Lessons from v0.1](docs/lessons-from-v0.1.md) — engineering lessons from the prior version

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
