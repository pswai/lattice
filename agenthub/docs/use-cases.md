# Lattice Use Cases

Lattice scales from a solo developer running multiple AI sessions to enterprise teams coordinating hundreds of agents. Whether you need shared context across your own sessions, team-wide agent coordination, or a fully governed agent fleet with audit trails, the same 35 MCP tools cover it all. No new abstractions at each tier -- just deeper adoption of the same primitives.

The use cases below are organized into three tiers. Each one describes a real workflow pain point, shows the before and after, and names the exact Lattice tools involved.

---

## Tier 1: Individual Developer

Five scenarios for a single developer getting more out of multiple AI sessions.

---

### 1. The Context Amnesia Cure

**Persona:** Solo full-stack developer running 3 Claude Code sessions on a monorepo.

**Before:** Each session starts from scratch. Session A refactors the auth module and renames every endpoint, but Session B -- started five minutes later -- generates integration code against the old API surface. You catch the mismatch an hour in, after a wall of type errors. Session C rewrites the same utility function that Session A already fixed. Every session is an island.

**After:** Session A finishes the auth refactor and calls `save_context` with key `"auth-refactor-v2-endpoints"` and tags `["auth", "api", "breaking-change"]`, then `broadcast` with event type `LEARNING` so the bus carries the news. Session B calls `get_context(query: "auth endpoints")` on startup and immediately works against the new interface. No type errors, no wasted hour.

**The wow moment:** You spin up a fourth session two days later. It calls `get_context(query: "auth")` and already knows about the refactor, the new endpoint names, and the migration notes -- as if it had been in the room the whole time.

**Tools:** `save_context`, `broadcast`, `get_context`

---

### 2. The Side-Project Assembly Line

**Persona:** Indie hacker building an MVP on weekends, shipping one feature per Sunday.

**Before:** Every feature follows the same steps -- implement, write tests, update docs, lint -- but you orchestrate it manually by copy-pasting prompts between terminal windows. You forget the docs step half the time. Quality is inconsistent.

**After:** On Saturday you call `define_playbook` with name `"feature-ship"` and a task DAG: implement (role: `"backend-eng"`), then tests (role: `"test-eng"`, `depends_on_index: [0]`), then docs (role: `"docs-writer"`, `depends_on_index: [1]`), then lint (role: `"reviewer"`, `depends_on_index: [2]`). On Sunday you call `run_playbook(name: "feature-ship", vars: { "feature": "Stripe checkout" })` and the pipeline runs itself.

**The wow moment:** You define the playbook once on Saturday. Every Sunday feature -- Stripe checkout, email notifications, usage dashboard -- follows the exact same quality pipeline with zero manual orchestration. `list_workflow_runs` shows a clean history of every feature you have shipped.

**Tools:** `define_playbook`, `run_playbook`, `list_workflow_runs`

---

### 3. The Research Swarm

**Persona:** Developer evaluating 5 competing state-management libraries before committing to one.

**Before:** Five browser tabs, scattered notes, a half-finished comparison spreadsheet. By the time you finish library #4, you have forgotten the bundle-size numbers from library #1. The comparison doc is never completed.

**After:** You spin up 5 sessions. Each evaluates one library and calls `save_context` with a structured key like `"eval-zustand-bundle-size"` and tags `["eval", "state-management", "zustand"]`. A sixth coordinator session calls `get_context(query: "eval state-management", tags: ["eval"])` and synthesizes the results into a comparison artifact via `save_artifact(key: "state-mgmt-comparison", content_type: "text/markdown", ...)`.

**The wow moment:** All five evaluations run in parallel. The coordinator synthesizes the findings into a polished comparison table before your coffee is ready. `get_artifact(key: "state-mgmt-comparison")` gives you the final recommendation any time you need it.

**Tools:** `save_context`, `get_context`, `save_artifact`, `get_artifact`

---

### 4. The Persistent Knowledge Garden

**Persona:** Solo developer who keeps rediscovering the same workarounds for a gnarly codebase.

**Before:** Six weeks ago you figured out that the ORM silently drops `NULL` values in bulk upserts and the workaround is a raw SQL fallback. Today you hit the same bug. You have no idea where you documented the fix -- maybe a Slack DM to yourself, maybe a code comment you later deleted.

