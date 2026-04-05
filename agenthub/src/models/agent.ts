import type Database from 'better-sqlite3';
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
export function autoRegisterAgent(
  db: Database.Database,
  teamId: string,
  agentId: string,
): void {
  db.prepare(`
    INSERT INTO agents (id, team_id, capabilities, status, metadata, last_heartbeat)
    VALUES (?, ?, '[]', 'online', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (team_id, id) DO UPDATE SET
      last_heartbeat = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(agentId, teamId);
}

export interface RegisterAgentInput {
  agent_id: string;
  capabilities: string[];
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
}

export function registerAgent(
  db: Database.Database,
  teamId: string,
  input: RegisterAgentInput,
): Agent {
  const status = input.status ?? 'online';
  const metadata = input.metadata ?? {};

  db.prepare(`
    INSERT INTO agents (id, team_id, capabilities, status, metadata, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (team_id, id) DO UPDATE SET
      capabilities = excluded.capabilities,
      status = excluded.status,
      metadata = excluded.metadata,
      last_heartbeat = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(input.agent_id, teamId, JSON.stringify(input.capabilities), status, JSON.stringify(metadata));

  const row = db.prepare(
    'SELECT * FROM agents WHERE team_id = ? AND id = ?',
  ).get(teamId, input.agent_id) as AgentRow;

  broadcastInternal(
    db, teamId, 'BROADCAST',
    `Agent "${input.agent_id}" registered (capabilities: ${input.capabilities.join(', ')})`,
    ['agent-registry'], input.agent_id,
  );

  return rowToAgent(row);
}

export function heartbeat(
  db: Database.Database,
  teamId: string,
  agentId: string,
  status?: AgentStatus,
): { ok: boolean } {
  const setClauses = ['last_heartbeat = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')'];
  const params: string[] = [];

  if (status) {
    setClauses.push('status = ?');
    params.push(status);
  }

  params.push(teamId, agentId);

  const result = db.prepare(`
    UPDATE agents SET ${setClauses.join(', ')}
    WHERE team_id = ? AND id = ?
  `).run(...params);

  return { ok: result.changes > 0 };
}

export interface ListAgentsInput {
  capability?: string;
  status?: AgentStatus;
}

export function listAgents(
  db: Database.Database,
  teamId: string,
  input: ListAgentsInput,
): { agents: Agent[] } {
  const conditions = ['team_id = ?'];
  const params: string[] = [teamId];

  if (input.status) {
    conditions.push('status = ?');
    params.push(input.status);
  }

  let rows: AgentRow[];

  if (input.capability) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(capabilities) AS c WHERE c.value = ?)`);
    params.push(input.capability);
  }

  rows = db.prepare(`
    SELECT * FROM agents
    WHERE ${conditions.join(' AND ')}
    ORDER BY last_heartbeat DESC
  `).all(...params) as AgentRow[];

  return { agents: rows.map(rowToAgent) };
}

/** Mark agents as offline if they haven't sent a heartbeat within the timeout */
export function markStaleAgents(db: Database.Database, timeoutMinutes: number): number {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  const result = db.prepare(`
    UPDATE agents SET status = 'offline'
    WHERE status != 'offline' AND last_heartbeat < ?
  `).run(cutoff);

  return result.changes;
}
