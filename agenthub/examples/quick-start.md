# Quick Start: 2 Agents Sharing Context in 5 Minutes

The simplest possible AgentHub workflow. Two agents save and retrieve shared context — no tasks, no events, no pipeline. Just `save_context` and `get_context`.

## Prerequisites

Start the AgentHub server:

```bash
cd agenthub
npm install
npm start
# Server runs at http://localhost:3000
```

Add to your MCP config (`.mcp.json`):

```json
{
  "mcpServers": {
    "agenthub": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Agent A: Save a Finding

Agent A does some research and saves it to the shared knowledge base:

```
mcp__agenthub__register_agent(
  agent_id: "agent-a",
  capabilities: ["research"]
)

mcp__agenthub__save_context(
  agent_id: "agent-a",
  key: "api-rate-limits",
  value: "OpenAI: 10K RPM on tier 5. Anthropic: 4K RPM on scale. Google: 1K RPM free tier. All support batch APIs for non-urgent work.",
  tags: ["api", "rate-limits", "research"]
)
```

That's it. The finding is now in the shared knowledge base, searchable by any agent on the team.

## Agent B: Retrieve It

Agent B needs rate limit info. It searches the knowledge base:

```
mcp__agenthub__register_agent(
  agent_id: "agent-b",
  capabilities: ["implementation"]
)

mcp__agenthub__get_context(
  query: "rate limits"
)
→ {
    entries: [{
      key: "api-rate-limits",
      value: "OpenAI: 10K RPM on tier 5. Anthropic: 4K RPM on scale...",
      tags: ["api", "rate-limits", "research"],
      createdBy: "agent-a"
    }]
  }
```

Agent B now has Agent A's research without any direct communication or file passing.

## Full Copy-Paste Example

### Agent A prompt:

```
You are "agent-a". Register with AgentHub, then save your findings:

mcp__agenthub__register_agent(agent_id: "agent-a", capabilities: ["research"])

Research the topic, then save what you learn:

mcp__agenthub__save_context(
  agent_id: "agent-a",
  key: "your-descriptive-key",
  value: "Your finding here",
  tags: ["relevant", "tags"]
)
```

### Agent B prompt:

```
You are "agent-b". Register with AgentHub, then check what agent-a found:

mcp__agenthub__register_agent(agent_id: "agent-b", capabilities: ["implementation"])

mcp__agenthub__get_context(query: "search terms related to what you need")

Use the retrieved context to inform your work.
```

## Adding More Agents

It scales naturally. Agent C can read what both A and B saved:

```
mcp__agenthub__get_context(query: "rate limits")     // gets agent-a's research
mcp__agenthub__get_context(query: "implementation")   // gets agent-b's work
```

Every agent reads from and writes to the same knowledge base. No wiring needed.

## Search Tips

```
// Search by text
mcp__agenthub__get_context(query: "authentication session handling")

// Filter by tags
mcp__agenthub__get_context(query: "auth", tags: ["security"])

// Browse everything from a specific topic
mcp__agenthub__get_context(query: "landscape", limit: 50)
```

**Note**: Full-text search works best with descriptive terms (4+ characters). Very short queries like "cli" or "api" may return fewer results than expected — use longer phrases or add tag filters.

## What's Next?

Once you're comfortable with context sharing, layer on more coordination:

- **[Research Team](research-team.md)** — 3 agents working in parallel with tasks and broadcasts
- **[Dev Pipeline](dev-pipeline.md)** — sequential handoffs with direct messaging and QA loops