**After:** Every time you discover a workaround, you call `save_context` with a descriptive key like `"orm-bulk-upsert-null-workaround"` and tags `["orm", "postgres", "workaround", "upsert"]`. Six weeks later, your agent calls `get_context(query: "bulk upsert null")` and the FTS5 trigram index surfaces the exact entry with the raw SQL fallback.

**The wow moment:** Your agent finds the six-week-old workaround mid-task, applies it without prompting, and moves on. You never even notice the bug resurfaced.

**Tools:** `save_context`, `get_context`

---

### 5. The Nightly Health Check

**Persona:** Solo open-source maintainer with a project that has 200 stars and zero CI budget.

**Before:** You manually run lint, tests, and `npm audit` whenever you remember, which is roughly once a month. A critical vulnerability in a transitive dependency sits unnoticed for weeks.

**After:** You call `define_playbook` with name `"nightly-health"` containing three tasks: lint (role: `"linter"`), test suite (role: `"tester"`), and dependency audit (role: `"auditor"`). Then `define_schedule(playbook_name: "nightly-health", cron_expression: "0 3 * * *")` runs it every day at 3 AM UTC. Each morning you call `list_workflow_runs` to check results.

**The wow moment:** You wake up Monday morning, call `get_workflow_run` on last night's run, and see the auditor task flagged a critical CVE in a dependency that was published 14 hours ago. You patch it before any user is affected.

**Tools:** `define_playbook`, `define_schedule`, `list_workflow_runs`, `get_workflow_run`

---

## Tier 2: Small Team

Five scenarios for teams of 3-10 people coordinating agents across a shared workspace.

---

### 1. The GitHub-to-Agent Pipeline

**Persona:** CTO of a 5-person startup who wants agents triaging bugs overnight.

**Before:** A customer files a bug on GitHub at 2 AM. Nobody sees it until standup at 10 AM. The engineer spends 30 minutes just reproducing it.

**After:** You call `define_inbound_endpoint` with `action_type: "create_task"` and `action_config: { "description_template": "GitHub issue: {{body.title}}\n\n{{body.body}}" }`, then point your GitHub webhook at the returned endpoint URL. When the issue lands, Lattice creates a task automatically. An agent calls `list_tasks(status: "open")`, claims the bug, investigates, and calls `save_context` with the root-cause analysis.

**The wow moment:** A customer files a bug at 2 AM. By 2:01 AM, an agent has the root-cause analysis saved to context with key `"bug-issue-347-root-cause"`. When your engineer opens their laptop at 9 AM, the fix is already drafted.

**Tools:** `define_inbound_endpoint`, `list_tasks`, `update_task`, `save_context`

---

### 2. The Shared Agent Brain

**Persona:** Tech lead on a 6-person team where every agent session keeps relearning the same conventions.

**Before:** Your team uses a specific error-handling pattern, a particular folder structure, and an internal API client wrapper. Every new agent session rediscovers these patterns by trial and error, wasting the first 10 minutes of every task on avoidable mistakes.

**After:** You call `define_profile` with name `"backend-eng"` containing a system prompt that encodes your error-handling conventions, folder structure, and API client usage. You also `save_context` entries for evolving architectural decisions like `"adr-002-event-sourcing-decision"`. Every agent session starts with `get_profile(name: "backend-eng")` and `get_context(query: "architectural decisions")`.

**The wow moment:** A new hire's first agent session calls `get_profile` and `get_context`, and immediately knows every architectural decision, naming convention, and team pattern. Their first PR follows every convention without a single review comment about style.

**Tools:** `define_profile`, `get_profile`, `save_context`, `get_context`

---

### 3. The PR Review Relay

**Persona:** Engineering lead at a 7-person company shipping daily, tired of PRs blocking on human review cycles.

**Before:** A PR sits open for hours waiting on review. Feedback requires switching contexts, reading the diff, writing comments, then the author switching back to address them. Three rounds of feedback take a full day.

