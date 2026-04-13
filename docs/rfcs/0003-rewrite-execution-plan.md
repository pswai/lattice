# RFC 0003: v0.2.0 Rewrite Execution Plan

- **Status:** Completed — v0.2.0 shipped 2026-04-13
- **Author:** pswai
- **Created:** 2026-04-11
- **Companion:** [RFC 0002 — Lattice as a Message Bus](./0002-lattice-as-a-message-bus.md)
- **Premise:** [MANIFESTO.md](../../MANIFESTO.md)

## Purpose

This document describes **how** we execute the v0.2.0 rewrite defined by [RFC 0002](./0002-lattice-as-a-message-bus.md). It does not repeat design decisions — those live in 0002. It answers:

- What branch
- What gets deleted
- What lessons we preserve before deleting
- What the merge gate is
- How long we give ourselves before a smoke alarm
- What "done" looks like concretely

## Strategy: clean rewrite, in place

Current Lattice has no users (confirmed 2026-04-11). The existing codebase is ~70% scaffolding (tasks, workflows, context, playbooks, schedules, artifacts, profiles, analytics, audit) that RFC 0002 explicitly puts out of scope. An incremental refactor would force every bus-layer change to also update polling-shaped code that's going away — changing every file twice. **Clean rewrite is cheaper than refactor in this specific situation.**

### What "clean rewrite" means

**Keep:**

- The git repo, history, name, license, npm package name
- MANIFESTO.md, docs/, CLAUDE.md, settings.local.json, CI/build tooling
- `.mcp.json`, dev environment setup
- Test infrastructure (vitest setup, fixture pattern, test DB helpers) — but not the test *content*

**Delete:**

- Everything in `src/`
- Everything in `tests/` that tests application behavior
- All model-layer code that assumes polling as the primary read pattern

**Build fresh:**

- New directory layout matching RFC 0002's MVP scope
- Fault-injection harness as the merge gate
- Test suite measured against delivery guarantees, not feature coverage

### What it does NOT mean

- `git init` in a new directory
- Starting over with a new name or repo
- Throwing away the build chain, CI, package setup, or toolchain
- Throwing away lessons captured in auto-memory or Lattice context

## Execution phases

### Phase A — Lessons sweep (pre-deletion)

Before deleting anything, do a one-session audit of the current codebase to extract non-obvious lessons not yet captured in auto-memory or Lattice context. Spawn a focused research subagent.

**What to look for:**

- Non-obvious bugs that were fixed and whose root causes teach something (e.g., single-session constraint, raw-SQL events bypassing the event bus, dialect divergence in `getContext`, double secret-scan in the MCP path)
- Testing patterns that worked (fixture shapes, reset patterns, fault-injection stubs if any)
- Build/CI tricks worth preserving
- Any API or data-shape decisions that turned out well and should be mimicked

**Output:** `docs/lessons-from-v0.1.md` — a short engineering memo, not an RFC. Max 500 words. If there are fewer than 5 real lessons, that's fine — quality over quantity.

**Exit criterion:** `docs/lessons-from-v0.1.md` exists. Anything the rewrite team might need from the current code is captured there or in memory.

### Phase B — Branch and delete

```
git checkout -b next
git rm -r src/ tests/
mkdir -p src/bus src/cli src/http
mkdir -p packages/sdk-ts/src packages/sdk-ts/tests
mkdir -p packages/shim-claude-code/src packages/shim-claude-code/tests
mkdir -p packages/shim-mcp/src packages/shim-mcp/tests
mkdir -p tests/unit tests/integration tests/fault-injection tests/fixtures
git commit -m "chore: delete src/ and tests/ for v0.2.0 rewrite"
```

Target directory layout:

