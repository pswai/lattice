# Contributing to Lattice

Thanks for your interest in contributing! Lattice is a durable message bus for AI agent communication.

## Quick Start

```bash
git clone https://github.com/pswai/lattice.git && cd lattice
npm ci
npm run build
npm test              # 148 tests, ~5s
npm run test:fault    # 100 fault iterations, ~160s (optional)
```

## Prerequisites

- Node.js 20+
- npm
- Git

## Project Structure

```
src/
  bus/                    # Broker core
    broker.ts             # WebSocket server, message routing
    db.ts                 # SQLite database (WAL mode)
    tokens.ts             # Auth token management
    retention.ts          # Message retention cleanup
    webhooks.ts           # Webhook dispatch
    migrations/           # Schema migration SQL files
    migrations.ts         # Migration runner
    metrics.ts            # /healthz, /readyz, /bus_stats
    logger.ts             # Structured JSON logging

  cli.ts                  # CLI entry point (init, start, token)

packages/
  sdk-ts/                 # TypeScript SDK
    src/bus.ts            # Bus client (connect, send, messages, request)
    src/connection.ts     # WebSocket management + reconnect
    src/queue.ts          # Async message queue
    src/backoff.ts        # Exponential backoff with jitter

  shim-claude-code/       # Claude Code channel shim (MCP server)
    src/index.ts

  shim-mcp/               # Generic MCP long-poll shim (MCP server)
    src/index.ts

docs/
  rfcs/                   # Design RFCs
  testing-guide.md        # End-to-end testing guide
  lessons-from-v0.1.md    # Engineering lessons
```

## Build

```bash
npm run build    # TypeScript compilation + migration SQL copy + SDK + shims
```

The build outputs to `dist/` (broker + CLI) and `packages/*/dist/` (SDK + shims).

## Testing

```bash
npm test              # Unit + integration tests (vitest)
npm run test:fault    # Fault injection (100 iterations, kills broker mid-flight)
```

Tests start their own broker instances on ephemeral ports -- no manual setup needed.

## Design Principles

1. **The bus is the product.** Every line of code makes delivery more reliable, more honest, or more portable. Anything else is a distraction.
2. **One wire protocol.** WebSocket between broker and clients. Adding a host means writing a shim, never touching the core.
3. **Small surface.** Four client ops, four server ops. Breaking the contract requires a hell of a reason.

Read [MANIFESTO.md](MANIFESTO.md) and [RFC 0002](docs/rfcs/0002-lattice-as-a-message-bus.md) before proposing changes.

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes with tests
3. Run `npm test` and `npm run test:fault`
4. Submit a pull request

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
