# Testing Guide: Claude Code Channel Hardening (RFC 0004)

**Scope:** the three additions in [RFC 0004](../rfcs/0004-claude-code-channel-hardening.md) — sender identity gating, `lattice_reply` tool, permission relay — plus regression coverage of the meta-attribute mapping that already ships in v0.2.0.

**Principle:** unit and integration tiers run on every PR and gate merges; the acceptance tier is a pre-release human-observed demo. Nothing in this guide uses an LLM in a way that assumes specific token output, because LLM output is not a stable signal.

---

## Tier 1 — Unit

Runs under `vitest` on every commit. Pure logic, no I/O, no child processes.

### 1.1 Sender-gating policy engine

Extract the policy decision into a pure function: `shouldEmit(policy, allowlist, denylist, fromAgent) → boolean`.

| Case | Expectation |
|---|---|
| `allowlist`, list=`[a, b]`, from=`a` | true |
| `allowlist`, list=`[a, b]`, from=`c` | false |
| `allowlist`, empty list, any sender | false |
| `denylist`, list=`[x]`, from=`x` | false |
| `denylist`, list=`[x]`, from=`y` | true |
| `workspace-trust`, any sender | true |
| Unknown policy string | throws at config load, not at first message |

**Negative path**: rejected sender logs exactly one line with `event: "channel_sender_blocked"`, `from`, `reason`. Missing this log is a test failure.

### 1.2 Correlation map (permission relay)

- Insert N correlation IDs; lookup returns the stored `request_id`.
- Eviction at 1000 entries is LRU (oldest dropped).
- Expiry: entry inserted at T0 with TTL 30s, not present at T0+31s.
- Second verdict arriving for the same `correlation_id` is dropped and logged at debug level.

### 1.3 `lattice_reply` input validation

- `to_message_id` pointing to unknown inbound → tool returns structured error (not throws).
- Missing `payload` → schema rejection.
- Reply carries the inbound message's `from` as `to`, and the inbound `correlation_id` as its own. Assert on the constructed send op.

### 1.4 Meta-mapping regression

Keep even though this shipped in v0.2.0. For each inbound bus message shape, assert `buildChannelMeta(msg)` contains every expected key and **drops** any key with a hyphen or non-identifier character (channels-reference: invalid meta keys are silently dropped — we should never construct one).

---

## Tier 2 — Integration (shim-under-test, no Claude Code)

Runs under `vitest` on every PR. Spawns the shim as a child process, speaks MCP stdio framing directly.

### Harness

```
tests/integration/cc-shim/
  harness.ts      # spawn shim, feed frames, capture frames
  fixtures/
    allowlist.env
    denylist.env
    workspace-trust.env
    permission-on.env
```

The harness gives us: `send(frame)`, `nextFrame(predicate, timeoutMs)`, `outboundFrames()`, `kill()`. Fake broker is an in-process WebSocket server the harness owns.

### 2.1 Meta attributes surface correctly

1. Start shim with bus token.
2. Fake broker emits a `message` op with every meta-bearing field populated.
3. Assert shim emits `notifications/claude/channel` with `content` = payload string AND `meta` containing all seven keys with correct values.
4. Assert no stray text in `content` that was meant for `meta`.

### 2.2 Sender gating — workspace-trust default

- Policy unset → default is `workspace-trust`.
- Broker delivers messages from two different senders; both surface to Claude Code.
- No `channel_sender_blocked` events.

### 2.3 Sender gating — allowlist policy

- `LATTICE_CHANNEL_SENDER_POLICY=allowlist`, list = `[agent-a]`.
- Broker delivers two messages: from `agent-a` and from `agent-b`.
- Shim emits exactly one `notifications/claude/channel` (for `agent-a`).
- Shim sends exactly two `ack` frames (both delivered; one blocked, not dropped).
- `channel_sender_blocked` logged once with `from: "agent-b"`.

### 2.4 Sender gating — invalid policy fails closed

- `LATTICE_CHANNEL_SENDER_POLICY=typo` → shim refuses to start, non-zero exit.

### 2.5 `lattice_reply` tool

- Inbound message from `agent-a` with `correlation_id=c1` and `id=42`.
- Model (simulated) calls `lattice_reply` with `to_message_id=42, payload={...}`.
- Shim sends a bus `send` op with `to=agent-a`, `correlation_id=c1`, payload forwarded.

### 2.6 Permission relay — capability declared only when enabled

- `LATTICE_CHANNEL_PERMISSION_RELAY` unset → `initialize` response does **not** list `experimental['claude/channel/permission']`.
- `RELAY=on` with non-empty `APPROVER` → capability is listed.
- `RELAY=on` with empty/unset `APPROVER` → shim refuses to start (non-zero exit, error log naming the missing var).

### 2.7 Permission relay — allow path

