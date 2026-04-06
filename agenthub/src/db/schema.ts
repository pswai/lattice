export const SCHEMA_SQL = `
-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT,
    slug TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- API keys for workspace authentication
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'write' CHECK(scope IN ('read', 'write', 'admin')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- Context entries — append-only shared knowledge base
CREATE TABLE IF NOT EXISTS context_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_by TEXT,
    updated_at TEXT,
    UNIQUE(workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_context_workspace ON context_entries(workspace_id);
CREATE INDEX IF NOT EXISTS idx_context_created ON context_entries(created_at);

-- FTS5 virtual table for full-text search on context entries.
-- Uses trigram tokenizer so short queries and middle-of-word fragments match.
CREATE VIRTUAL TABLE IF NOT EXISTS context_entries_fts USING fts5(
    key,
    value,
    tags,
    content='context_entries',
    content_rowid='id',
    tokenize='trigram'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS context_entries_ai AFTER INSERT ON context_entries BEGIN
    INSERT INTO context_entries_fts(rowid, key, value, tags)
    VALUES (new.id, new.key, new.value, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS context_entries_ad AFTER DELETE ON context_entries BEGIN
    INSERT INTO context_entries_fts(context_entries_fts, rowid, key, value, tags)
    VALUES ('delete', old.id, old.key, old.value, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS context_entries_au AFTER UPDATE ON context_entries BEGIN
    INSERT INTO context_entries_fts(context_entries_fts, rowid, key, value, tags)
    VALUES ('delete', old.id, old.key, old.value, old.tags);
    INSERT INTO context_entries_fts(rowid, key, value, tags)
    VALUES (new.id, new.key, new.value, new.tags);
END;

-- Events — messaging bus
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE')),
    message TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_workspace_time ON events(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_workspace_id ON events(workspace_id, id);

-- Tasks — task coordination with claim/reap
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'completed', 'escalated', 'abandoned')),
    result TEXT,
    created_by TEXT NOT NULL,
    claimed_by TEXT,
    claimed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    priority TEXT NOT NULL DEFAULT 'P2' CHECK(priority IN ('P0', 'P1', 'P2', 'P3')),
    assigned_to TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_reap ON tasks(status, claimed_at);

-- Task dependencies — lightweight DAG for task ordering
CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id INTEGER NOT NULL,
    depends_on INTEGER NOT NULL,
    PRIMARY KEY (task_id, depends_on),
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (depends_on) REFERENCES tasks(id)
);

-- Agent registry — capability discovery and presence tracking
CREATE TABLE IF NOT EXISTS agents (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'online' CHECK(status IN ('online', 'offline', 'busy')),
    metadata TEXT NOT NULL DEFAULT '{}',
    last_heartbeat TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(workspace_id, last_heartbeat);

-- Messages — agent-to-agent direct messaging
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    message TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(workspace_id, to_agent, id);

-- Playbooks — reusable task template bundles
CREATE TABLE IF NOT EXISTS playbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    tasks_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(workspace_id, name)
);

-- Artifacts — typed file storage (HTML, JSON, code, reports) separate from context
CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    size INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(workspace_id, key)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(workspace_id, content_type);

-- Agent profiles — reusable role definitions (system prompts, default capabilities/tags)
CREATE TABLE IF NOT EXISTS agent_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    default_capabilities TEXT NOT NULL DEFAULT '[]',
    default_tags TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(workspace_id, name)
);

-- Workflow runs — track playbook executions as first-class entities
CREATE TABLE IF NOT EXISTS workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    playbook_name TEXT NOT NULL,
    started_by TEXT NOT NULL,
    task_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace ON workflow_runs(workspace_id, started_at);

-- Webhooks — outbound HTTP delivery of workspace events
CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    event_types TEXT NOT NULL DEFAULT '["*"]',
    active INTEGER NOT NULL DEFAULT 1,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_webhooks_workspace_active ON webhooks(workspace_id, active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'success', 'failed', 'dead')),
    response_code INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON webhook_deliveries(status, next_retry_at);

-- Schedules — recurring playbook executions (cron-like)
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    playbook_name TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    last_run_at TEXT,
    last_workflow_run_id INTEGER,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(workspace_id, playbook_name, cron_expression)
);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run_at);

-- Inbound endpoints — public receiver URLs that let external systems trigger Lattice actions
CREATE TABLE IF NOT EXISTS inbound_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    endpoint_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('create_task', 'broadcast_event', 'save_context', 'run_playbook')),
    action_config TEXT NOT NULL DEFAULT '{}',
    hmac_secret TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_inbound_endpoints_workspace ON inbound_endpoints(workspace_id);

-- Audit log — append-only record of mutating API actions.
-- No UPDATE/DELETE API; background retention prunes by age.
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_time ON audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_actor ON audit_log(workspace_id, actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_action ON audit_log(workspace_id, action, created_at DESC);

-- Users — human end-users for SaaS self-serve (separate from API-key teams).
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    email_verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));

-- Sessions — opaque-token-backed browser sessions. PK is sha256(raw_token).
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Email verification tokens. Hashed at rest; one-shot via used_at.
CREATE TABLE IF NOT EXISTS email_verifications (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);

-- Password reset tokens. Hashed at rest; one-shot via used_at.
CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

-- Workspace memberships — join users to teams with a role.
CREATE TABLE IF NOT EXISTS workspace_memberships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
    invited_by TEXT,
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace ON workspace_memberships(workspace_id);

-- Workspace invitations — pending invites to join a team.
-- token_hash = sha256(raw); raw is surfaced only once at creation time.
CREATE TABLE IF NOT EXISTS workspace_invitations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'member', 'viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email_lower ON workspace_invitations(LOWER(email));

-- OAuth identities — links external provider accounts (e.g., GitHub) to users.
CREATE TABLE IF NOT EXISTS oauth_identities (
    provider TEXT NOT NULL,
    provider_uid TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (provider, provider_uid)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

-- Subscription plans — catalog of billing plans with quota limits.
CREATE TABLE IF NOT EXISTS subscription_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    exec_quota INTEGER NOT NULL,
    api_call_quota INTEGER NOT NULL,
    storage_bytes_quota INTEGER NOT NULL,
    seat_quota INTEGER NOT NULL,
    retention_days INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Workspace subscriptions — per-workspace plan assignment + Stripe linkage.
CREATE TABLE IF NOT EXISTS workspace_subscriptions (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    current_period_start TEXT,
    current_period_end TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('trialing','active','past_due','canceled')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Usage counters — per-workspace, per-period (YYYY-MM) usage tallies.
CREATE TABLE IF NOT EXISTS usage_counters (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    period_ym TEXT NOT NULL,
    exec_count INTEGER NOT NULL DEFAULT 0,
    api_call_count INTEGER NOT NULL DEFAULT 0,
    storage_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (workspace_id, period_ym)
);
CREATE INDEX IF NOT EXISTS idx_usage_counters_workspace ON usage_counters(workspace_id);
`;

