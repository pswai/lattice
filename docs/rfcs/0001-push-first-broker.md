# RFC 0001: Push-First Message Broker

- **Status:** Superseded by [RFC 0002 — Lattice as a Message Bus](./0002-lattice-as-a-message-bus.md)
- **Author:** pswai
- **Created:** 2026-04-11
- **Target:** Lattice v2 architecture

> **Superseded.** 0001 assumed MCP resource subscriptions could serve as the push mechanism for generic MCP clients. Research (see Lattice context `mcp-resource-subscriptions-client-behavior`) established that zero of Cursor, Zed, Continue, and Claude Desktop wire `notifications/resources/updated` into the agent loop. 0002 is built on the correct finding and adopts the receiver-centric design from [MANIFESTO.md](../../MANIFESTO.md). Read 0002 instead; 0001 is preserved only for the record of the path we didn't take.

## TL;DR

Lattice today is a REST/MCP API with polling-based reads and unreliable push. Direct messaging — the single most critical feature — does not reliably surface in a running agent session, and works on exactly one client (Claude Code, partially). This RFC proposes rebuilding Lattice around a **WebSocket message broker with a durable per-agent inbox** as the single source of truth, with thin per-host shims that translate inbound messages into whatever push mechanism each client supports. Push becomes the primary contract; polling survives only as a degraded fallback.

## Motivation

### What's broken

The single most critical functionality of Lattice is **direct messaging from any agent to any agent, delivered to the receiving agent in its running session without polling**. Today:

1. **Push is unreliable.** The `sendLoggingMessage` path in `src/models/message.ts` is the only push mechanism, and it only fires if the recipient has an active MCP session registered in the in-memory `sessionRegistry`. It often silently no-ops. The receiving agent has to poll `get_messages` or `wait_for_message` to be sure.
2. **Push only targets one client.** `sendLoggingMessage` is Claude Code–specific plumbing. No other MCP client (Cursor, Zed, Continue, custom SDK agents) gets push at all.
3. **Polling is the de facto default.** `wait_for_message` / `wait_for_event` long-polling exists precisely because push can't be trusted. Agents consume tool-call budget and latency to ask "anything new?"
4. **Two parallel channels drift.** The split between `events` (broadcast) and `messages` (direct) has duplicate code paths, duplicate persistence, duplicate long-poll waiters, and subtle divergences (e.g., task-reaper inserts events via raw SQL, bypassing the eventBus, so long-poll waiters miss them).
5. **One session per agent.** `sessionRegistry` holds one sessionId per `(workspace, agent)` key. A second connection from the same agent silently overwrites the first. This is a design bug, not a policy.

### Why it can't be patched in place

The current architecture assumes polling. The model layer, the REST surface, the session registry, and the dual event/message split all mirror that assumption. Bolting a real push broker onto the side means running two systems that fight each other — the broker would push, and the poll-based models would keep returning stale cursors, and reconciling them is more work than starting over.

## Goals

1. **Push-first delivery.** When agent A sends a message to agent B, and B has any active connection, B sees the message with sub-second latency and without polling.
2. **Client-agnostic.** Works for Claude Code, any MCP client that supports resource subscriptions, custom SDK agents over raw WebSocket, and webhook-only systems.
3. **At-least-once with explicit acks.** Messages survive disconnects, crashes, and restarts. The broker only advances a subscriber's cursor after the subscriber acks.
4. **Multiple connections per agent.** An agent can have N concurrent sessions (e.g., two Claude Code terminals); all of them receive messages.
5. **One message primitive.** Collapse direct messages, broadcasts, and events into a single typed message stream. Broadcasts are "send to every subscriber of topic T." Events are messages with `type: "event"`.
6. **The broker doesn't know about hosts.** Adding a new client family is "write a new shim," never "touch the core."

## Non-goals

- **Global ordering.** Per-sender-per-recipient FIFO only. Global ordering is expensive and has no concrete use case.
- **Exactly-once delivery.** At-least-once with idempotency keys on the receiver is sufficient and orders of magnitude simpler.
- **Replacing tasks/context/artifacts/workflows.** Those models stay. This RFC is strictly about the messaging substrate they ride on.
- **Breaking REST compatibility in v2.0.** REST polling endpoints stay as a degraded fallback, same shape.