**After:** The author agent saves the diff as an artifact with `save_artifact(key: "pr-147-diff", content_type: "text/plain", ...)` and creates a review task with `create_task(description: "Review PR #147", assigned_to: "reviewer-agent")`. The reviewer claims it, reviews the artifact, and sends feedback via `send_message(to: "author-agent", message: "3 issues found: ...")`. The author calls `get_messages`, iterates, and saves the updated diff.

**The wow moment:** A PR goes from draft to approved with 3 rounds of agent-driven feedback in 90 seconds. The human engineer reviews only the final, polished version.

**Tools:** `save_artifact`, `create_task`, `update_task`, `send_message`, `get_messages`

---

### 4. The Sprint Standup Bot

**Persona:** Product manager at a 10-person startup, tired of spending 30 minutes assembling standup notes.

**Before:** Every morning you piece together updates from Slack threads, GitHub notifications, and Jira. Half the updates are stale by the time you compile them. The standup meeting itself is just reading from your hastily assembled notes.

**After:** You create a playbook named `"daily-standup"` with two tasks: a data-gatherer that calls `get_analytics` for workspace activity stats and `get_context(query: "completed yesterday", tags: ["standup"])`, and a report-compiler that calls `save_artifact(key: "standup-2026-04-07", content_type: "text/markdown", ...)` with a formatted summary. `define_schedule(playbook_name: "daily-standup", cron_expression: "0 9 * * *")` runs it at 9 AM UTC daily. An outbound webhook pushes the artifact to Slack.

**The wow moment:** At 9:05 AM, a formatted standup summary -- with completed tasks, blockers, and workspace health metrics -- posts itself to your team Slack channel. The standup meeting becomes a 5-minute discussion instead of a 30-minute status read-out.

**Tools:** `define_playbook`, `define_schedule`, `get_analytics`, `get_context`, `save_artifact`

---

### 5. The Incident Response Playbook

**Persona:** On-call engineer at a growing startup, dreading the 3 AM PagerDuty alert.

**Before:** Your phone buzzes at 3 AM. You stumble to your laptop, try to remember which runbook applies, manually check logs, recent deploys, and database metrics. By the time you have a hypothesis, 45 minutes have passed and the CEO is asking for an update.

**After:** You call `define_inbound_endpoint` with `action_type: "run_playbook"` and `action_config: { "playbook_name": "incident-response" }`, then point PagerDuty at it. The playbook fans out three parallel tasks: log analysis (role: `"log-investigator"`), recent deploy audit (role: `"deploy-auditor"`), and database health check (role: `"db-monitor"`). Each agent saves findings with `save_context` tagged `["incident", "p1"]`. A fourth synthesizer task (`depends_on_index: [0, 1, 2]`) compiles the root-cause analysis into an artifact.

**The wow moment:** By the time you open your laptop at 3:12 AM, the agents have already narrowed the issue to a specific commit in the last deploy. You call `get_artifact(key: "incident-2026-04-07-root-cause")` and have a one-page root-cause analysis ready to share with the team.

**Tools:** `define_inbound_endpoint`, `define_playbook`, `run_playbook`, `save_context`, `save_artifact`, `get_artifact`

---

## Tier 3: Enterprise

Five scenarios for organizations with dozens of teams and hundreds of agents.

---

### 1. The Compliance Audit Trail

**Persona:** VP of Engineering at a fintech with 200 engineers, preparing for a SOC 2 audit.

**Before:** Auditors ask "What actions did your AI agents take on customer data last quarter?" and you spend two weeks combing through scattered logs, Slack messages, and Git history. Half the audit evidence is reconstructed from memory.

**After:** Every agent calls `register_agent` at startup with capabilities and metadata. All work flows through `create_task` and `update_task`, creating a complete state-transition log. Learnings go through `save_context` with tags like `["pii", "customer-data"]`. When the auditor asks, you call `export_workspace_data` and hand them a complete, timestamped snapshot of every agent registration, task transition, context entry, and event -- with secrets automatically redacted.

**The wow moment:** The SOC 2 auditor asks for a full accounting of agent actions over the last quarter. You answer with a single API call. `export_workspace_data` produces the complete audit snapshot in under a second. The audit item that used to take two weeks closes in an afternoon.

**Tools:** `register_agent`, `create_task`, `update_task`, `save_context`, `export_workspace_data`

---

### 2. The Cross-Team Knowledge Mesh

