# Lessons from Lattice v0.1.x

This memo captures non-obvious engineering lessons from v0.1.x before the codebase is deleted in Phase B of the v0.2.0 rewrite. These lessons come from hard-won bug fixes and patterns that worked well.

## 1. Raw SQL events bypass the event bus

**The bug:** The task reaper used raw SQL INSERT to create events instead of calling the event bus. Listeners waiting on `wait_for_event` were never woken, leaving the dashboard stale.

**Why it matters:** Event bus listeners are critical to push semantics in v0.2.0. Every state change must be (bus emit, storage update) atomically. Create an invariant: no raw SQL writes that skip the bus.

**Evidence:** commit `99170ae` — task-reaper.ts now calls `broadcastInternal()` instead of raw SQL INSERT.

## 2. List-endpoint totals must use COUNT(*), not response length

**The bug:** `listTasks` returned `total: rows.length` (e.g., 50), not the true total (10,000). Pagination UI showed "50 of 50" when many more existed.

**Why it matters:** Pagination breaks silently. Cost is low (one COUNT(*) with the same WHERE). Enforce: every list endpoint with pagination fetches count separately, even with cursor-based models.

**Evidence:** `99170ae` — src/models/task.ts and src/models/workflow.ts fixed to COUNT(*) separately.

## 3. Single-session-per-agent closes displaced connections

**The bug:** When the same agent reconnected, the old session lingered with a broken transport. Push notifications routed to dead sessions, silently failing.

**Why it matters:** Only one active session per agent per workspace should exist. On reconnect with the same agent, close the displaced session first, then register the new one.

**Evidence:** `99170ae` — src/mcp/session-registry.ts closes displaced sessions and logs the event.

## 4. Dialect-specific SQL divergence is sharp

**The bug:** Analytics queries used `julianday()` (SQLite-only). Production Postgres crashed with "function does not exist."

**Why it matters:** Raw SQL in models creates dialect-specific branches. Even for SQLite-only MVP, establish the pattern: `msDiffExpr()` and `hoursAgoExpr()` helpers that branch on `db.dialect`, used everywhere timestamp math happens.

**Evidence:** commit `9a36991` — src/models/analytics.ts adds dialect-aware timestamp helpers.

## 5. Secret scanning belongs in route handlers, not models

**The bug:** `sendMessage()` model and the REST route both called `throwIfSecretsFound()`. Inconsistency meant one path could skip the check if refactored.

**Why it matters:** Security invariants belong at boundaries (middleware/route), never in models. Models trust validated inputs. Enforce secret scanning once per path, not scattered.

**Evidence:** `99170ae` — moved `throwIfSecretsFound()` from model to route handler.

## 6. Separate rate-limit buckets per transport

**The bug:** MCP and REST shared the same rate-limit bucket (300/min). Dashboard traffic starved the agent's MCP session.

**Why it matters:** Different clients have different latency and retry profiles. Allocate separate, independent rate-limit buckets for each receive contract (SDK WebSocket, MCP, webhooks).

**Evidence:** `99170ae` — src/config.ts adds `mcpRateLimitPerMinute`, src/http/middleware/rate-limit.ts maintains separate `mcpBuckets` Map.

## 7. Test fixtures work well when dialect-aware

**Pattern:** Separate `createTestAdapter()` and `createTestPgAdapter()` with dialect-agnostic helpers (`seedTask()`, `seedEvent()`, `setupWorkspace()`) worked well because both dialects were explicit, not hidden in generic calls.

**Evidence:** tests/helpers.ts — separate SQLite vs Postgres setup, shared seeding that calls `db.run()` (works for both).
