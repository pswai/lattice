import type { DbAdapter } from '../db/adapter.js';

export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Membership {
  userId: string;
  workspaceId: string;
  role: MembershipRole;
  invitedBy: string | null;
  joinedAt: string;
}

export interface UserMembershipView {
  workspaceId: string;
  workspaceName: string;
  role: MembershipRole;
  joinedAt: string;
}

export interface WorkspaceMemberView {
  userId: string;
  email: string;
  name: string | null;
  role: MembershipRole;
  joinedAt: string;
}

interface MembershipRow {
  user_id: string;
  workspace_id: string;
  role: string;
  invited_by: string | null;
  joined_at: string;
}

export interface AddMembershipInput {
  userId: string;
  workspaceId: string;
  role: MembershipRole;
  invitedBy?: string;
}

export async function addMembership(db: DbAdapter, input: AddMembershipInput): Promise<Membership> {
  await db.run(
    'INSERT INTO workspace_memberships (user_id, workspace_id, role, invited_by) VALUES (?, ?, ?, ?)',
    input.userId, input.workspaceId, input.role, input.invitedBy ?? null,
  );
  const row = await db.get<MembershipRow>(
    'SELECT * FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?',
    input.userId, input.workspaceId,
  );
  return {
    userId: row!.user_id,
    workspaceId: row!.workspace_id,
    role: row!.role as MembershipRole,
    invitedBy: row!.invited_by,
    joinedAt: row!.joined_at,
  };
}

export async function listUserMemberships(
  db: DbAdapter,
  userId: string,
): Promise<UserMembershipView[]> {
  const rows = await db.all<{ workspace_id: string; role: string; joined_at: string; workspace_name: string }>(
    `SELECT tm.workspace_id, tm.role, tm.joined_at, t.name AS workspace_name
     FROM workspace_memberships tm
     JOIN workspaces t ON t.id = tm.workspace_id
     WHERE tm.user_id = ?
     ORDER BY tm.joined_at ASC`,
    userId,
  );
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    role: r.role as MembershipRole,
    joinedAt: r.joined_at,
  }));
}

export async function listWorkspaceMembers(db: DbAdapter, workspaceId: string): Promise<WorkspaceMemberView[]> {
  const rows = await db.all<{
    user_id: string;
    role: string;
    joined_at: string;
    email: string;
    name: string | null;
  }>(
    `SELECT tm.user_id, tm.role, tm.joined_at, u.email, u.name
     FROM workspace_memberships tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.workspace_id = ?
     ORDER BY tm.joined_at ASC`,
    workspaceId,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    role: r.role as MembershipRole,
    joinedAt: r.joined_at,
  }));
}

export async function changeRole(
  db: DbAdapter,
  userId: string,
  workspaceId: string,
  role: MembershipRole,
): Promise<void> {
  await db.run(
    'UPDATE workspace_memberships SET role = ? WHERE user_id = ? AND workspace_id = ?',
    role, userId, workspaceId,
  );
}

export async function removeMembership(
  db: DbAdapter,
  userId: string,
  workspaceId: string,
): Promise<void> {
  await db.run(
    'DELETE FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?',
    userId, workspaceId,
  );
}

export async function countOwners(db: DbAdapter, workspaceId: string): Promise<number> {
  const row = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner'",
    workspaceId,
  );
  return row!.c;
}

export async function getMembership(
  db: DbAdapter,
  userId: string,
  workspaceId: string,
): Promise<Membership | null> {
  const row = await db.get<MembershipRow>(
    'SELECT * FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?',
    userId, workspaceId,
  );
  if (!row) return null;
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    role: row.role as MembershipRole,
    invitedBy: row.invited_by,
    joinedAt: row.joined_at,
  };
}