```
src/
  bus/              # broker core (schema, migrations, fanout, WS endpoint)
  cli/              # lattice init, start, token
  http/             # /healthz, /bus_stats, webhook dispatcher
packages/
  sdk-ts/           # TypeScript SDK
  shim-claude-code/ # Claude Code channel shim binary
  shim-mcp/         # Generic MCP long-poll shim binary
tests/
  unit/
  integration/
  fault-injection/
  fixtures/
```

**Exit criterion:** `next` branch exists, old `src/` and `tests/` are gone, new skeleton is committed.

### Phase C — Broker core first

Build MVP item 1 (broker core) before anything else. Nothing else can exist until the broker is real. Order within the phase:

1. Schema + migrations runner
2. `lattice init` CLI + token bootstrap
3. WebSocket endpoint + `hello` / `welcome`
4. `send` / `message` / `ack` path with persistence
5. Subscriptions and topic routing
6. `lattice token create/revoke` CLI
7. Replay on reconnect with gap handling
8. Retention cleanup job
9. `/healthz`, `/readyz`, `/bus_stats`, structured logs
10. Inbox-full back-pressure and ingress rejection

Each step is a PR to `next`. Each PR includes unit tests. Integration tests grow as pieces land.

**Exit criterion:** A running `lattice start` binary that accepts connections, persists messages, and passes the unit + integration suite.

### Phase D — Fault-injection harness (the merge gate)

Before the SDK or any shim ships, build the fault-injection harness. **This is the merge gate for `next → main`.**

The harness is a test runner that:

1. Starts a broker subprocess against a tmp DB
2. Launches fake senders and fake receivers
3. Injects faults in randomized orderings: `kill -9` the broker, close connections mid-frame, corrupt acks in flight, delay messages, duplicate messages, reorder messages, exhaust disk (simulated)
4. Asserts invariants after each fault:
   - Every accepted message is delivered exactly once to each recipient (modulo `idempotency_key` dedup)
   - Per-recipient FIFO ordering holds
   - Reconnect always succeeds within bounded time
   - Replay gaps are bounded by the cap
   - No message is silently lost — either delivered, dead-lettered with a reason, or rejected at ingress
5. Runs for N iterations (target 100) with randomized fault timing and seed-reproducible failures

Lives in `tests/fault-injection/`. Written in TypeScript. Part of CI with a longer time budget (5–10 minutes). Seeds are logged so failures can be replayed.

**Exit criterion:** Fault-injection harness passes 100 consecutive iterations green on the broker core. No other PR ships on `next` until this is true.

### Phase E — SDK + first shim

With a fault-tolerant broker, build the TS SDK and the Claude Code channel shim. They can proceed in parallel.

1. **TS SDK:** protocol client, reconnect logic, replay, `for await`, `bus.request` with receiver-side correlation, LRU idempotency dedup, gap handler
2. **Claude Code channel shim:** stdio MCP server, WebSocket client via SDK, `claude/channel` capability, channel notification emitter

Both get unit + integration tests. Both get fault-injection coverage (kill shim, kill SDK, kill broker — assert recovery).

**Exit criterion:** SDK + Claude Code shim both pass their tests and successfully carry a real message end-to-end between two real Claude Code sessions.

### Phase F — Second shim + webhook

Generic MCP long-poll shim and webhook dispatcher. Simpler than Phase E because they don't need host-specific capabilities.

- **Generic MCP shim:** stdio MCP server, `lattice_wait` tool, in-memory queue populated by the SDK
- **Webhook dispatcher:** broker-side, POST-on-arrival, retry with exponential backoff, HMAC signing

**Exit criterion:** All four receive contracts work end-to-end against one real instance of each host family (Claude Code, Cursor or Zed, TypeScript SDK agent, webhook).

### Phase G — Merge to main

When Phase F is green:

1. Tag the last commit on `main` as `v0.1.x-final` for git-history reference
2. Merge `next` → `main`
3. Update README with the new shape and one-paragraph migration note
4. Tag `v0.2.0-alpha`

**Exit criterion:** `main` contains the new codebase. Public announcement is ready.

## Time-box