**Persona:** Platform team lead responsible for 12 squads across 4 product areas.

**Before:** Knowledge is siloed in team Slack channels. The payments team solved a Redis connection pooling issue three months ago, but the notifications team hits the same problem today and spends a full sprint debugging it from scratch. Nobody knows what other teams know.

**After:** Every squad's agents call `save_context` with team-specific tags like `["payments", "redis", "connection-pooling"]`. When the notifications team's agent starts investigating a Redis timeout, it calls `get_context(query: "redis connection pooling")` and surfaces the payments team's fix from last quarter -- complete with the configuration change and the reasoning behind it.

**The wow moment:** A new team's agent finds and applies an optimization that another team discovered last quarter, with zero human coordination. The fix that took the first team a sprint takes the second team 10 minutes.

**Tools:** `save_context`, `get_context`

---

### 3. The Governed Agent Fleet

**Persona:** CISO at a healthcare company with strict data governance requirements.

**Before:** 300 AI agent sessions run across the engineering org with no central visibility. You have no idea which agents are active, what they are working on, or whether any of them are accidentally including PHI in their outputs. Your compliance team is nervous.

**After:** Every agent calls `register_agent` with role metadata and `heartbeat` to maintain online status. `list_agents` shows the full fleet in real time -- who is active, what capabilities they have declared, and when they last checked in. The built-in secret scanner blocks any `save_context`, `broadcast`, or `send_message` call that contains API keys, tokens, or connection strings. RBAC-scoped API keys limit each team's agents to their own workspace.

**The wow moment:** You pull up `list_agents` and see a real-time view of all 300 agents across the org -- online status, capabilities, last heartbeat. Your compliance team can verify that no agent has leaked credentials because the secret scanner blocks it at the write layer. The security review that used to take a week becomes a 15-minute dashboard check.

**Tools:** `register_agent`, `heartbeat`, `list_agents`, `save_context` (secret scanning), `broadcast` (secret scanning)

---

### 4. The Multi-Team Release Train

**Persona:** Release manager coordinating deployments across 8 microservices owned by 8 different teams.

**Before:** You maintain a spreadsheet tracking which services need to deploy in which order. Teams deploy out of sequence, breaking downstream contracts. The last release took a full day of manual coordination on Slack, with three rollbacks.

**After:** You call `define_playbook` with a master deployment DAG. The API gateway deploys first (index 0). Auth service depends on the gateway (`depends_on_index: [0]`). User service and billing service both depend on auth (`depends_on_index: [1]`). And so on through all 8 services. `run_playbook` instantiates the full release. Each team's agent claims their service's task, deploys, and calls `update_task(status: "completed")`. `get_task_graph` shows the full DAG with real-time status.

**The wow moment:** You call `get_task_graph` and watch the deployment DAG light up green node by node. Eight teams deploy in perfect dependency order in 40 minutes -- versus a full day of manual coordination. Zero rollbacks.

**Tools:** `define_playbook`, `run_playbook`, `update_task`, `get_task_graph`

---

### 5. The Enterprise Onboarding Accelerator

**Persona:** Director of Developer Experience at a company with 500 engineers and 30-day average time-to-productivity for new hires.

**Before:** New engineers spend 2-3 weeks absorbing tribal knowledge: which patterns the team uses, which libraries are blessed, where the gotchas are. Most of this knowledge lives in senior engineers' heads or buried in old Slack threads. Onboarding docs are perpetually out of date.

**After:** Each team calls `define_profile` with their role definition -- system prompt, conventions, approved libraries, common pitfalls. Over time, agents continuously `save_context` as they discover and apply team patterns, building an ever-growing institutional knowledge base. A new hire's agent calls `get_profile(name: "payments-backend-eng")` to load the team role, then `get_context(query: "conventions patterns", tags: ["payments"])` to absorb months of accumulated decisions.

**The wow moment:** A new engineer joins the payments team on Monday. Their agent calls `get_profile` and `get_context`, absorbs six months of architectural decisions, naming conventions, and deployment patterns, and opens a convention-following PR on day one. Time-to-first-PR drops from 2 weeks to 1 day.

**Tools:** `define_profile`, `get_profile`, `save_context`, `get_context`
