# Lattice Workflow Examples (LLM-Optimized)

Concrete multi-agent coordination patterns using Lattice MCP tools. Each example shows the exact tool call sequence.

---

## 1. Research Team Coordination

**Scenario:** Three researcher agents investigate different aspects of a topic. A lead agent synthesizes their findings.

### Setup Phase (Lead Agent)

```
# Lead creates research tasks and assigns them
create_task(
  agent_id: "lead",
  description: "Research competitor pricing models in the AI infrastructure market",
  status: "open",
  priority: "P1",
  assigned_to: "researcher-a"
)
# => { id: 1, version: 1 }

create_task(
  agent_id: "lead",
  description: "Research open-source alternatives and their adoption metrics",
  status: "open",
  priority: "P1",
  assigned_to: "researcher-b"
)
# => { id: 2, version: 1 }

create_task(
  agent_id: "lead",
  description: "Research enterprise buyer requirements and decision criteria",
  status: "open",
  priority: "P1",
  assigned_to: "researcher-c"
)
# => { id: 3, version: 1 }

# Synthesis task depends on all three research tasks
create_task(
  agent_id: "lead",
  description: "Synthesize research findings into executive summary",
  status: "open",
  priority: "P0",
  depends_on: [1, 2, 3]
)
# => { id: 4, version: 1 }
```

### Research Phase (Researcher A)

```
# Check for assigned work
list_tasks(status: "open", assigned_to: "researcher-a")

# Claim the task
update_task(
  agent_id: "researcher-a",
  task_id: 1,
  status: "claimed",
  version: 1
)

# Check existing knowledge first
get_context(query: "competitor pricing AI infrastructure")

# ... do the research ...

# Save findings to shared knowledge base
save_context(
  agent_id: "researcher-a",
  key: "competitor-pricing-analysis",
  value: "Found 8 competitors. Pricing ranges from $0.01-0.05 per API call...",
  tags: ["research", "pricing", "competitors"]
)

# Save detailed report as artifact
save_artifact(
  agent_id: "researcher-a",
  key: "pricing-comparison-table",
  content_type: "text/markdown",
  content: "| Competitor | Free Tier | Pro | Enterprise |\n|---|---|---|---|\n...",
  metadata: { "version": "1", "sources": 8 }
)

# Broadcast discovery
broadcast(
  agent_id: "researcher-a",
  event_type: "LEARNING",
  message: "Pricing analysis complete. Key finding: most competitors use per-API-call pricing. See context key: competitor-pricing-analysis",
  tags: ["research", "pricing"]
)

# Complete the task
update_task(
  agent_id: "researcher-a",
  task_id: 1,
  status: "completed",
  result: "Analyzed 8 competitors. Detailed pricing table saved as artifact.",
  version: 2
)
```

### Synthesis Phase (Lead Agent)

```
# Wait for all research tasks to complete
wait_for_event(
  since_id: 0,
  event_type: "TASK_UPDATE",
  timeout_sec: 60
)

# Check if synthesis task is unblocked
get_task(task_id: 4)
# => status: "open" (unblocked once tasks 1, 2, 3 are completed)

# Claim the synthesis task
update_task(
  agent_id: "lead",
  task_id: 4,
  status: "claimed",
  version: 1
)

# Gather all research findings
get_context(query: "competitor pricing", tags: ["research"])
get_context(query: "open-source alternatives", tags: ["research"])
get_context(query: "enterprise buyer requirements", tags: ["research"])

# Get the detailed artifacts
list_artifacts(content_type: "text/markdown")
get_artifact(key: "pricing-comparison-table")

# Save the synthesis
save_artifact(
  agent_id: "lead",
  key: "executive-summary-ai-market",
  content_type: "text/markdown",
  content: "# AI Infrastructure Market Analysis\n\n## Key Findings\n...",
  metadata: { "sources": ["researcher-a", "researcher-b", "researcher-c"] }
)

# Complete
update_task(
  agent_id: "lead",
  task_id: 4,
  status: "completed",
  result: "Executive summary saved as artifact: executive-summary-ai-market",
  version: 2
)
```

---

## 2. Development Pipeline (Playbook-Driven)

**Scenario:** A standard feature development pipeline: implement, test, review, deploy. Defined once as a playbook, reused for every feature.

### Define the Playbook (Once)

```
define_playbook(
  agent_id: "eng-lead",
  name: "feature-pipeline",
  description: "Standard feature development: implement, test, review, deploy",
  tasks: [
    {
      description: "Implement {{vars.feature}}: {{vars.requirements}}",
      role: "backend-eng"
    },
    {
      description: "Write tests for {{vars.feature}}",
      role: "test-eng",
      depends_on_index: [0]
    },
    {
      description: "Code review {{vars.feature}} implementation and tests",
      role: "reviewer",
      depends_on_index: [0, 1]
    },
    {
      description: "Deploy {{vars.feature}} to staging and verify",
      role: "deployer",
      depends_on_index: [2]
    }
  ]
)
```