- Relay on, `APPROVER=agent-supervisor`.
- Harness sends `notifications/claude/channel/permission_request` with `request_id=abcde`, `tool_name="Bash"`.
- Assert shim sends a direct bus message to `agent-supervisor`: `type: "channel.permission_request"`, fresh `correlation_id`, payload with `request_id`, `tool_name`, `description`, `input_preview`.
- Harness (as `agent-supervisor`) replies `{ verdict: "allow", request_id: "abcde" }` with matching `correlation_id`.
- Shim emits `notifications/claude/channel/permission` with `{ request_id: "abcde", behavior: "allow" }`.
- Log shows `event: "verdict_accepted"` with `from: "agent-supervisor"`.

### 2.8 Permission relay — deny path

- Same setup; approver replies `deny`. Shim emits `{behavior: "deny"}`.

### 2.9 Permission relay — unauthorized sender dropped

- `APPROVER=agent-supervisor`.
- `agent-intruder` sends `{ verdict: "allow" }` with a valid correlation_id (forged verdict).
- No `notifications/claude/channel/permission` emitted.
- Log shows `event: "verdict_unauthorized"` with `from: "agent-intruder"`.
- Subsequent legitimate verdict from `agent-supervisor` still resolves.

### 2.10 Permission relay — no replay on reconnect

- Relay on. Approval reply sits in `bus_messages` for a `correlation_id` whose in-memory state was lost.
- Shim reconnects to broker after a simulated crash.
- Assert the shim's `hello` op for the approvals stream uses `replay: false` (or equivalent: does not process historical verdicts).
- Claude Code sees no spurious `notifications/claude/channel/permission` for dead `request_id`s.

### 2.11 Permission relay — timeout falls back to terminal dialog

- `TIMEOUT_MS=500`, no verdict sent.
- After 500ms, no notification emitted (terminal dialog resolves).
- Late verdict arriving afterwards logged with `event: "late_verdict"`.

### 2.12 Ack semantics for blocked messages

Critical regression: a message blocked by sender-gating must still be acked to the broker, else the retention + replay story breaks. Test explicitly.

---

## Tier 3 — Acceptance (two real Claude Code sessions)

Manual pre-release checklist. One human, two iTerm2 windows, maybe 20 minutes. Not CI.

### Setup

- One broker on `localhost:8787`, fresh SQLite workspace.
- Two agent tokens minted: `agent-a` (worker), `agent-supervisor` (approver).
- Two `claude` sessions, each with their shim configs as env vars.

### Checklist

Run each; paste the relevant shim log excerpts into the release PR.

- [x] **Meta render.** `agent-supervisor` sends to `agent-a`. Session-a shows a `<channel>` tag with `from`, `type`, `correlation_id` attributes matching the send.
- [x] **Sender gating.** Flip session-a to `SENDER_POLICY=allowlist` with an empty allowlist, restart. Next send from `agent-supervisor` is acked in broker log but does not render. Shim log shows `channel_sender_blocked`.
- [x] **`lattice_reply` correlation.** Session-a agent replies to the prior message with `lattice_reply`. Supervisor sees the reply with the same `correlation_id`.
- [x] **Permission allow.** Session-a enables relay with `APPROVER=agent-supervisor`. Ask agent-a to run `echo hello`. Supervisor (manually or via a tiny SDK auto-approver) replies `allow`. Bash runs.
- [x] **Permission deny.** Same, supervisor replies `deny`. Bash is blocked.
- [x] **Permission unauthorized.** While relay is on with `APPROVER=agent-supervisor`, send a verdict from a *different* agent token. Shim log shows `verdict_unauthorized`; request is unaffected.
- [x] **Permission timeout.** No approver responds. After `TIMEOUT_MS`, terminal dialog appears; operator approves manually.

If any checkbox fails, the release does not tag. Evidence is the paste in the PR — no formal bundle directory.

---

## What this guide deliberately does NOT do

- **Assert on model output.** The model may paraphrase the payload, summarize, or refuse to call the tool. Every assertion is on protocol-visible artifacts: frames the shim emits, frames the broker sees, terminal buffer content that is the product of the channels protocol (not the model).
- **Run Tier 3 on every PR.** Flake cost > signal value at PR cadence.
- **Test the broker.** RFC 0002 coverage owns that. If a bug surfaces at the shim boundary that is actually a broker bug, file it separately.
- **Cover Generic MCP, SDK, or Webhook contracts.** Separate guides, separate RFCs, separate hardening passes.

## Open questions

**Approver cold-start replay.** If a permission request is forwarded to the approver while their shim/session is offline, and the approver connects afterward, does the request get replayed into their context? Observed during Tier 3: supervisor started after `permission_request_forwarded`, never saw the pending request. Needs Tier 2 coverage — decide the intended behavior (replay vs. drop) and test it.

**Remote recovery after timeout.** Once the shim evicts a request's correlation entry, only CC's terminal dialog can unblock the requesting agent — any later bus verdict is dropped as `late_verdict`. Whether to support a remote re-request path (new `request_id`, or extending the authority window on demand) is deferred; decide before a production deployment where the operator isn't at the keyboard.

**Automating Tier 3.** Whether to ever automate Tier 3. Needs a macOS runner, non-interactive CC mode, and a prompt that reliably triggers the tool under test. Not a blocker for RFC 0004 shipping.
