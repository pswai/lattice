/**
 * Postgres-dialect DDL for all Lattice tables.
 * Mirrors schema.ts (SQLite) with Postgres-specific types:
 * - SERIAL instead of INTEGER PRIMARY KEY AUTOINCREMENT
 * - NOW() AT TIME ZONE 'UTC' instead of strftime(...)
 * - No FTS5 virtual table / triggers (uses pg_trgm GIN indexes instead)
 * - BOOLEAN instead of INTEGER for flag columns
 */
export const PG_SCHEMA_SQL = `
-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

-- API keys for workspace authentication
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'write' CHECK(scope IN ('read', 'write', 'admin')),
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- Context entries — append-only shared knowledge base
CREATE TABLE IF NOT EXISTS context_entries (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_by TEXT,
    updated_at TEXT,
    UNIQUE(workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_context_workspace ON context_entries(workspace_id);
CREATE INDEX IF NOT EXISTS idx_context_created ON context_entries(created_at);

-- pg_trgm GIN indexes for full-text search (replaces FTS5)
CREATE INDEX IF NOT EXISTS idx_context_key_trgm ON context_entries USING gin(key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_context_value_trgm ON context_entries USING gin(value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_context_tags_trgm ON context_entries USING gin(tags gin_trgm_ops);

-- Events — messaging bus
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE')),
    message TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_events_workspace_time ON events(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_workspace_id ON events(workspace_id, id);

-- Tasks — task coordination with claim/reap
CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
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
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
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
    last_heartbeat TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    registered_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(workspace_id, last_heartbeat);

-- Messages — agent-to-agent direct messaging
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    message TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(workspace_id, to_agent, id);

-- Playbooks — reusable task template bundles
CREATE TABLE IF NOT EXISTS playbooks (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    tasks_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    UNIQUE(workspace_id, name)
);

-- Artifacts — typed file storage (HTML, JSON, code, reports) separate from context
CREATE TABLE IF NOT EXISTS artifacts (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    size INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    UNIQUE(workspace_id, key)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(workspace_id, content_type);

-- Agent profiles — reusable role definitions
CREATE TABLE IF NOT EXISTS agent_profiles (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    default_capabilities TEXT NOT NULL DEFAULT '[]',
    default_tags TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    UNIQUE(workspace_id, name)
);

-- Workflow runs — track playbook executions
CREATE TABLE IF NOT EXISTS workflow_runs (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    playbook_name TEXT NOT NULL,
    started_by TEXT NOT NULL,
    task_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
    started_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
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
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
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
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON webhook_deliveries(status, next_retry_at);

-- Schedules — recurring playbook executions (cron-like)
CREATE TABLE IF NOT EXISTS schedules (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    playbook_name TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    last_run_at TEXT,
    last_workflow_run_id INTEGER,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    UNIQUE(workspace_id, playbook_name, cron_expression)
);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run_at);

-- Inbound endpoints — public receiver URLs
CREATE TABLE IF NOT EXISTS inbound_endpoints (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    endpoint_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('create_task', 'broadcast_event', 'save_context', 'run_playbook')),
    action_config TEXT NOT NULL DEFAULT '{}',
    hmac_secret TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_inbound_endpoints_workspace ON inbound_endpoints(workspace_id);

-- Audit log — append-only record of mutating API actions
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_time ON audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_actor ON audit_log(workspace_id, actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_action ON audit_log(workspace_id, action, created_at DESC);

-- Additive column migrations for existing PG databases
DO $$ BEGIN ALTER TABLE context_entries ADD COLUMN expires_at TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id); EXCEPTION WHEN duplicate_column THEN NULL; END $$;

`;
