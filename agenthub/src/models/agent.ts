import type { DbAdapter } from '../db/adapter.js';
import { jsonArrayTable } from '../db/adapter.js';
import { broadcastInternal } from './event.js';

export type AgentStatus = 'online' | 'offline' | 'busy';

export interface Agent {
  id: string;
  teamId: string;
  capabilities: string[];
  status: AgentStatus;
  metadata: Record<string, unknown>;
  lastHeartbeat: string;
  registeredAt: string;
}

interface AgentRow {
  id: string;
  team_id: string;
  capabilities: string;
  status: string;
  metadata: string;
  last_heartbeat: string;
  registered_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    teamId: row.team_id,
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
  teamId: string,
  agentId: string,
): Promise<void> {
  await db.run(`
    INSERT INTO agents (id, team_id, capabilities, status, metadata, last_heartbeat)
    VALUES (?, ?, '[]', 'online', '{}', ?)
    ON CONFLICT (team_id, id) DO UPDATE SET
      last_heartbeat = ?
  `, agentId, teamId, new Date().toISOString(), new Date().toISOString());
}

export interface RegisterAgentInput {
  agent_id: string;
  capabilities: string[];
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
}

export async function registerAgent(
  db: DbAdapter,
  teamId: string,
  input: RegisterAgentInput,
): Promise<Agent> {
  const status = input.status ?? 'online';
  const metadata = input.metadata ?? {};

  await db.run(`
    INSERT INTO agents (id, team_id, capabilities, status, metadata, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (team_id, id) DO UPDATE SET
      capabilities = excluded.capabilities,
      status = excluded.status,
      metadata = excluded.metadata,
      last_heartbeat = ?
  `, input.agent_id, teamId, JSON.stringify(input.capabilities), status, JSON.stringify(metadata), new Date().toISOString(), new Date().toISOString());

  const row = await db.get<AgentRow>(
    'SELECT * FROM agents WHERE team_id = ? AND id = ?',
    teamId, input.agent_id,
  );

  await broadcastInternal(
    db, teamId, 'BROADCAST',
    `Agent "${input.agent_id}" registered (capabilities: ${input.capabilities.join(', ')})`,
    ['agent-registry'], input.agent_id,
  );

  return rowToAgent(row!);
}

export async function heartbeat(
  db: DbAdapter,
  teamId: string,
  agentId: string,
  status?: AgentStatus,
): Promise<{ ok: boolean }> {
  const setClauses = ['last_heartbeat = ?'];
  const params: string[] = [new Date().toISOString()];

  if (status) {
    setClauses.push('status = ?');
    params.push(status);
  }

  params.push(teamId, agentId);

  const result = await db.run(`
    UPDATE agents SET ${setClauses.join(', ')}
    WHERE team_id = ? AND id = ?
  `, ...params);

  return { ok: result.changes > 0 };
}

export interface ListAgentsInput {
  capability?: string;
  status?: AgentStatus;
}

export async function listAgents(
  db: DbAdapter,
  teamId: string,
  input: ListAgentsInput,
): Promise<{ agents: Agent[] }> {
  const conditions = ['team_id = ?'];
  const params: string[] = [teamId];

  if (input.status) {
    conditions.push('status = ?');
    params.push(input.status);
  }

  if (input.capability) {
    conditions.push(`EXISTS (SELECT 1 FROM ${jsonArrayTable(db.dialect, 'capabilities', 'c')} WHERE c.value = ?)`);
    params.push(input.capability);
  }

  const rows = await db.all<AgentRow>(`
    SELECT * FROM agents
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_heartbeat DESC
  `, ...params);

  return { agents: rows.map(rowToAgent) };
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