### Run the Playbook

```
run_playbook(
  agent_id: "eng-lead",
  name: "feature-pipeline",
  vars: {
    "feature": "OAuth integration",
    "requirements": "Support GitHub and Google OAuth providers with PKCE flow"
  }
)
# => { workflow_run_id: 1, task_ids: [10, 11, 12, 13] }
```

### Backend Engineer Claims and Works

```
# Find tasks assigned to the backend-eng role
list_tasks(status: "open", assigned_to: "backend-eng")

# Or list tasks from the workflow run
get_task_graph(workflow_run_id: 1)

# Claim implementation task
update_task(
  agent_id: "backend-eng",
  task_id: 10,
  status: "claimed",
  version: 1
)

# Check for existing context
get_context(query: "OAuth", tags: ["architecture"])

# ... implement the feature ...

# Share implementation decisions
save_context(
  agent_id: "backend-eng",
  key: "oauth-implementation-notes",
  value: "Used passport.js for OAuth. GitHub and Google providers configured. PKCE enabled for both. Session stored in DB with 30-day TTL.",
  tags: ["oauth", "implementation", "architecture"]
)

# Complete with a summary
update_task(
  agent_id: "backend-eng",
  task_id: 10,
  status: "completed",
  result: "OAuth implemented with passport.js. Both GitHub and Google providers working. See context: oauth-implementation-notes",
  version: 2
)
```

### Monitor the Workflow

```
# Check overall workflow status at any time
get_workflow_run(id: 1)
# => Shows status of each task in the pipeline

# List all running workflows
list_workflow_runs(status: "running")
```

---

## 3. Bug Investigation (Triage to Fix)

**Scenario:** A bug is reported. An investigation agent triages, a developer fixes, and a QA agent verifies.

### Triage Phase

```
# Create the bug investigation task
create_task(
  agent_id: "triage-bot",
  description: "Investigate: Users report 500 errors on /api/v1/tasks endpoint when creating tasks with depends_on",
  priority: "P0"
)
# => { id: 20, version: 1 }

# Save the investigation findings
save_context(
  agent_id: "triage-bot",
  key: "bug-500-depends-on-investigation",
  value: "Root cause: depends_on validation fails when referenced task IDs belong to a different workspace. The foreign key check uses a global query instead of workspace-scoped. Stack trace points to models/task.ts:142.",
  tags: ["bug", "investigation", "tasks", "P0"]
)

# Create the fix task
create_task(
  agent_id: "triage-bot",
  description: "Fix: Scope depends_on validation to workspace in models/task.ts:142. See context: bug-500-depends-on-investigation",
  priority: "P0",
  assigned_to: "backend-eng",
  status: "open"
)
# => { id: 21, version: 1 }

# Create verification task
create_task(
  agent_id: "triage-bot",
  description: "Verify fix: Test depends_on with cross-workspace task IDs, confirm 400 instead of 500",
  priority: "P0",
  assigned_to: "qa-eng",
  status: "open",
  depends_on: [21]
)
# => { id: 22, version: 1 }

# Broadcast the triage result
broadcast(
  agent_id: "triage-bot",
  event_type: "ESCALATION",
  message: "P0 bug triaged: 500 on task creation with depends_on. Root cause identified. Fix task #21 assigned to backend-eng.",
  tags: ["bug", "P0", "tasks"]
)

# Complete triage
update_task(
  agent_id: "triage-bot",
  task_id: 20,
  status: "completed",
  result: "Root cause identified. Fix task #21 and verification task #22 created.",
  version: 1
)
```

### Fix Phase (Backend Engineer)

```
# Check messages and tasks
get_messages(agent_id: "backend-eng")
list_tasks(status: "open", assigned_to: "backend-eng")

# Claim the fix
update_task(
  agent_id: "backend-eng",
  task_id: 21,
  status: "claimed",
  version: 1
)

# Read the investigation context
get_context(query: "bug-500-depends-on")

# ... implement the fix ...

# Notify the team
broadcast(
  agent_id: "backend-eng",
  event_type: "TASK_UPDATE",
  message: "Fix deployed for depends_on workspace scoping bug. Ready for verification.",
  tags: ["bug", "fix", "tasks"]
)

update_task(
  agent_id: "backend-eng",
  task_id: 21,
  status: "completed",
  result: "Fixed workspace-scoped validation in models/task.ts. Added workspace_id to the EXISTS check.",
  version: 2
)
```

### Verify Phase (QA Engineer)

