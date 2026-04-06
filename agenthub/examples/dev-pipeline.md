# Sequential Build Pipeline with Direct Messaging

A guide to building a multi-stage pipeline where agents hand off work via direct messages. Based on our Round 4 dog-food sprint where a content-researcher, designer, and reviewer collaborated on a landing page through structured handoffs.

## What You'll Build

```
  ┌───────────────────┐
  │ content-researcher │
  │  (writes brief)    │
  └────────┬──────────┘
           │ send_message → designer
           ▼
  ┌───────────────────┐
  │     designer       │
  │  (builds page)     │
  └────────┬──────────┘
           │ send_message → reviewer
           ▼
  ┌───────────────────┐
  │     reviewer       │◄──┐
  │  (QA + fixes)      │   │ fix loop
  └────────┬──────────┘───┘
           │
           ▼
        ✅ Done
```

Each stage saves its output to the shared context, then sends a direct message to the next agent with instructions on what to do.

## The Message Flow

```
content-researcher                  designer                    reviewer
      │                               │                           │
      ├─── save_context ──────────────►│                           │
      │    key: "landing-page-         │                           │
      │     content-brief"             │                           │
      │                                │                           │
      ├─── send_message ─────────────►│                           │
      │    "Brief ready. Pull from     │                           │
      │     key: landing-page-         │                           │
      │     content-brief"             │                           │
      │                                │                           │
      │                                ├─── get_context ──────────►│
      │                                │    query: "content brief" │
      │                                │                           │
      │                                │  (builds the page)        │
      │                                │                           │
      │                                ├─── save_context ─────────►│
      │                                │    key: "designer-        │
      │                                │     landing-page-path"    │
      │                                │                           │
      │                                ├─── send_message ────────►│
      │                                │    "Page built at         │
      │                                │     docs/landing-page.    │
      │                                │     html. Ready for QA."  │
      │                                │                           │
      │                                │                     (reviews + fixes)
      │                                │                           │
      │                                │                           ├── save_context
      │                                │                           │   key: "landing-
      │                                │                           │    page-qa-report"
```

## Step 1: Create Tasks with Dependencies

Create tasks in order, linking them with `depends_on` so the board reflects the pipeline:

```
mcp__lattice__create_task(
  agent_id: "lead",
  description: "Compile landing page content brief from shared research. Pull landscape, monetization, and technical summaries. Output a structured brief with headline, features, comparison table, pricing, and CTAs.",
  status: "open"
)
→ { task_id: 21 }

mcp__lattice__create_task(
  agent_id: "lead",
  description: "Build landing page HTML from content brief. Dark theme, responsive, Tailwind CSS. Must include: hero, stats, features grid, comparison table, pricing tiers, footer.",
  status: "open",
  depends_on: [21]
)
→ { task_id: 22 }

mcp__lattice__create_task(
  agent_id: "lead",
  description: "QA review the landing page against the content brief. Verify all sections, pricing tiers, comparison rows. Fix any gaps directly.",
  status: "open",
  depends_on: [22]
)
→ { task_id: 23 }
```

The `depends_on` field means task #22 can't start until #21 completes, and #23 can't start until #22 completes.

## Step 2: Spawn the First Agent

Only spawn the first agent initially. Subsequent agents get spawned (or triggered) when they receive a handoff message.

```
You are "content-researcher". Your agent_id is "content-researcher".

Claim task #21. Pull research from the shared knowledge base:
- get_context(query: "landscape summary")
- get_context(query: "monetization summary")  
- get_context(query: "technical summary")

Compile a landing page content brief and save it with key "landing-page-content-brief".
When done, send a direct message to "designer" with retrieval instructions.
```

## Step 3: The Handoff Pattern

This is the core pattern — save your output, then message the next agent:

### 3a. Content Researcher Completes

```
// Save the deliverable
mcp__lattice__save_context(
  agent_id: "content-researcher",
  key: "landing-page-content-brief",
  value: "# Lattice Landing Page — Content Brief\n\n## Headline\n\"The coordination layer for AI agent teams\"\n\n## Features\n1. Agent Registry & Discovery\n2. Shared Knowledge Base\n3. Real-Time Event Bus\n4. Task Coordination\n5. Direct Messaging\n6. MCP-Native Architecture\n\n## Pricing\nFree $0 → Pro $49 → Team $149 → Business $499 → Enterprise custom\n\n...",
  tags: ["landing-page", "content", "brief"]
)

// Hand off to the next stage
mcp__lattice__send_message(
  agent_id: "content-researcher",
  to: "designer",
  message: "Content brief ready. Retrieve with: get_context(query: 'landing page content brief'). Key: 'landing-page-content-brief'. Includes headline, 6 features, competitor comparison (8 dimensions), 5 pricing tiers, social proof, and CTAs. Build the page at docs/landing-page.html.",
  tags: ["handoff", "landing-page"]
)

// Mark task complete
mcp__lattice__update_task(
  agent_id: "content-researcher",
  task_id: 21,
  status: "completed",
  result: "Brief saved as 'landing-page-content-brief'. Handed off to designer.",
  version: 2
)
```

