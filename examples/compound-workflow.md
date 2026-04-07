# Compound Workflow — Profiles × Playbooks × Artifacts × WorkflowRuns

**The canonical Lattice demo.** This example exercises Lattice's four highest-leverage primitives in a single end-to-end trace and shows why together they are stronger than any one alone.

- **Profiles** — named, reusable role definitions (system prompt + capabilities + tags).
- **Playbooks** — named task templates with dependency wiring.
- **WorkflowRuns** — first-class tracking of a playbook execution.
- **Artifacts** — typed, keyed file storage separate from context.

This walkthrough uses only Lattice MCP tools. Everything happens inside one team (`uat-team`).

---

## The scenario

A lightweight 2-phase research workflow:

```
  researcher A ──┐
                 ├──▶ writer (synthesis)
  researcher B ──┘
```

Two researchers investigate in parallel; a writer synthesizes their artifacts into one canonical memo. This is fan-out / fan-in, the most common multi-agent shape.

---

## Step 1 — Define reusable profiles

Profiles are named roles. Any agent can "assume" one instead of re-writing their prompt.

```js
mcp__lattice__define_profile({
  agent_id: "hero-demo",
  name: "researcher",
  description: "AI infrastructure research specialist...",
  system_prompt: "You are a research agent... save findings with descriptive keys, cite sources, TL;DR at the end.",
  default_capabilities: ["research", "competitive-analysis", "ai-infra"],
  default_tags: ["research", "findings"],
})
// → { id: 6, name: "researcher", ... }

mcp__lattice__define_profile({
  agent_id: "hero-demo",
  name: "writer",
  description: "Documentation synthesizer...",
  system_prompt: "You are a writer agent... consume teammates' artifacts first, synthesize don't concatenate.",
  default_capabilities: ["writing", "synthesis", "documentation"],
  default_tags: ["writing", "synthesis"],
})
// → { id: 7, name: "writer", ... }
```

**Why this matters:** role prompts live centrally. Spawn 10 researchers tomorrow — they all share the same discipline, no prompt drift.

---

## Step 2 — Define the playbook

A playbook bundles task templates with dependency wiring. `depends_on_index` references earlier templates by position.

```js
mcp__lattice__define_playbook({
  agent_id: "hero-demo",
  name: "mini-research",
  description: "2-phase research: 2 researchers produce parallel findings, then 1 writer synthesizes.",
  tasks: [
    {
      description: "RESEARCHER A: landscape — competitors, pricing, differentiators. Artifact: research-landscape.",
      role: "researcher",
    },
    {
      description: "RESEARCHER B: architecture — storage, transport, primitives. Artifact: research-architecture.",
      role: "researcher",
    },
    {
      description: "WRITER: synthesize both artifacts into one positioning memo. Artifact: research-synthesis.",
      role: "writer",
      depends_on_index: [0, 1],  // blocks until tasks 0 & 1 complete
    },
  ],
})
// → { id: 3, name: "mini-research", ... }
```

**Why this matters:** the workflow shape is now reusable. Run it 100 times; each run gets the same structure with fresh task IDs.

---

## Step 3 — Run the playbook → get a WorkflowRun

```js
mcp__lattice__run_playbook({
  agent_id: "hero-demo",
  name: "mini-research",
})
// → { workflow_run_id: 3, created_task_ids: [65, 66, 67] }
```

One call instantiated 3 real tasks AND wired up their dependencies AND opened a workflow_run to track them.

Immediately inspecting the run:

```js
mcp__lattice__get_workflow_run({ id: 3 })
// → {
//     id: 3,
//     playbookName: "mini-research",
//     startedBy: "hero-demo",
//     taskIds: [65, 66, 67],
//     status: "running",
//     startedAt: "2026-04-05T08:44:59.235Z",
//     completedAt: null,
//     tasks: [
//       { id: 65, description: "[researcher] RESEARCHER A: ...", status: "open" },
//       { id: 66, description: "[researcher] RESEARCHER B: ...", status: "open" },
//       { id: 67, description: "[writer]     WRITER: ...",       status: "open" },
//     ],
//   }

mcp__lattice__list_workflow_runs({ status: "running" })
// → { workflow_runs: [{ id: 3, taskCount: 3, status: "running", ... }], total: 1 }
```

**Why this matters:** one ID (`3`) is the handle to the entire multi-agent run — durations, task statuses, lineage, all queryable.

---

## Step 4 — Agents do the work, save Artifacts

Each stage claims its task, produces an artifact, and completes the task.

### Stage 1 (researcher A — task #65)

