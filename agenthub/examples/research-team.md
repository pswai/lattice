# How to Run a 3-Agent Research Team

A step-by-step guide to coordinating multiple research agents through AgentHub. Based on a real sprint where 3 agents (industry-researcher, tech-analyst, biz-strategist) produced a comprehensive AI infrastructure analysis in under 10 minutes.

## What You'll Build

```
┌─────────────────────┐
│    Lead Analyst      │  ← Coordinates, synthesizes
│  (your main agent)   │
└────────┬────────────┘
         │ creates tasks, polls updates
         ▼
┌────────────────────────────────────────────┐
│              AgentHub Server               │
│  Event Bus │ Context Store │ Task Board    │
└──┬─────────────┬──────────────┬───────────┘
   │             │              │
   ▼             ▼              ▼
┌──────────┐ ┌───────────┐ ┌──────────────┐
│ industry │ │   tech    │ │     biz      │
│researcher│ │  analyst  │ │  strategist  │
└──────────┘ └───────────┘ └──────────────┘
  Landscape    Architecture   Monetization
  research     analysis       models
```

## Prerequisites

- AgentHub server running (`npm start` in the `agenthub/` directory)
- MCP config pointing to the server (see quick-start.md)

## Step 1: Register Your Lead Agent

Every agent starts by registering itself in the team directory:

```
mcp__agenthub__register_agent(
  agent_id: "lead-analyst",
  capabilities: ["synthesis", "coordination", "writing"],
  status: "online"
)
```

**Why register?** Other agents can discover you via `list_agents`. Without registration, you're invisible to the team — a real issue we hit in Round 1 where early agents weren't discoverable.

## Step 2: Create Tasks for Each Agent

Create specific, scoped tasks before spawning agents. Each task becomes a trackable work item.

```
mcp__agenthub__create_task(
  agent_id: "lead-analyst",
  description: "AI infrastructure landscape research: Cover MCP, LangChain, CrewAI, AutoGen, Dify, n8n, Composio, Browser Use, Mastra, Google ADK, OpenAI Agents SDK. For each: problem solved, GitHub stars, funding, revenue, growth trajectory, notable users.",
  status: "open"
)
→ { task_id: 6, status: "open" }

mcp__agenthub__create_task(
  agent_id: "lead-analyst",
  description: "Deep technical architecture analysis across 5 domains: agent communication, tool connectivity, context/memory, orchestration, and observability. Identify gaps and opportunities.",
  status: "open"
)
→ { task_id: 7, status: "open" }

mcp__agenthub__create_task(
  agent_id: "lead-analyst",
  description: "Research AI infrastructure monetization models: open-core pricing, cloud tiers, enterprise features, usage-based pricing, revenue data, and recommend pricing tiers.",
  status: "open"
)
→ { task_id: 8, status: "open" }
```

Use `status: "open"` so spawned agents can claim them (vs `"claimed"` which auto-assigns to the creator).

## Step 3: Spawn Agents with the Preamble

Each agent gets spawned with the AgentHub preamble template (`.claude/agents/agenthub-agent.md`) which tells it how to register, poll, and coordinate. In your spawn prompt:

```
You are "industry-researcher". Read and follow .claude/agents/agenthub-agent.md.
Your agent_id is "industry-researcher".

Register, get_updates, claim task #6, then research the AI infrastructure landscape.
Save findings as you go using save_context with descriptive keys like "landscape-mcp",
"landscape-langchain", etc. Broadcast key learnings.
```

Spawn all 3 agents in parallel — they coordinate through AgentHub, not through you.

## Step 4: Agents Self-Organize

Each agent follows the same startup sequence:

### 4a. Register + Poll
```
mcp__agenthub__register_agent(
  agent_id: "industry-researcher",
  capabilities: ["research", "market-analysis", "competitive-intelligence"],
  status: "online"
)

mcp__agenthub__get_updates(since_id: 0)
→ { events: [...], cursor: 22 }
```

### 4b. Claim Task
```
mcp__agenthub__update_task(
  agent_id: "industry-researcher",
  task_id: 6,
  status: "claimed",
  version: 1
)
```

### 4c. Save Findings Incrementally
As each agent works, it saves findings to the shared knowledge base:

```
mcp__agenthub__save_context(
  agent_id: "industry-researcher",
  key: "landscape-mcp",
  value: "MCP: 97M installs, universal adoption, Linux Foundation governance. De facto standard for AI tool connectivity. Adopted by Anthropic, OpenAI, Google, Microsoft.",
  tags: ["landscape", "mcp", "protocol"]
)

mcp__agenthub__save_context(
  agent_id: "industry-researcher",
  key: "landscape-n8n",
  value: "n8n: 182K GitHub stars, $254M funding, $2.5B valuation, $40M ARR. 10x revenue growth YoY. 3K enterprise customers. Visual workflow automation + AI agents.",
  tags: ["landscape", "n8n", "workflow", "automation"]
)
```

### 4d. Broadcast Key Learnings
When an agent discovers something other agents should know immediately:

```
mcp__agenthub__broadcast(
  agent_id: "biz-strategist",
  event_type: "LEARNING",
  message: "KEY FINDING: AI infra monetization follows a clear pattern — open-source the framework/SDK, monetize the platform (observability, hosting, no-code builder). Revenue leaders: n8n at $40M ARR, LangChain at $12-16M ARR. License changes (SSPL/BSL) consistently backfire.",
  tags: ["monetization", "revenue", "pricing"]
)
```

Other agents pick this up on their next `get_updates` poll.

## Step 5: Monitor Progress from the Lead

The lead agent polls for updates to track progress without interrupting workers:

```
mcp__agenthub__get_updates(since_id: 22)
→ {
    events: [
      { eventType: "LEARNING", message: "Context saved: landscape-mcp", createdBy: "industry-researcher" },
      { eventType: "LEARNING", message: "KEY FINDING: AI infra monetization...", createdBy: "biz-strategist" },
      { eventType: "TASK_UPDATE", message: "Task #8 completed by biz-strategist", createdBy: "biz-strategist" },
      ...
    ],
    cursor: 92
  }
```

You can also search the accumulated knowledge:

```
mcp__agenthub__get_context(query: "monetization pricing tiers")
→ { entries: [{ key: "monetization-summary", value: "...", createdBy: "biz-strategist" }] }
```

## Step 6: Agents Complete and Report

Each agent follows the completion protocol — save summary, mark task done, broadcast:

```
mcp__agenthub__save_context(
  agent_id: "industry-researcher",
  key: "industry-researcher-summary",
  value: "Completed landscape research covering 15 tools. Key highlights: n8n leads revenue ($40M ARR), LangChain is funding leader ($260M), MCP won the protocol war (97M installs).",
  tags: ["summary", "landscape", "complete"]
)

mcp__agenthub__update_task(
  agent_id: "industry-researcher",
  task_id: 6,
  status: "completed",
  result: "15 tools profiled. All findings saved as landscape-* context entries.",
  version: 2
)

mcp__agenthub__broadcast(
  agent_id: "industry-researcher",
  event_type: "BROADCAST",
  message: "industry-researcher COMPLETED landscape research. Summary saved as 'landscape-summary'.",
  tags: ["landscape", "completed"]
)
```

## Step 7: Synthesize Results

Once all agents complete, the lead pulls everything together:

```
mcp__agenthub__get_context(query: "landscape summary")
mcp__agenthub__get_context(query: "technical summary")
mcp__agenthub__get_context(query: "monetization summary")
```

All three research streams are now in the shared knowledge base, tagged and searchable. The lead can synthesize them into a final deliverable without any agent needing to pass files around.

## Real Results from This Pattern

In our actual dog-food run:
- **3 agents** completed their research in parallel
- **15 tools** profiled with real market data (stars, funding, revenue)
- **5 technical domains** analyzed with gap identification
- **5-tier pricing model** recommended with competitive benchmarks
- **~30 context entries** saved to the shared knowledge base
- **Total time**: Under 10 minutes for work that would take hours sequentially

## Tips

- **Tag generously** — tags are how agents filter relevant updates. Use multiple: `["landscape", "mcp", "protocol"]` not just `["research"]`.
- **Use descriptive keys** — `"landscape-n8n"` beats `"finding-3"`. Keys are unique per team, so namespace them.
- **Poll regularly** — agents should call `get_updates` every few steps, not just at startup. Cross-pollination happens naturally.
- **Don't over-coordinate** — the whole point is that agents self-organize. Create tasks, spawn agents, let them work. Check in via `get_updates`.
- **Save incrementally** — don't wait until the end to save findings. Other agents might need your early results.
