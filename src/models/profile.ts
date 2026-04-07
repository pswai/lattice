import type { DbAdapter } from '../db/adapter.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { throwIfSecretsFound } from '../services/secret-scanner.js';

export interface AgentProfile {
  id: number;
  workspaceId: string;
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
  workspace_id: string;
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
    workspaceId: row.workspace_id,
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

export async function defineProfile(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: DefineProfileInput,
): Promise<AgentProfile> {
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

  // Scan description and system_prompt for secrets
  for (const field of [input.description, input.system_prompt]) {
    throwIfSecretsFound(field);
  }

  const capabilitiesJson = JSON.stringify(input.default_capabilities ?? []);
  const tagsJson = JSON.stringify(input.default_tags ?? []);

  await db.run(`
    INSERT INTO agent_profiles (workspace_id, name, description, system_prompt, default_capabilities, default_tags, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, name) DO UPDATE SET
      description = excluded.description,
      system_prompt = excluded.system_prompt,
      default_capabilities = excluded.default_capabilities,
      default_tags = excluded.default_tags,
      updated_at = ?
  `,
    workspaceId,
    input.name,
    input.description,
    input.system_prompt,
    capabilitiesJson,
    tagsJson,
    agentId,
    new Date().toISOString(),
  );

  const row = await db.get<ProfileRow>(
    'SELECT * FROM agent_profiles WHERE workspace_id = ? AND name = ?',
    workspaceId, input.name,
  );

  return rowToProfile(row!);
}

export async function listProfiles(
  db: DbAdapter,
  workspaceId: string,
): Promise<{ profiles: AgentProfile[]; total: number }> {
  const rows = await db.all<ProfileRow>(
    'SELECT * FROM agent_profiles WHERE workspace_id = ? ORDER BY name ASC',
    workspaceId,
  );

  return {
    profiles: rows.map(rowToProfile),
    total: rows.length,
  };
}

export async function getProfile(
  db: DbAdapter,
  workspaceId: string,
  name: string,
): Promise<AgentProfile> {
  const row = await db.get<ProfileRow>(
    'SELECT * FROM agent_profiles WHERE workspace_id = ? AND name = ?',
    workspaceId, name,
  );

  if (!row) {
    throw new NotFoundError('AgentProfile', name);
  }
  return rowToProfile(row);
}

export async function deleteProfile(
  db: DbAdapter,
  workspaceId: string,
  name: string,
): Promise<{ deleted: boolean }> {
  const result = await db.run(
    'DELETE FROM agent_profiles WHERE workspace_id = ? AND name = ?',
    workspaceId, name,
  );
  if (result.changes === 0) {
    throw new NotFoundError('AgentProfile', name);
  }
  return { deleted: true };
}
