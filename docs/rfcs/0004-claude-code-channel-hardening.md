# RFC 0004: Claude Code Channel Hardening

- **Status:** Draft
- **Author:** pswai
- **Created:** 2026-04-13
- **Extends:** [RFC 0002 — Lattice as a Message Bus](./0002-lattice-as-a-message-bus.md)
- **Premise:** [MANIFESTO.md](../../MANIFESTO.md)

## Motivation

v0.2.0 shipped all five items on RFC 0002's MVP list. The Claude Code contract works end-to-end, but a post-ship audit of `packages/shim-claude-code` found the shim uses only a fraction of what the [channels protocol](https://code.claude.com/docs/en/channels-reference) offers — and one of the gaps is a live prompt-injection surface, not a future polish item. This RFC closes that gap and picks up two adjacent features the same hardening pass naturally covers.

The audit (2026-04-13) checked four aspects of the shim against channels-reference. Structured `meta` attribute mapping is already implemented; nothing to do there. **Sender identity gating is absent** — every bus message is forwarded to Claude Code unconditionally. A reply-scoped tool is absent; the model has to transcribe `correlation_id` through the general send tool. Permission relay (`claude/channel/permission`) is absent. Those three gaps are the subject of this document.

We harden Claude Code first because it is our flagship contract and the only one that can honor all three of the manifesto's hard sub-problems: idle receive, mid-task interrupt, and expected reply. This RFC does not change the broker's wire protocol — the four-op surface from RFC 0002 is preserved, all three additions are shim-local. Other host contracts (Generic MCP, SDK, Webhook) and marketplace allowlisting are separate hardening passes, out of scope here.

## 1. Sender identity gating

The shim today forwards every bus message to Claude Code as a `<channel>` tag. The channels reference is explicit that this is a prompt-injection vector: any agent with a valid bus token can inject arbitrary content into another agent's Claude Code turn. The bus's workspace-level trust model was designed for *message delivery*, not for gating *what enters an LLM's context* — those are different questions and the shim has been treating them as the same.

Gating policy lives in the shim, not the broker. Per-recipient trust policy is naturally receiver-local; a broker-enforced ACL would centralize a decision that isn't centralizable. The broker's `agent` scope deliberately lets any agent send to any agent — that is the bus contract, and this RFC doesn't touch it.

The shim accepts one of three policies, configured via environment:

```
LATTICE_CHANNEL_SENDER_POLICY=workspace-trust    # default
LATTICE_CHANNEL_SENDER_ALLOWLIST=agent-a,agent-b
LATTICE_CHANNEL_SENDER_DENYLIST=agent-x
```

`workspace-trust` is the default. Any agent in the workspace can emit. This matches the realistic common case — one operator running their own agents under tokens they minted — and a prompt-injection scenario against it requires a compromised agent with a valid token, which is an operator-level breach the shim cannot repair. A deny-by-default posture would force every operator to duplicate the token list they already maintain, buying nothing.

`allowlist` is for team or org deployments where not every token-holder should be trusted for context injection. `denylist` is for quickly blocking a misbehaving agent without rewriting the allowlist.

Policy applies only to `<channel>` tag emission — the high-privilege context-injection surface. Shim-internal protocol messages (the permission verdicts in §3) are gated separately by their own authorization rules; the two lists do not interact. Rejected messages are acked to the broker (they were delivered; the shim just chose not to surface them) and logged as `event: "channel_sender_blocked"`. Silently dropping them would break retention accounting and make debugging impossible.

## 2. Reply-tool ergonomics

The model today can reply to an inbound `<channel>` message by calling `lattice_send_message` and copying the `correlation_id` attribute manually. Relying on the model to transcribe a UUID faithfully is a correctness smell, and it leaks protocol details into the model's job. The fix is a dedicated tool:

```
lattice_reply(to_message_id: integer, payload: object | string)
```

The shim looks up the inbound message by `to_message_id`, extracts `from` and `correlation_id`, and constructs the outbound send. The model only needs the ID of the message it is replying to — a number already visible in the `<channel>` tag it just read. There is no `correlation_id` parameter (the shim generates one if the original had none) and no `to` parameter (a reply always targets the original sender).

Two error cases to spec. If `to_message_id` is unknown — evicted from the LRU or never seen — the tool returns a structured error so the model can fall back to `lattice_send_message`; it does not throw. If the inbound had no `correlation_id`, the shim mints one and surfaces it in the reply's meta, keeping the invariant that every reply carries a correlation id.

This tool is also the reply hook for §3: approvers use `lattice_reply` to respond to permission requests. One tool, two use cases, zero UUID transcription.

## 3. Permission relay

The manifesto names three hard sub-problems the bus must solve: idle receive, **mid-task interrupt**, and expected reply. In the Claude Code protocol, regular `<channel>` messages land only at turn boundaries — the one protocol surface that fires mid-tool-call is `claude/channel/permission`. That makes permission relay not a distributed-approvals engine but **Claude Code's implementation of mid-task interrupt**: a remote agent can interject "stop, that Bash is wrong" in the one window where Claude Code will listen. Cutting it would leave the flagship contract failing one of the three commitments it exists to honor.

