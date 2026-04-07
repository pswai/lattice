# Lattice Use Cases

Lattice is a coordination layer for AI agent teams. But you might wonder: doesn't Claude Code already have tasks, memory, and messaging built in?

**Yes -- and that's fine for single-session work.** Claude Code's built-in features are great for one conversation at a time. Lattice solves what happens *between* sessions, *across* tools, and *at scale*:

| Need | Claude Code Built-in | What Lattice Adds |
|------|---------------------|-------------------|
| Remember decisions | MEMORY.md (per-project, manual) | Searchable knowledge base with FTS5 + tags across all sessions |
| Track tasks | TaskCreate (session-local, cleared on exit) | Persistent task queue with DAG dependencies, claimable by any agent |
| Agent messaging | SendMessage (within one team session) | Pub/sub event bus + long-polling across independent sessions |
| Automation | None | Playbooks, cron scheduling, inbound webhooks |
| Observability | None | Dashboard, audit log, analytics, Prometheus metrics |
| Works with | Claude Code only | Any MCP client (Claude Code, Cursor, custom agents) |

**Use Claude Code's built-in tools when:** you're working in a single session and don't need persistence or automation.

**Add Lattice when:** you need knowledge that survives sessions, tasks that multiple agents can claim, automated pipelines, external integrations, or a dashboard to see what's happening.

---

## Tier 1: Individual Developer

For a solo developer getting more out of multiple AI sessions.

---

### 1. The Searchable Knowledge Base

**Persona:** Solo developer running multiple Claude Code sessions across a full-stack project.

**Why not just use MEMORY.md?** MEMORY.md is a flat file you (or Claude) manually curate. It's capped at ~25 KB auto-loaded, has no search, and lives per-project. When you've saved 200 decisions over 3 months, finding "that webpack workaround from February" means scrolling through everything.

**With Lattice:** Each session calls `save_context(key: "webpack-css-modules-fix", value: "...", tags: ["webpack", "css", "workaround"])`. Three months later, any session calls `get_context(query: "webpack css")` and FTS5 trigram matching surfaces it instantly -- even partial matches like "webp" work. Tags let you filter by topic without remembering exact keys.

**The real value:** Your knowledge base grows automatically as agents work, and any session can search it programmatically. No manual curation required.

---

### 2. The Assembly Line

**Persona:** Indie hacker building an MVP on weekends.

**Why not just use Claude Code tasks?** Claude Code's TaskCreate is session-local -- tasks vanish when the session ends. You can't define a reusable pipeline that runs the same way every time.

**With Lattice:** Call `define_playbook(name: "feature-ship", tasks: [{description: "Implement {{vars.feature}}"}, {description: "Write tests", depends_on_index: [0]}, {description: "Update docs", depends_on_index: [1]}])` once. Every feature is `run_playbook(vars: {feature: "Stripe checkout"})` -- tasks auto-chain via DAG dependencies. If you close your laptop and come back Sunday, the tasks are still there waiting.

**The real value:** Repeatable quality pipelines that persist across sessions. Define once, use forever.

---

### 3. The Research That Survives

**Persona:** Developer evaluating 5 competing libraries for a project.

**Why not just use Claude Code subagents?** You can spin up subagents for parallel research, and they'll report back. But findings die with the session. Next week when you revisit, you start from scratch.

**With Lattice:** Each research agent saves structured findings via `save_context` with tags like `["eval", "orm", "prisma"]`. A synthesis agent calls `get_context(query: "orm evaluation")` and compiles a comparison matrix saved as `save_artifact(content_type: "text/markdown")`. Next week, next month -- the research is still there, searchable.

**The real value:** Research compounds. New sessions build on old findings instead of rediscovering them.

---

### 4. The Nightly Health Check

**Persona:** Solo maintainer of an open-source project.

**Why can't Claude Code do this?** Claude Code has no scheduling or automation. You'd have to manually open a session and run checks.

**With Lattice:** `define_playbook(name: "nightly-health", tasks: [{description: "Run lint + test suite"}, {description: "Check dependency vulnerabilities", depends_on_index: [0]}])`. Then `define_schedule(cron_expression: "0 3 * * *")` to run it every night at 3 AM. Check `list_workflow_runs` each morning for pass/fail.

**The real value:** Automated, recurring agent workflows. No human needed to kick them off.

---

## Tier 2: Small Team (2-10 people)

For teams where multiple developers' agents need to coordinate.

---

### 5. The GitHub-to-Agent Pipeline

**Persona:** 5-person startup where every engineer uses AI agents.

**Why can't Claude Code do this?** Claude Code has no way to receive external events. There's no webhook receiver or integration with GitHub, PagerDuty, Slack, etc.

**With Lattice:** `define_inbound_endpoint(name: "github-issues", action_type: "create_task", action_config: {description_template: "GitHub issue: {{body.title}} -- {{body.body}}"})`. Configure GitHub to POST to the returned URL. Issues automatically become Lattice tasks. The next available agent claims and investigates.

**The real value:** External systems drive agent workflows without any human in the loop.

---

### 6. The Shared Agent Brain

**Persona:** Small team where each developer's agents keep relearning project conventions.

**Why not just use CLAUDE.md?** CLAUDE.md gives static project instructions to one project. It doesn't evolve, isn't searchable, and different team members' agents in different repos can't access it.

