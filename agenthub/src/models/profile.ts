import type Database from 'better-sqlite3';
import { ValidationError, NotFoundError } from '../errors.js';

export interface AgentProfile {
  id: number;
  teamId: string;
  name: string;
  description: string;
  systemPrompt: string;
  defaultCapabilities: string[];
  defaultTags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow {
  id: number;
  team_id: string;
  name: string;
  description: string;
  system_prompt: string;
  default_capabilities: string;
  default_tags: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToProfile(row: ProfileRow): AgentProfile {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    defaultCapabilities: JSON.parse(row.default_capabilities) as string[],
    defaultTags: JSON.parse(row.default_tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DefineProfileInput {
  name: string;
  description: string;
  system_prompt: string;
  default_capabilities?: string[];
  default_tags?: string[];
}

export function defineProfile(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: DefineProfileInput,
): AgentProfile {
  if (!input.name || input.name.length === 0) {
    throw new ValidationError('name is required');
  }
  if (!input.description || input.description.length === 0) {
    throw new ValidationError('description is required');
  }
  if (!input.system_prompt || input.system_prompt.length === 0) {
    throw new ValidationError('system_prompt is required');
  }
  if (input.default_capabilities && !Array.isArray(input.default_capabilities)) {
    throw new ValidationError('default_capabilities must be an array');
  }
  if (input.default_tags && !Array.isArray(input.default_tags)) {
    throw new ValidationError('default_tags must be an array');
  }

  const capabilitiesJson = JSON.stringify(input.default_capabilities ?? []);
  const tagsJson = JSON.stringify(input.default_tags ?? []);

  db.prepare(`
    INSERT INTO agent_profiles (team_id, name, description, system_prompt, default_capabilities, default_tags, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, name) DO UPDATE SET
      description = excluded.description,
      system_prompt = excluded.system_prompt,
      default_capabilities = excluded.default_capabilities,
      default_tags = excluded.default_tags,
      created_by = excluded.created_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(
    teamId,
    input.name,
    input.description,
    input.system_prompt,
    capabilitiesJson,
    tagsJson,
    agentId,
  );

  const row = db.prepare(
    'SELECT * FROM agent_profiles WHERE team_id = ? AND name = ?',
  ).get(teamId, input.name) as ProfileRow;

  return rowToProfile(row);
}

export function listProfiles(
  db: Database.Database,
  teamId: string,
): { profiles: AgentProfile[]; total: number } {
  const rows = db.prepare(
    'SELECT * FROM agent_profiles WHERE team_id = ? ORDER BY name ASC',
  ).all(teamId) as ProfileRow[];

  return {
    profiles: rows.map(rowToProfile),
    total: rows.length,
  };
}

export function getProfile(
  db: Database.Database,
  teamId: string,
  name: string,
): AgentProfile {
  const row = db.prepare(
    'SELECT * FROM agent_profiles WHERE team_id = ? AND name = ?',
  ).get(teamId, name) as ProfileRow | undefined;

  if (!row) {
    throw new NotFoundError('AgentProfile', name);
  }
  return rowToProfile(row);
}

export function deleteProfile(
  db: Database.Database,
  teamId: string,
  name: string,
): { deleted: boolean } {
  const result = db
    .prepare('DELETE FROM agent_profiles WHERE team_id = ? AND name = ?')
    .run(teamId, name);
  if (result.changes === 0) {
    throw new NotFoundError('AgentProfile', name);
  }
  return { deleted: true };
}