The mechanism is deliberately minimal to stay inside that framing. Permission requests and verdicts travel as ordinary bus messages — `type: "channel.permission_request"` and `type: "channel.permission_verdict"`, tied by `correlation_id` — so there is zero wire protocol change. Each worker shim is configured with one approver agent and sends requests directly to it; no topic fan-out, no subscription model. Multi-approver quorum logic is deferred until a real deployment asks for it.

Verdict resolution is asymmetric. A wrong `deny` just defers to the terminal dialog; a wrong `allow` is an incident. So: first `deny` from the approver wins immediately, first `allow` takes effect as soon as it arrives, and no quorum window sits between request and resolution. This is cheap and honest until there is evidence to make it more elaborate.

Verdicts are not replayed on reconnect. They are fire-and-forget for a specific in-flight request; on shim crash the in-memory correlation map is gone, and replaying historical verdicts would either spuriously resolve calls Claude Code has already handled or generate "no such request" log noise. The shim reads verdict messages with `replay: false`. A verdict lost mid-crash resolves via terminal dialog after timeout — safe by default.

### Flow

1. Claude Code emits `notifications/claude/channel/permission_request` to the shim with `{ request_id, tool_name, description, input_preview }`.
2. Shim sends a direct bus message to the configured approver: `type: "channel.permission_request"`, fresh `correlation_id`, payload carrying the four fields above.
3. The approver receives it through whatever host it runs in and calls `lattice_reply` with `{ verdict: "allow" | "deny", request_id }`.
4. Worker shim resolves: sender ≠ configured approver drops with `verdict_unauthorized`; `deny` emits `{behavior: "deny"}` to Claude Code with `verdict_accepted`; `allow` emits `{behavior: "allow"}` with `verdict_accepted`; verdicts arriving after resolution or after timeout drop with `late_verdict`.
5. If no verdict arrives within the timeout, the shim emits nothing and Claude Code's terminal dialog resolves.

### Configuration and state

```
LATTICE_CHANNEL_PERMISSION_RELAY=on                      # off by default
LATTICE_CHANNEL_PERMISSION_APPROVER=agent-supervisor     # required when RELAY=on
LATTICE_CHANNEL_PERMISSION_TIMEOUT_MS=30000
```

Capability `experimental['claude/channel/permission']` is declared only when relay is on with a non-empty approver. Otherwise Claude Code's terminal dialog remains the sole approval path and nothing about this feature is visible.

State is an in-memory LRU of 1000 entries: `correlation_id → { request_id, expires_at }`. No persistence; a crash drops in-flight requests cleanly and they resolve via terminal dialog.

### Threat model

| Threat | Defense | Residual risk |
|---|---|---|
| **Forged verdict** — any agent with a workspace token publishes a verdict with an observed `correlation_id`. | Worker shim only accepts verdicts whose `from` matches the configured approver. | None within the stated model. |
| **Stale verdict after reconnect** — crashed shim pulls a historical verdict for a request CC already resolved. | `replay: false` on verdict reads. | Verdicts in flight at crash time are lost; terminal dialog resolves. |
| **Racing the terminal dialog** — a fast approver beats the human clicking. | **Not defended.** The race is enforced by Claude Code itself. | Operators who want terminal-only must leave the capability off. |
| **Audit after the fact.** | Every verdict (accepted, unauthorized, late) logs `from`, `request_id`, `correlation_id`, `verdict`, `outcome`. | Log retention is the operator's responsibility. |

Explicitly deferred: multi-approver quorum, approver failover chains, signed verdicts. They will land in a future RFC if real deployments ask for them. The baseline assumption is that the operator trusts the configured approver agent; the defenses keep the mechanism safe within that baseline, but they do not repair a misconfigured approver choice.

## Delivery and verification

The three sections above are independently shippable, in order: sender gating closes the security gap and ships first; `lattice_reply` follows because §3 uses it as its reply hook; permission relay ships last, opt-in via config, default off. If permission relay surfaces harder issues than anticipated during implementation, the first two can still ship alone.

Unit, integration, and acceptance criteria are defined in full in [docs/testing/0004-cc-channel-hardening.md](../testing/0004-cc-channel-hardening.md). This RFC is not declared delivered until all three tiers pass. The acceptance tier involves two real Claude Code sessions, no mocked channels, and assertions only on protocol artifacts — never on LLM token output.

## Decision points for reviewers

1. **Permission relay earns MVP via the manifesto's mid-task-interrupt commitment**, not via a "distributed approvals" story. If you read §3 as a general authz engine, push back — the design is deliberately single-approver and direct-send to stay inside that framing.
2. **Sender-gating default is `workspace-trust`.** The realistic injection scenario against it is an operator-level token breach the shim cannot repair. Challenge if you think a fresh shim should deny-by-default anyway.
3. **Multi-approver quorum is explicitly deferred.** If you have a concrete v0.3 use case for two approvers racing each other, raise it now.
4. **Is this the whole hardening pass for Claude Code?** If channels-reference has capabilities we're still not using — attachments, richer meta encoding, anything — call them out now rather than spawning an 0005 a week after this ships.