**Four weeks from Phase A to Phase G as an early-warning check, not a deadline.**

If we're past four weeks and still in Phase C, something's wrong. The likely cause is scope creep. Stop and re-evaluate:

- Are we building something not in RFC 0002's five-thing MVP?
- Are we adding "one more small thing" that's really a feature?
- Are we over-engineering a primitive?
- Are we fighting a tooling or dependency issue that should be worked around, not solved?

**Four weeks is the smoke detector, not the finish line.** It exists to force a pause-and-rethink, not to pressure-ship.

## Scope discipline during the rewrite

Every PR on `next` is measured against exactly one question:

> Does this PR advance one of the five MVP items in RFC 0002, or does it not?

If not, close the PR. Open an issue for post-MVP instead.

*"While we're here, let's also..."* is the failure mode. The answer is always "v0.3.0."

CLAUDE.md's Scope Discipline section is the reference. The manifesto is the reference. RFC 0002 is the spec.

## What counts as "done"

v0.2.0 is **ready to ship** when *all* of the following are true:

1. Fault-injection harness passes 100 consecutive iterations green
2. A real Claude Code session can send a direct message to another real Claude Code session and receive it end-to-end via the channel shim
3. A TS SDK agent can do the same via native WebSocket
4. A generic MCP client (verified: Cursor or Zed) can send and receive via `lattice_wait`
5. A webhook-registered endpoint can receive messages and POST replies
6. `lattice init` → `lattice token create` → `lattice start` → send → receive works from a fresh install on a clean machine
7. Structured logs are legible on every send/ack/replay
8. `/healthz`, `/readyz`, `/bus_stats` return sensible data
9. Retention cleanup expires old messages without data loss for un-expired ones
10. Every failure mode listed in RFC 0002's Failure Modes section has been exercised at least once in tests

Explicitly **not required** for v0.2.0:

- Python/Go SDKs
- Browser client
- Admin UI / dashboard
- Rate limiting
- Topic ACLs
- Multi-process broker
- Observability integrations (OpenTelemetry, Prometheus)
- v0.1 migration (nothing to migrate)

## Decision points for reviewers

1. **Delete `src/` and `tests/` wholesale on `next`.** Alternative: keep some files as reference. Rejected — git history is the reference.
2. **Branch strategy: `next` → merge to `main`.** Alternative: rewrite on main directly. Rejected — main stays a working reference until `next` is ready.
3. **Fault-injection harness as the merge gate.** Alternative: "unit tests pass." Rejected — unit tests don't catch reconnect/replay/fanout/ack bugs.
4. **Four-week smoke detector.** Alternative: no time-box. Rejected — the check is too cheap to skip and forces an early pause if we've drifted.
5. **Lessons sweep before deletion.** Alternative: skip it. Rejected — five hours of audit saves weeks of rediscovered-the-hard-way later.

## Appendix: what the new structure looks like

```
tools-for-ai/
├── MANIFESTO.md                         (unchanged)
├── CLAUDE.md                            (unchanged, already reframed for EM role)
├── docs/
│   ├── rfcs/
│   │   ├── 0001-push-first-broker.md    (superseded, kept for history)
│   │   ├── 0002-lattice-as-a-message-bus.md
│   │   └── 0003-rewrite-execution-plan.md
│   └── lessons-from-v0.1.md             (created in Phase A)
├── src/
│   ├── bus/                             # broker core
│   ├── cli/                             # lattice CLI
│   └── http/                            # /healthz, /bus_stats, webhook dispatcher
├── packages/
│   ├── sdk-ts/                          # TypeScript SDK
│   ├── shim-claude-code/                # Claude Code channel shim binary
│   └── shim-mcp/                        # Generic MCP long-poll shim binary
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fault-injection/
│   └── fixtures/
├── package.json
├── tsconfig.json
├── README.md
└── .github/workflows/                   (unchanged, CI scripts survive)
```