```
# Task 22 is now unblocked since task 21 is completed
list_tasks(status: "open", assigned_to: "qa-eng")

update_task(
  agent_id: "qa-eng",
  task_id: 22,
  status: "claimed",
  version: 1
)

# ... run verification tests ...

save_context(
  agent_id: "qa-eng",
  key: "bug-500-verification-result",
  value: "Verified: cross-workspace depends_on now returns 400 NOT_FOUND instead of 500. Same-workspace depends_on still works correctly. Regression test added.",
  tags: ["bug", "verification", "tasks"]
)

update_task(
  agent_id: "qa-eng",
  task_id: 22,
  status: "completed",
  result: "Verified. Fix confirmed working. Regression test added.",
  version: 2
)

broadcast(
  agent_id: "qa-eng",
  event_type: "BROADCAST",
  message: "P0 bug fix verified. depends_on cross-workspace issue is resolved.",
  tags: ["bug", "resolved", "P0"]
)
```

---

## 4. Parallel Execution with Dependencies

**Scenario:** Multiple independent tasks that fan out, then converge into a single aggregation step.

```
# Fan-out: create parallel independent tasks
create_task(
  agent_id: "coordinator",
  description: "Analyze frontend performance metrics",
  status: "open",
  priority: "P1",
  assigned_to: "frontend-eng"
)
# => { id: 30 }

create_task(
  agent_id: "coordinator",
  description: "Analyze backend API latency metrics",
  status: "open",
  priority: "P1",
  assigned_to: "backend-eng"
)
# => { id: 31 }

create_task(
  agent_id: "coordinator",
  description: "Analyze database query performance",
  status: "open",
  priority: "P1",
  assigned_to: "dba"
)
# => { id: 32 }

# Fan-in: aggregation task depends on all three
create_task(
  agent_id: "coordinator",
  description: "Compile performance report from all analysis results",
  status: "open",
  priority: "P0",
  depends_on: [30, 31, 32],
  assigned_to: "lead-eng"
)
# => { id: 33 }

# Visualize the dependency graph
get_task_graph(status: "open,claimed")
# => { nodes: [{id:30,...}, {id:31,...}, {id:32,...}, {id:33,...}],
#      edges: [{from:30, to:33}, {from:31, to:33}, {from:32, to:33}] }
```

Each analyst works independently. Task 33 cannot be claimed until 30, 31, and 32 are all completed.

---

## 5. Agent Handoff via Direct Messaging

**Scenario:** A research agent completes analysis and hands off to a design agent, who then hands off to a review agent.

### Research to Design Handoff

```
# Researcher completes work and saves outputs
save_context(
  agent_id: "researcher",
  key: "user-research-findings",
  value: "Interviewed 12 users. Top pain points: 1) Slow onboarding (avg 15 min), 2) No team visibility, 3) Manual task tracking. Users want a dashboard showing team activity.",
  tags: ["research", "user-interviews", "dashboard"]
)

save_artifact(
  agent_id: "researcher",
  key: "user-interview-transcripts",
  content_type: "application/json",
  content: "[{\"user\": \"U1\", \"quotes\": [\"I can never tell what my team is working on...\"]}, ...]"
)

# Direct handoff message
send_message(
  agent_id: "researcher",
  to: "designer",
  message: "User research complete. Key findings in context: user-research-findings. Full interview data in artifact: user-interview-transcripts. Top request is a team activity dashboard. Please design the dashboard wireframe.",
  tags: ["handoff", "dashboard"]
)
```

### Design Phase

```
# Designer checks messages
get_messages(agent_id: "designer")

# Read the research
get_context(query: "user research findings", tags: ["research"])
get_artifact(key: "user-interview-transcripts")

# ... create the design ...

# Save the design output
save_artifact(
  agent_id: "designer",
  key: "dashboard-wireframe-v1",
  content_type: "text/html",
  content: "<!DOCTYPE html><html>...<div class='dashboard'>...</div></html>",
  metadata: { "version": "1", "based_on": "user-research-findings" }
)

# Hand off to reviewer
send_message(
  agent_id: "designer",
  to: "reviewer",
  message: "Dashboard wireframe ready for review. Artifact key: dashboard-wireframe-v1. Based on user research findings -- addresses all three pain points identified.",
  tags: ["handoff", "review", "dashboard"]
)
```

### Review Phase

```
# Reviewer picks up
get_messages(agent_id: "reviewer")
get_artifact(key: "dashboard-wireframe-v1")
get_context(query: "user research", tags: ["dashboard"])

# ... review ...

# Feedback via message
send_message(
  agent_id: "reviewer",
  to: "designer",
  message: "Dashboard looks good overall. Two changes requested: 1) Add real-time event feed (addresses pain point #2), 2) Show task completion stats prominently. See context: dashboard-review-feedback",
  tags: ["review", "feedback", "dashboard"]
)

save_context(
  agent_id: "reviewer",
  key: "dashboard-review-feedback",
  value: "Approved with changes: add real-time event feed, show task completion stats. Overall design addresses user pain points well.",
  tags: ["review", "dashboard", "feedback"]
)
```

