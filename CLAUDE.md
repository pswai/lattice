## Operating Principles

- **Simplicity.** Every change should be as small and focused as possible. Touch only what's necessary.
- **Root causes, not patches.** Diagnose before fixing. Temporary workarounds don't ship.
- **Prove it works.** Never declare something done without evidence — run tests, check logs, demonstrate correctness. Ask yourself: "Would a staff engineer approve this?"
- **Elegance where it matters.** For non-trivial changes, pause and consider if there's a cleaner approach. For simple fixes, just ship it. Know the difference.

## Lattice-First Coordination

Lattice is the default coordination layer. Every session, every agent, every subagent.

Tools are called with the `mcp__lattice__` prefix (e.g., `mcp__lattice__get_context`, `mcp__lattice__create_task`). The main agent's identity is `"lattice-core"` (set in `.mcp.json`). Subagents use descriptive IDs like `"sub-research-auth"`.

**If Lattice is unreachable**, fall back to built-in tools (TodoWrite, MEMORY.md) and note the fallback to the user.

### Orient before acting

At session start, before doing any work:

```
mcp__lattice__get_context(query: "<keywords from user's request>")
mcp__lattice__list_tasks(status: "open")
```

Derive the query from the user's request. User says "fix the auth bug" → query `"auth bug"`. User says "add rate limiting" → query `"rate limiting"`. When in doubt, use broad terms.

### During work

- **Tasks** → `mcp__lattice__create_task` / `mcp__lattice__update_task`. This is the task tracker. TodoWrite is scratch paper for a single turn — nothing more.
  - **Optimistic locking**: `update_task` requires the current `version`. Always call `mcp__lattice__get_task` first to get the latest version. On 409 conflict, re-fetch and retry.
- **Knowledge** → `mcp__lattice__save_context` with descriptive keys (`"auth-jwt-rotation-analysis"`, not `"finding-1"`) and generous tags (3-5 per entry). If you learned something another agent could use, save it.
- **Communication** → `mcp__lattice__broadcast` for workspace-wide discoveries. `mcp__lattice__send_message` for targeted handoffs.
- **Long work** → Call `mcp__lattice__heartbeat` every 15-20 minutes. The task reaper abandons claimed tasks after 30 minutes of silence.

### After completing a task

Every time you finish a unit of work (not just at session end):

1. Mark the Lattice task `completed` with a `result` summary, or `escalated` with a reason.
2. `mcp__lattice__save_context` for any findings worth preserving.
3. `mcp__lattice__broadcast` if the result affects other agents or ongoing work.

### Built-in tools are for ephemeral scratch only

| Need | Default | Fallback (Lattice unreachable) |
|------|---------|-------------------------------|
| Task tracking | `mcp__lattice__create_task` / `update_task` | TodoWrite (single-turn only) |
| Persistent knowledge | `mcp__lattice__save_context` | MEMORY.md (user prefs only) |
| Team communication | `mcp__lattice__broadcast` / `send_message` | SendMessage (intra-session only) |

## Subagent Discipline

Use subagents liberally to keep the main context window clean. One focused task per agent.

All subagent types (general-purpose, Explore, Plan) have access to Lattice MCP tools. Only general-purpose agents can edit files.

**Every non-trivial subagent prompt must include:**

1. **Lattice orientation** — `mcp__lattice__get_context(query: "<topic>")` before starting work
2. **Lattice persistence** — `mcp__lattice__save_context` with findings before returning
3. **Agent identity** — a descriptive `agent_id` (e.g., `"sub-research-auth"`, `"sub-review-api"`)
4. **Task linkage** — if working on a Lattice task, pass the `task_id` so the subagent can `update_task` on completion

**Example subagent prompt:**
> Before starting, call `mcp__lattice__get_context(query: "auth middleware")` to check existing findings. Use agent_id `"sub-auth-research"` for all Lattice calls. When done, save your findings via `mcp__lattice__save_context(agent_id: "sub-auth-research", key: "auth-middleware-analysis", value: "<your findings>", tags: ["auth", "middleware", "research"])` before returning your answer.

## Agent Teams

Use teams (via `TeamCreate`) when the work benefits from **opposing perspectives** or **parallel execution with coordination**. Solo subagents are fine for independent research — teams are for tension and synthesis.

### When to use a team

- **Decisions that need challenge**: PM vs Devil's Advocate, Proposer vs Critic
- **Implementation with quality gates**: Implementer vs Reviewer, Builder vs Tester
- **Research with synthesis**: Multiple researchers covering different angles, then a synthesizer
- **Any task where a single perspective risks blind spots**

### Team patterns

| Pattern | Roles | When |
|---------|-------|------|
| **Build + Review** | Implementer writes code, Reviewer critiques it | Features, refactors, migrations |
| **Propose + Challenge** | PM defines approach, Devil's Advocate finds holes | Architecture decisions, PRD review |
| **Research + Synthesize** | 2-3 researchers explore in parallel, Lead synthesizes | Market research, tech evaluations |
| **Fix + Verify** | Fixer resolves the bug, Tester writes and runs regression tests | Bug fixes with risk |

### Team rules

1. **Every teammate gets Lattice instructions** — same orientation/persistence requirements as solo subagents.
2. **Opposing roles must be independent** — don't let the Reviewer see the Implementer's reasoning before forming their own opinion. Use separate subagents, not sequential prompts.
3. **The main agent synthesizes** — teams produce perspectives, the main agent makes the final call and presents it to the user.
4. **Shut down when done** — send `SendMessage` with shutdown request to all teammates after synthesis.

## Autonomous Execution

- When given a bug: investigate, fix, verify. Zero hand-holding required.
- When corrected: capture the pattern via `mcp__lattice__save_context` with tags `["lesson", "correction"]` so future agents learn from it.
- When CI fails: go read the logs and fix it. Don't wait to be told how.
