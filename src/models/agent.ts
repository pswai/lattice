import { randomUUID } from 'crypto';
import type { DbAdapter } from '../db/adapter.js';
import { jsonArrayTable } from '../db/adapter.js';
import { broadcastInternal } from './event.js';

export type AgentStatus = 'online' | 'offline' | 'busy';

export interface Agent {
  id: string;
  workspaceId: string;
  capabilities: string[];
  status: AgentStatus;
  metadata: Record<string, unknown>;
  lastHeartbeat: string;
  registeredAt: string;
}

interface AgentRow {
  id: string;
  workspace_id: string;
  capabilities: string;
  status: string;
  metadata: string;
  last_heartbeat: string;
  registered_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    capabilities: JSON.parse(row.capabilities) as string[],
    status: row.status as AgentStatus,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    lastHeartbeat: row.last_heartbeat,
    registeredAt: row.registered_at,
  };
}

/**
 * Auto-register an agent if not already present. Updates last_heartbeat if they exist.
 * Used by MCP tool handlers to ensure agents are discoverable without explicit registration.
 */
export async function autoRegisterAgent(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  await db.run(`
    INSERT INTO agents (id, workspace_id, capabilities, status, metadata, last_heartbeat)
    VALUES (?, ?, '[]', 'online', '{}', ?)
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      last_heartbeat = ?
  `, agentId, workspaceId, new Date().toISOString(), new Date().toISOString());
}

export interface RegisterAgentInput {
  agent_id?: string;
  capabilities: string[];
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
}

export async function registerAgent(
  db: DbAdapter,
  workspaceId: string,
  input: RegisterAgentInput,
): Promise<Agent> {
  const agentId = input.agent_id || `ag_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const status = input.status ?? 'online';
  const metadata = input.metadata ?? {};

  await db.run(`
    INSERT INTO agents (id, workspace_id, capabilities, status, metadata, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      capabilities = excluded.capabilities,
      status = excluded.status,
      metadata = excluded.metadata,
      last_heartbeat = ?
  `, agentId, workspaceId, JSON.stringify(input.capabilities), status, JSON.stringify(metadata), new Date().toISOString(), new Date().toISOString());

  const row = await db.get<AgentRow>(
    'SELECT * FROM agents WHERE workspace_id = ? AND id = ?',
    workspaceId, agentId,
  );

  await broadcastInternal(
    db, workspaceId, 'BROADCAST',
    `Agent "${agentId}" registered (capabilities: ${input.capabilities.join(', ')})`,
    ['agent-registry'], agentId,
  );

  return rowToAgent(row!);
}

export async function heartbeat(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  status?: AgentStatus,
  metadata?: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const setClauses = ['last_heartbeat = ?'];
  const params: string[] = [new Date().toISOString()];

  if (status) {
    setClauses.push('status = ?');
    params.push(status);
  }

  if (metadata) {
    // Read-modify-write: merge provided keys with existing metadata
    const current = await db.get<{ metadata: string }>(
      'SELECT metadata FROM agents WHERE workspace_id = ? AND id = ?',
      workspaceId, agentId,
    );
    const existing = current ? JSON.parse(current.metadata) as Record<string, unknown> : {};
    const merged = { ...existing, ...metadata };
    setClauses.push('metadata = ?');
    params.push(JSON.stringify(merged));
  }

  params.push(workspaceId, agentId);

  const result = await db.run(`
    UPDATE agents SET ${setClauses.join(', ')}
    WHERE workspace_id = ? AND id = ?
  `, ...params);

  return { ok: result.changes > 0 };
}

export interface ListAgentsInput {
  capability?: string;
  status?: AgentStatus;
  active_within_minutes?: number;
  metadata_contains?: string;
}

export async function listAgents(
  db: DbAdapter,
  workspaceId: string,
  input: ListAgentsInput,
): Promise<{ agents: Agent[] }> {
  const conditions = ['workspace_id = ?'];
  const params: string[] = [workspaceId];

  if (input.status) {
    conditions.push('status = ?');
    params.push(input.status);
  }

  if (input.capability) {
    conditions.push(`EXISTS (SELECT 1 FROM ${jsonArrayTable(db.dialect, 'capabilities', 'c')} WHERE c.value = ?)`);
    params.push(input.capability);
  }

  if (input.active_within_minutes) {
    const cutoff = new Date(Date.now() - input.active_within_minutes * 60 * 1000).toISOString();
    conditions.push('last_heartbeat > ?');
    params.push(cutoff);
  }

  if (input.metadata_contains) {
    conditions.push('metadata LIKE ?');
    params.push(`%${input.metadata_contains}%`);
  }

  const rows = await db.all<AgentRow>(`
    SELECT * FROM agents
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_heartbeat DESC
  `, ...params);

  return { agents: rows.map(rowToAgent) };
}

/** Get a snapshot of the agent's own state: registration, claimed tasks, recent messages, recent events. */
export async function getMyStatus(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
): Promise<{
  agent: Agent | null;
  claimed_tasks: Array<{ id: number; description: string; priority: string; created_at: string }>;
  recent_messages: number;
  recent_events: number;
}> {
  const agentRow = await db.get<AgentRow>(
    'SELECT * FROM agents WHERE workspace_id = ? AND id = ?',
    workspaceId, agentId,
  );

  const taskRows = await db.all<{ id: number; description: string; priority: string; created_at: string }>(`
    SELECT id, description, priority, created_at FROM tasks
    WHERE workspace_id = ? AND claimed_by = ? AND status = 'claimed'
    ORDER BY priority ASC, created_at ASC
    LIMIT 20
  `, workspaceId, agentId);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const msgRow = await db.get<{ cnt: number }>(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE workspace_id = ? AND to_agent = ? AND created_at > ?
  `, workspaceId, agentId, since24h);

  const evtRow = await db.get<{ cnt: number }>(`
    SELECT COUNT(*) as cnt FROM events
    WHERE workspace_id = ? AND created_by = ? AND created_at > ?
  `, workspaceId, agentId, since24h);

  return {
    agent: agentRow ? rowToAgent(agentRow) : null,
    claimed_tasks: taskRows,
    recent_messages: msgRow?.cnt ?? 0,
    recent_events: evtRow?.cnt ?? 0,
  };
}

/** Mark agents as offline if they haven't sent a heartbeat within the timeout */
export async function markStaleAgents(db: DbAdapter, timeoutMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  const result = await db.run(`
    UPDATE agents SET status = 'offline'
    WHERE status != 'offline' AND last_heartbeat < ?
  `, cutoff);

  return result.changes;
}