### 3b. Designer Picks Up

The designer agent checks for messages on startup:

```
mcp__lattice__get_messages(agent_id: "designer")
→ {
    messages: [{
      from: "content-researcher",
      message: "Content brief ready. Retrieve with: get_context(query: 'landing page content brief')...",
      tags: ["handoff", "landing-page"]
    }]
  }
```

Then pulls the brief and builds the page:

```
mcp__lattice__get_context(query: "landing page content brief")
→ { entries: [{ key: "landing-page-content-brief", value: "# Lattice Landing Page..." }] }
```

After building, the designer hands off to the reviewer:

```
mcp__lattice__save_context(
  agent_id: "designer",
  key: "designer-landing-page-path",
  value: "Landing page built at docs/landing-page.html. Dark theme, responsive, Tailwind CSS. Sections: hero, stats bar, 6-card features grid, comparison table, 4-tier pricing, footer.",
  tags: ["landing-page", "design", "deliverable"]
)

mcp__lattice__send_message(
  agent_id: "designer",
  to: "reviewer",
  message: "Page built at docs/landing-page.html. Ready for QA. Check against the content brief (key: 'landing-page-content-brief'). Focus on: all pricing tiers present, comparison table complete, all 6 features shown.",
  tags: ["handoff", "qa"]
)
```

### 3c. Reviewer QAs and Fixes

The reviewer checks both the page and the brief, then fixes issues directly:

```
mcp__lattice__get_messages(agent_id: "reviewer")
→ { messages: [{ from: "designer", message: "Page built at docs/landing-page.html..." }] }

mcp__lattice__get_context(query: "landing page content brief")
→ { entries: [{ key: "landing-page-content-brief", value: "..." }] }
```

In our actual run, the reviewer found and fixed:
1. **Missing Team pricing tier** — brief had 5 tiers, page only showed 4. Fixed.
2. **Missing Observability row** in the comparison table. Fixed.
3. **5th stat omitted** — accepted as-is (4-stat layout was cleaner).

```
mcp__lattice__save_context(
  agent_id: "reviewer",
  key: "landing-page-qa-report",
  value: "# Landing Page QA Report — Final\nVerdict: PASS\n\n## Issues Found & Fixed\n1. FIXED: Missing Team pricing tier ($149/mo)\n2. FIXED: Observability row in comparison table\n3. ACCEPTED: 5th stat omitted (cleaner layout)\n\nAll 9 sections verified.",
  tags: ["landing-page", "qa", "report", "final"]
)
```

## The QA Loop Pattern

If the reviewer finds issues they can't fix, they escalate back:

```
mcp__lattice__send_message(
  agent_id: "reviewer",
  to: "designer",
  message: "QA found 2 issues that need design changes: (1) pricing grid needs 5 columns, not 4, (2) comparison table missing a row. See qa-report for details.",
  tags: ["qa-feedback", "fix-needed"]
)
```

The designer checks messages, fixes, and hands back to the reviewer. This loop continues until the reviewer marks PASS.

## Real Results from This Pattern

In our Round 4 dog-food sprint:
- **3 agents** ran the full pipeline: content → design → review
- **Content brief**: 6 features, 5 pricing tiers, 8-dimension competitor comparison
- **Landing page**: Full HTML with Tailwind, dark theme, 9 sections
- **QA found 3 issues**, fixed 2 automatically, accepted 1 as-is
- **Final verdict**: PASS — all sections verified against brief
- **Zero manual coordination** — agents discovered work via messages

## Tips

- **Messages are the trigger** — in a pipeline, each agent polls `get_messages` on startup to know what to do. The message contains retrieval instructions, not the full payload.
- **Context is the payload** — save large outputs (briefs, reports) to `save_context`. Messages just point to the key.
- **Use `depends_on` for ordering** — task dependencies make the pipeline visible on the task board, even though the actual handoff happens via messages.
- **QA loops are natural** — the reviewer sends messages back to the designer, who fixes and re-hands-off. No special infrastructure needed.
- **Tag your handoffs** — use `["handoff", "stage-name"]` tags so you can filter for pipeline progression in `get_updates`.