## Proposed design

### Three layers

```
┌─────────────────────────────────────────────────────────────┐
│  Hosts: Claude Code │ Cursor │ Zed │ Custom agent │ Browser │
└─────────────────────────────────────────────────────────────┘
            │            │         │          │          │
       stdio MCP    stdio MCP   stdio MCP    SDK     WebSocket
       (channel)   (resources) (resources) (native)   (native)
            │            │         │          │          │
┌─────────────────────────────────────────────────────────────┐
│             Shims: thin translators, one per host          │
│             (hold the WebSocket on the host's behalf)      │
└─────────────────────────────────────────────────────────────┘
                             │
                        WebSocket
                             │
┌─────────────────────────────────────────────────────────────┐
│  Broker core: auth, inbox, ack cursors, fanout, persistence│
└─────────────────────────────────────────────────────────────┘
                             │
┌─────────────────────────────────────────────────────────────┐
│            SQLite / Postgres: durable message log          │
└─────────────────────────────────────────────────────────────┘
```

### Layer 1: Broker core

One protocol, one source of truth.

- **Transport:** WebSocket. Long-lived, bidirectional, framed JSON envelope. Falls back to SSE+POST for environments that can't do WebSocket.
- **Auth:** Bearer token on connect, issued per agent. The broker is the trust boundary for "any agent can message any agent."
- **Inbox:** Durable per-agent message log in SQLite/Postgres. Monotonic `cursor` per agent. Schema roughly:
  ```
  messages(id, workspace_id, from_agent, to_agent, topic, type,
           payload, idempotency_key, created_at)
  subscriber_cursors(agent_id, connection_id, last_acked_cursor,
                     updated_at)
  ```
- **Delivery:** On `send`, the broker persists the message, resolves recipients (direct: one agent; topic: all subscribers to T), and fans out to every active connection of each recipient. Slow/dead connections don't block fast ones.
- **Ack:** Subscribers explicitly ack each message (or a cursor range). Only then does `last_acked_cursor` advance. No ack in N seconds → assume not delivered; on reconnect, replay from `last_acked_cursor`.
- **Reconnect/replay:** Client sends last-acked cursor on connect. Broker replays everything since. Duplicates are expected; receiver dedupes on `idempotency_key`.
- **Back-pressure:** Per-agent inbox has a max size (configurable; default 10k) and a TTL (default 7d). Oldest-first eviction for size; hard TTL for age. Evicted messages go to a dead-letter table with a retention window for diagnostics.

### Layer 2: Client shims

The shim's only job: hold a WebSocket to the broker on behalf of a host that can't hold it natively, and translate each inbound message into whatever that host understands as "push." Shims are tiny (a few hundred lines each) and interchangeable. The broker never knows which shim is on the other end.

| Host family | Shim | How push reaches the agent loop |
|---|---|---|
| Claude Code | stdio MCP server declaring `experimental['claude/channel']` | Emits `notifications/claude/channel`; messages arrive as `<channel source="lattice" ...>` tags directly in context |
| Generic MCP (Cursor, Zed, Continue) | stdio MCP server exposing `lattice://inbox/<agent>` as a subscribable resource | Emits `notifications/resources/updated` on each new message. Client fetches the resource to read. Also exposes a `check_inbox` tool as a fallback for clients that don't wire resource updates into the agent loop |
| Custom SDK agent | No shim — Lattice SDK speaks WebSocket directly | Callback / async iterator in-process |
| Browser / web agent | Direct WebSocket from the browser | `onmessage` handler |
| Webhook-only system | No shim — broker POSTs to a registered URL | HTTP request to the caller |

Critical property: **shims are stateless translators.** All durability, ordering, and ack bookkeeping lives in the broker. A shim crash is a reconnect, not data loss.

### Layer 3: SDKs

Thin libraries (TypeScript first, Python second, Go eventually) that speak the WebSocket protocol natively. For anyone building a non-MCP agent, this is the escape hatch — they never touch a shim. The SDK is the reference implementation of the protocol; every shim uses it internally.

### Wire protocol (sketch)

JSON envelope on the WebSocket. Client → broker:

```json
{ "op": "hello", "agent_id": "agent-a", "token": "...",
  "last_acked_cursor": 142 }
{ "op": "send", "to": "agent-b", "type": "direct",
  "payload": {...}, "idempotency_key": "uuid" }
{ "op": "subscribe", "topic": "ci-alerts" }
{ "op": "ack", "cursor": 157 }
```

Broker → client:

```json
{ "op": "welcome", "agent_id": "agent-a", "cursor": 142 }
{ "op": "message", "cursor": 143, "from": "agent-b",
  "type": "direct", "payload": {...}, "idempotency_key": "uuid" }
{ "op": "error", "code": "unauthorized", "msg": "..." }
```

That's the whole protocol for the first milestone. Everything else (history queries, agent presence, typing indicators, read receipts if we want them) is additive.

### Delivery semantics — the hard parts

Three things need to be crisp before writing code:

**1. What "ack" means.** Possible interpretations, from weakest to strongest:
- *Delivered to the shim* — the WebSocket frame reached the shim process.
- *Consumed by the agent loop* — the shim handed it to the host (e.g., emitted the MCP notification), and the host accepted it.
- *Seen by the model* — the tokens actually reached the LLM's context window.

Only (1) and (2) are observable by the broker. (3) is unknowable — most MCP clients don't surface "the model read this" to the server. **Proposed contract:** ack means (2) — the shim hands it to the host. That's honest about what the broker can verify and sufficient for replay correctness. Receivers who need (3) add their own application-layer ack.

**2. Ordering.** Per-sender-per-recipient FIFO. If A sends m1 then m2 to B, B sees m1 before m2. Across senders, no guarantee — if A and C both send to B, B may see them interleaved. This is cheap (single monotonic cursor per recipient), matches user intuition, and has no realistic use case that requires more.

**3. Multiple connections per agent.** When agent B has two sessions open (e.g., two Claude Code terminals), both should receive each message. Each connection has its own ack cursor. A message is fully-acked only when every active connection at send time has acked — but a new connection joining later does *not* retroactively require ack of earlier messages; it just replays from its own initial cursor. This keeps the bookkeeping O(connections), not O(connections × messages).

## Migration path

Staging this without a flag day:

**Phase 0 — RFC approved, spike branch.**
Prototype broker + Claude Code channel shim + TypeScript SDK end-to-end. Exercise the ack/reconnect/replay loop under fault injection (kill the shim mid-message, kill the broker, race two connections). Goal: prove the design holds before touching production code.

**Phase 1 — Broker runs alongside current Lattice.**
New WebSocket endpoint on the existing Lattice server. Existing REST/MCP endpoints untouched. New broker writes to new tables. A dual-write shim in `sendMessage` pushes to both the legacy inbox and the new broker so existing agents keep working.

**Phase 2 — Shims + SDK ship.**
Claude Code channel shim and generic MCP resource shim are published. TypeScript SDK is released. Early adopters switch; legacy polling still works.

**Phase 3 — Flip the default.**
New sessions use the broker. `wait_for_message` and `wait_for_event` get deprecation warnings. The legacy `sessionRegistry` and `eventBus` become read-only shims over the broker.

**Phase 4 — Delete.**
Dual-write removed. Legacy event/message split collapsed. Raw-SQL paths in task-reaper etc. migrated to the broker. `sessionRegistry` deleted.

Each phase is independently revertable. Phase 1 is the biggest commit but ships no user-visible behavior change.

## Open questions

1. **Channels capability is gated.** Claude Code's `claude/channel` experimental capability requires `--dangerously-load-development-channels` unless on the Anthropic-curated allowlist. Plan: build the shim, eat the dev-flag caveat for early testing, and submit to the official marketplace in parallel. Needs a decision on timing and who drives the submission.
2. **Resource subscriptions in generic MCP clients.** Do Cursor, Zed, and Continue actually surface `notifications/resources/updated` to the agent loop, or is it purely a UI affordance? If it's UI-only, the generic shim has to fall back to the `check_inbox` tool, which reintroduces polling for those clients. Needs verification before committing to the shim shape — research agent can pressure-test this.
3. **Ack granularity.** Ack-per-message is simple but chatty. Ack-cursor (ack everything up to N) is efficient but loses per-message failure reporting. Proposal: cursor ack is the default, per-message nack is the exception for "I couldn't process this specific one."
4. **Multi-region / HA.** Single-process broker is fine for self-hosted. For any shared deployment, the broker needs to be horizontally scalable. Do we care now, or is "single process, scale vertically" good enough for v2.0 and we revisit later? Proposal: defer, design the tables so a Postgres-backed multi-instance broker is possible without schema changes.
5. **Backpressure policy.** 10k/agent and 7d TTL are placeholders. Real defaults need a data-driven pick — probably after Phase 2 telemetry.