// Additive column migrations. These ALTER TABLE statements fail if the
// column already exists, so callers detect existing columns via PRAGMA
// table_info before running.
export const TASK_COLUMN_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: 'priority',
    sql: "ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2'",
  },
  {
    name: 'assigned_to',
    sql: 'ALTER TABLE tasks ADD COLUMN assigned_to TEXT',
  },
];

export const CONTEXT_COLUMN_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: 'updated_by',
    sql: 'ALTER TABLE context_entries ADD COLUMN updated_by TEXT',
  },
  {
    name: 'updated_at',
    sql: 'ALTER TABLE context_entries ADD COLUMN updated_at TEXT',
  },
];

export const WORKSPACES_COLUMN_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: 'owner_user_id',
    sql: 'ALTER TABLE workspaces ADD COLUMN owner_user_id TEXT',
  },
  {
    name: 'slug',
    sql: 'ALTER TABLE workspaces ADD COLUMN slug TEXT',
  },
];

export const API_KEY_COLUMN_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: 'scope',
    sql: "ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'write' CHECK(scope IN ('read', 'write', 'admin'))",
  },
  {
    name: 'expires_at',
    sql: 'ALTER TABLE api_keys ADD COLUMN expires_at TEXT',
  },
  {
    name: 'last_used_at',
    sql: 'ALTER TABLE api_keys ADD COLUMN last_used_at TEXT',
  },
  {
    name: 'revoked_at',
    sql: 'ALTER TABLE api_keys ADD COLUMN revoked_at TEXT',
  },
];