**With Lattice:** `define_profile(name: "backend-eng", system_prompt: "We use Zod for validation, envelope format for API responses...")` encodes conventions once. `save_context` captures evolving decisions as they're made. Any agent on any team member's machine -- running Claude Code, Cursor, or anything that speaks MCP -- calls `get_profile` and `get_context` to be immediately fluent.

**The real value:** Framework-agnostic team knowledge. Works across Claude Code, Cursor, and custom agents. Knowledge evolves as the team makes decisions.

---

### 7. The Sprint Standup Bot

**Persona:** Product manager at a small startup.

**Why can't Claude Code do this?** No scheduling, no analytics aggregation, no webhook delivery to Slack.

**With Lattice:** A scheduled playbook runs daily at 9 AM, calling `get_analytics(since: "24h")` for task completion stats, `get_context(tags: ["standup"])` for yesterday's findings, and `save_artifact` with a formatted standup report. An outbound webhook delivers it to Slack.

**The real value:** Automated daily intelligence delivered to your team's Slack without anyone opening a terminal.

---

### 8. The Incident Response Playbook

**Persona:** On-call engineer at a fast-moving startup.

**Why can't Claude Code do this?** No inbound webhooks (can't receive PagerDuty alerts), no playbook fan-out (can't spawn coordinated parallel investigation), no persistent findings across the investigation.

**With Lattice:** An inbound webhook from PagerDuty triggers `run_playbook(name: "incident-response", vars: {service: "payments-api"})`. Tasks auto-fan-out: one agent checks logs, another reviews recent deploys, a third queries the DB. All findings land in `save_context` with tag `["incident"]`. A synthesizer agent compiles the root-cause artifact.

**The real value:** Coordinated multi-agent incident response triggered automatically by your alerting system.

---

## Tier 3: Enterprise (50+ engineers)

For organizations running AI agents at scale with governance requirements.

---

### 9. The Compliance Audit Trail

**Persona:** Engineering VP at a fintech with 200 engineers using AI agents.

**Why can't Claude Code do this?** Claude Code has no audit log, no data export, no RBAC scopes. There's no way to answer "which AI agent modified this system and when?"

**With Lattice:** Every agent action flows through Lattice: `register_agent` provides identity, `create_task`/`update_task` logs every state transition, and the append-only audit log records every mutating API call with timestamps, agent IDs, and request IDs. `export_workspace_data` produces a secrets-redacted snapshot. RBAC-scoped API keys (read/write/admin) enforce least privilege.

**The real value:** Complete, auditable trace of every AI agent action. One API call produces the SOC 2 evidence.

---

### 10. The Cross-Team Knowledge Mesh

**Persona:** Platform team lead at a company with 12 engineering squads.

**Why not just use per-project memory?** MEMORY.md is scoped to a single project directory. The payments team's Kafka tuning discovery never reaches the search team hitting the same issue.

**With Lattice:** Each squad's agents save findings to their workspace's knowledge base. Agents call `get_context(query: "kafka consumer lag")` and discover fixes from other teams. Cross-workspace knowledge sharing turns siloed discoveries into organizational intelligence.

**The real value:** Knowledge flows between teams automatically. No Slack threads, no Confluence pages nobody reads.

---

### 11. The Governed Agent Fleet

**Persona:** CISO at a healthcare company with strict data handling requirements.

**Why can't Claude Code do this?** No centralized agent registry, no heartbeat monitoring, no secret scanning on shared state, no RBAC enforcement across agents.

**With Lattice:** `list_agents` shows every registered agent with capabilities and status. `heartbeat` monitoring reveals stale agents. Secret scanning (20+ regex patterns) blocks credentials from entering shared state. RBAC-scoped keys limit what each agent can do. `get_analytics` dashboards show activity across the fleet.

**The real value:** Visibility and governance over your entire AI agent fleet from a single dashboard.

---

### 12. The Multi-Team Release Train

**Persona:** Release manager coordinating deploys across 8 microservices owned by 8 teams.

**Why can't Claude Code do this?** No persistent cross-team task DAG, no visualization, no cross-framework coordination.

**With Lattice:** A master playbook with `depends_on_index` encodes the deploy DAG: database migrations before API servers, API servers before frontends. `run_playbook(vars: {version: "4.2.0"})` kicks off the release. Each team's agent claims its deploy task. `get_task_graph` visualizes the DAG in the dashboard as nodes light up green.

**The real value:** Dependency-ordered multi-team deploys with real-time DAG visualization. A full-day process in 40 minutes.

---

### 13. The Enterprise Onboarding Accelerator

**Persona:** Director of developer experience at a 500-person engineering org.

**Why not just write better CLAUDE.md files?** CLAUDE.md is static, per-project, and manually maintained. It doesn't capture the evolving tribal knowledge that agents discover while working.

**With Lattice:** `define_profile(name: "platform-eng")` encodes team-specific roles with curated system prompts. The shared knowledge base -- populated over months of agents calling `save_context` -- contains architectural decisions, API patterns, and gotchas. A new hire's first agent session calls `get_profile` and `get_context(query: "onboarding")` and inherits months of accumulated team intelligence.

**The real value:** Institutional knowledge that grows organically as agents work, not manually maintained documentation.