## Alternatives considered

**A. Keep polling, fix the bugs.**
Patch `sendLoggingMessage`, fix the session registry, make `wait_for_message` more reliable. Cheapest in lines-of-code. Fails the goal: polling is the problem, not an implementation detail. Agents still burn tool-call budget to check for messages, and the "one session per agent" constraint stays. Rejected.

**B. Add a channel capability to the existing MCP server.**
Declare `claude/channel` on the current Lattice MCP server in `src/mcp/server.ts`. Doesn't work: the channels contract requires Claude Code to *spawn* the server as a stdio subprocess, and Lattice's MCP runs over Streamable HTTP. A dedicated stdio entrypoint collapses back to "write a shim," which is this RFC. Also fails the cross-client goal — it only addresses Claude Code. Rejected.

**C. SSE-only broker (no WebSocket).**
SSE is simpler and already implemented for events. Works for server → client push. Fails for client → server: SSE is unidirectional, so `send` has to go through a separate HTTP POST, and correlating the two is awkward. WebSocket is one socket for both directions and is universally supported. SSE survives as the fallback for environments that can't do WebSocket. Rejected as primary.

**D. Use NATS / Redis Streams / Kafka as the broker.**
Off-the-shelf brokers solve the hard parts (fanout, durability, replay). Adds an external dependency to a self-hosted OSS project that currently ships as "one binary + SQLite." The wins are real but the cost is a worse first-run experience, which Lattice has explicitly prioritized. Revisit if/when we outgrow a single-process broker. Rejected for v2.0.

**E. MCP "server-initiated sampling" for push.**
The MCP spec has server-initiated sampling requests. In theory the server could push work to the client that way. In practice it's purpose-built for "ask the client's LLM to generate something" and semantically wrong for "deliver a message." Rejected.

## Decision points

Before green-lighting implementation, reviewers should be comfortable with:

1. **The broker/shim split is the right shape.** Centralized durability, push at the edges. Alternative: push each client flavor into the core. I'm strongly against that — it couples the core to every client quirk.
2. **At-least-once with receiver dedup.** Alternative: exactly-once semantics. Much more complex, rarely actually needed. Push back if you think a use case demands it.
3. **WebSocket as the primary transport.** Alternative: SSE+POST. Pushed back on above, but open to revisiting.
4. **Ack means "shim delivered to host."** Alternative: only "delivered to shim" (weaker, simpler) or "seen by model" (unverifiable). Pushed back on above.
5. **Migration phases are acceptable.** Phase 1 dual-write is the biggest commit. If you want a cleaner flag-day cutover, say so now — it's cheaper but riskier.
6. **Open question 2 (resource subscriptions in generic MCP clients) needs to be resolved *before* Phase 2, not during.** If generic shims can't do push, the value prop of "works for many clients" weakens and we need to know that upfront.

## Appendix: what gets deleted

Tracking what this RFC commits to removing, so the cleanup cost is visible:

- `src/services/event-emitter.ts` — replaced by broker fanout
- `src/mcp/session-registry.ts` — replaced by broker connection table
- `wait_for_message` / `wait_for_event` long-poll code paths in `src/models/message.ts` and `src/models/event.ts`
- The raw-SQL event insert in `src/services/task-reaper.ts` (replaced by a broker `send`)
- The duplicate secret-scan in `src/mcp/tools/registry.ts` (single scan in the broker ingress)
- The dual `events` / `messages` tables merge into one `messages` log with a `type` column
- The 12-branch `getContext` SQLite/Postgres duplication — out of scope for this RFC, but worth noting the broker simplification makes an eventual refactor easier
