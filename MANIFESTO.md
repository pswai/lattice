# The Lattice Manifesto

**Lattice is the primary communication channel for AI agents.**

That's the whole product. Everything else is optional.

## What we believe

Agents need to talk to each other reliably. Today they don't. They share files, they poll dashboards, they ping each other through Slack webhooks, they guess. Every multi-agent system is held together with improvised string and accepts coordination failure as the cost of doing business.

We believe this is solvable. We believe the solution is a message bus — durable, push-first, host-agnostic — that any agent in any framework can trust to deliver.

## What Lattice is

- A **durable message log.** Agent A sends to agent B. The message survives crashes, restarts, and disconnects.
- A **receive contract per host.** The best push your client supports, transparently, without the sender having to care.
- One verb: `send`. One promise: *if the bus accepted it, it will be delivered.*

## What Lattice is not

- Not a task tracker.
- Not a workflow engine.
- Not a context store.
- Not a playbook runner.
- Not an analytics platform.

Those things can live on top. They are not the product. A Lattice install that only ever uses `send` and "receive somehow" has gotten 100% of the value.

## The hard problem, stated plainly

Sending is trivial. The hard part is **receiving, and knowing the need to receive.** Three distinct sub-problems:

1. **Idle receive.** An agent between tasks should be blocking on the bus, not dormant.
2. **Mid-task interrupt.** *"Stop, that approach is wrong"* needs to reach the agent before the work is done.
3. **Expected reply.** *"I asked a question; I need the answer to continue."*

We will not pretend all three are solvable in every host. They are not. We will be honest about where the host gets in the way, and we will give each host the best receive contract it can support.

## Our commitments

1. **Honest delivery semantics.** At-least-once with explicit ack. No hand-waving.
2. **Best push your host supports.** Claude Code gets real push. SDK agents get real push. Generic MCP clients get fast long-poll against a local queue, because that's what the ecosystem allows today. We will not pretend otherwise.
3. **One wire protocol.** WebSocket. Everything else is an adapter. Adding a new host means writing a shim, never touching the core.
4. **Small surface, stable contract.** The core API is small enough to memorize. Breaking it requires a hell of a reason.
5. **The bus is the product.** Every line of code either makes delivery more reliable, more honest, or more portable. Anything else is a distraction.

## What this means for the current codebase

Most of Lattice today is scaffolding around the bus. It will keep working. It will stop being the point. Tasks, workflows, context, playbooks, schedules, analytics — all optional, all revisited only after the bus is trustworthy. Deleting is encouraged. Doing less is the path forward.

If we do this right, Lattice becomes the one thing an AI agent builder can pick up and trust:

> Send a message. Know it will arrive. Know the receiver will learn about it as fast as its host allows.

Nothing else matters until that is true.