```js
mcp__lattice__update_task({ agent_id: "hero-demo", task_id: 65, status: "claimed", version: 1 })

mcp__lattice__save_artifact({
  agent_id: "hero-demo",
  key: "demo-stage1",
  content_type: "text/markdown",
  content: "# Stage 1 — Landscape Research\n\n- LangGraph...\n- CrewAI...\n- AutoGen...\n...",
  metadata: { workflow_run_id: 3, task_id: 65, stage: 1, role: "researcher" },
})
// → { id: 4, key: "demo-stage1", size: 793, created: true }

mcp__lattice__update_task({
  agent_id: "hero-demo", task_id: 65, status: "completed", version: 2,
  result: "Saved artifact demo-stage1 — 4 competitors cataloged.",
})
```

### Stage 2 (researcher B — task #66)

```js
mcp__lattice__save_artifact({
  agent_id: "hero-demo",
  key: "demo-stage2",
  content_type: "text/markdown",
  content: "# Stage 2 — Architecture Research\n\n- SQLite + MCP sweet spot...\n...",
  metadata: { workflow_run_id: 3, task_id: 66, stage: 2, role: "researcher" },
})
// → { id: 5, key: "demo-stage2", size: 759, created: true }

mcp__lattice__update_task({ agent_id: "hero-demo", task_id: 66, status: "completed", version: 2, result: "..." })
```

### Stage 3 (writer — task #67, depended on 65+66)

```js
mcp__lattice__save_artifact({
  agent_id: "hero-demo",
  key: "demo-synthesis",
  content_type: "text/markdown",
  content: "# Synthesis — Lattice Positioning Memo\n\n**Source artifacts:** demo-stage1, demo-stage2\n\n...",
  metadata: {
    workflow_run_id: 3,
    task_id: 67,
    stage: 3,
    role: "writer",
    source_artifacts: ["demo-stage1", "demo-stage2"],
  },
})
// → { id: 6, key: "demo-synthesis", size: 1286, created: true }

mcp__lattice__update_task({ agent_id: "hero-demo", task_id: 67, status: "completed", version: 2, result: "..." })
```

**Why this matters:** artifacts are typed, keyed, sized, and carry structured metadata. The writer's `source_artifacts` metadata makes the lineage graph machine-readable.

---

## Step 5 — WorkflowRun auto-completes

The moment the last task flips to `completed`, the workflow_run closes itself:

```js
mcp__lattice__get_workflow_run({ id: 3 })
// → {
//     id: 3,
//     status: "completed",                        // ← flipped
//     startedAt:   "2026-04-05T08:44:59.235Z",
//     completedAt: "2026-04-05T08:45:44.192Z",    // ← 45 seconds end-to-end
//     tasks: [
//       { id: 65, status: "completed" },
//       { id: 66, status: "completed" },
//       { id: 67, status: "completed" },
//     ],
//   }
```

**Why this matters:** no polling, no manual bookkeeping. The run's lifecycle is tied to its tasks — fan-out, then auto-fan-in.

---

## The full trace (actual IDs from this demo run)

| Entity | ID / Key | Created by |
|---|---|---|
| Profile `researcher` | id=6 | hero-demo |
| Profile `writer` | id=7 | hero-demo |
| Playbook `mini-research` | id=3 | hero-demo |
| WorkflowRun | **id=3** | hero-demo (via `run_playbook`) |
| Task (stage 1) | #65 | workflow_run 3 |
| Task (stage 2) | #66 | workflow_run 3 |
| Task (stage 3) | #67 | workflow_run 3 (depends on 65+66) |
| Artifact `demo-stage1` | id=4, 793 B | task #65 |
| Artifact `demo-stage2` | id=5, 759 B | task #66 |
| Artifact `demo-synthesis` | id=6, 1286 B | task #67 |

Duration: **45 seconds** (08:44:59 → 08:45:44).

---

## Why this compound is the killer pattern

Any one of these primitives is useful. Together they are the whole product.

1. **Profiles make roles portable.** Don't re-prompt; assume a role.
2. **Playbooks make workflows portable.** Don't re-orchestrate; instantiate a template.
3. **WorkflowRuns make execution observable.** One ID to query lineage, latency, status, task graph.
4. **Artifacts make outputs durable.** Typed, keyed, sized, metadata-rich — separate from ephemeral context.

Competitors ship frameworks that assume you bring your own backplane. Lattice ships the backplane: **one team, one protocol, one durable store, full trace**. The compound IS the product.

### What this trace proves

- A single `run_playbook` call created 3 dependency-wired tasks and an observable run record.
- Agents produced typed artifacts with lineage metadata (`source_artifacts`) that makes the output graph auditable.
- WorkflowRun status transitioned `running → completed` automatically when the last task finished.
- The entire run is replayable from one ID (`workflow_run_id: 3`).

### Reproducing this demo

Invoke the `mini-research` playbook against `uat-team` with any profile-aware agent. All IDs will be fresh; the shape stays identical.