---

## 6. Scheduled Automation

**Scenario:** Set up a daily health check that runs automatically.

### Define the Playbook

```
define_playbook(
  agent_id: "ops-lead",
  name: "daily-health-check",
  description: "Run daily system health checks and compile a report",
  tasks: [
    {
      description: "Check API response times and error rates for {{vars.date}}",
      role: "monitor"
    },
    {
      description: "Check database performance metrics for {{vars.date}}",
      role: "dba-monitor"
    },
    {
      description: "Compile health report from monitoring data for {{vars.date}}",
      role: "reporter",
      depends_on_index: [0, 1]
    }
  ]
)
```

### Schedule It

```
define_schedule(
  agent_id: "ops-lead",
  playbook_name: "daily-health-check",
  cron_expression: "0 9 * * *",
  enabled: true
)
# => { id: 1, next_run_at: "2026-04-07T09:00:00.000Z" }

# Check existing schedules
list_schedules()
```

The scheduler tick runs every 30 seconds. At 09:00 UTC daily, it auto-runs the playbook, creating three tasks with proper dependencies.

### Monitor Runs

```
# Check recent workflow runs
list_workflow_runs(status: "running")
list_workflow_runs(status: "completed", limit: 5)

# Get details of a specific run
get_workflow_run(id: 42)
```

---

## 7. External Integration (Inbound Webhooks)

**Scenario:** GitHub push events automatically create Lattice tasks.

### Set Up the Endpoint

```
define_inbound_endpoint(
  agent_id: "ops",
  name: "GitHub Push Handler",
  action_type: "create_task",
  action_config: {
    "description_template": "Review push to {{body.ref}} by {{body.pusher.name}}: {{body.head_commit.message}}"
  },
  hmac_secret: "your-github-webhook-secret"
)
# => { id: 1, endpoint_key: "abc123def456" }
```

Configure GitHub to send push webhooks to: `POST https://your-lattice-host/api/v1/inbound/abc123def456`

### Trigger a Playbook from Webhook

```
# Create an endpoint that triggers a deployment playbook
define_inbound_endpoint(
  agent_id: "ops",
  name: "Deploy on Push to Main",
  action_type: "run_playbook",
  action_config: {
    "playbook_name": "deploy-pipeline",
    "vars_from_payload": {
      "branch": "body.ref",
      "commit": "body.head_commit.id"
    }
  },
  hmac_secret: "deploy-webhook-secret"
)
```

### List and Manage Endpoints

```
list_inbound_endpoints()
# => [{ id: 1, name: "GitHub Push Handler", action_type: "create_task", ... }, ...]

# Remove an endpoint
delete_inbound_endpoint(agent_id: "ops", endpoint_id: 1)
```

---

## Common Patterns Summary

| Pattern | Tools Used | Description |
|---------|-----------|-------------|
| **Fan-out/Fan-in** | `create_task` with `depends_on` | Multiple parallel tasks converging into one |
| **Playbook Reuse** | `define_playbook` + `run_playbook` | Templated multi-step workflows |
| **Agent Handoff** | `send_message` + `save_context` + `save_artifact` | Sequential agent pipeline |
| **Event-Driven** | `broadcast` + `wait_for_event` | React to team events without polling |
| **Scheduled Ops** | `define_playbook` + `define_schedule` | Recurring automated workflows |
| **External Trigger** | `define_inbound_endpoint` | Webhook-driven task creation |
| **Knowledge Sharing** | `save_context` + `get_context` | Cross-agent knowledge base |
| **Progress Tracking** | `get_workflow_run` + `get_task_graph` | Monitor multi-step workflows |

---

## Anti-Patterns to Avoid

1. **Tight polling loops** -- Use `wait_for_event` instead of calling `get_updates` in a loop.
2. **Large context entries** -- Use `save_artifact` for structured outputs over 100 KB; `save_context` is for learnings.
3. **Forgetting optimistic locking** -- Always include `version` in `update_task`. On 409 conflict, call `get_task` to get the latest version and retry.
4. **Generic keys** -- Use descriptive keys like `"oauth-implementation-notes"`, not `"finding-1"`.
5. **Skipping knowledge checks** -- Always `get_context` before starting research to avoid duplicate work.
6. **Missing heartbeats** -- For long tasks, call `heartbeat` periodically or your claimed tasks may be reaped after 30 minutes.
7. **Secrets in content** -- The secret scanner blocks API keys and tokens. Redact before saving.
