import type { DbAdapter } from '../db/adapter.js';

export type MembershipRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Membership {
  userId: string;
  teamId: string;
  role: MembershipRole;
  invitedBy: string | null;
  joinedAt: string;
}

export interface UserMembershipView {
  teamId: string;
  teamName: string;
  role: MembershipRole;
  joinedAt: string;
}

export interface TeamMemberView {
  userId: string;
  email: string;
  name: string | null;
  role: MembershipRole;
  joinedAt: string;
}

interface MembershipRow {
  user_id: string;
  team_id: string;
  role: string;
  invited_by: string | null;
  joined_at: string;
}

export interface AddMembershipInput {
  userId: string;
  teamId: string;
  role: MembershipRole;
  invitedBy?: string;
}

export async function addMembership(db: DbAdapter, input: AddMembershipInput): Promise<Membership> {
  await db.run(
    'INSERT INTO team_memberships (user_id, team_id, role, invited_by) VALUES (?, ?, ?, ?)',
    input.userId, input.teamId, input.role, input.invitedBy ?? null,
  );
  const row = await db.get<MembershipRow>(
    'SELECT * FROM team_memberships WHERE user_id = ? AND team_id = ?',
    input.userId, input.teamId,
  );
  return {
    userId: row!.user_id,
    teamId: row!.team_id,
    role: row!.role as MembershipRole,
    invitedBy: row!.invited_by,
    joinedAt: row!.joined_at,
  };
}

export async function listUserMemberships(
  db: DbAdapter,
  userId: string,
): Promise<UserMembershipView[]> {
  const rows = await db.all<{ team_id: string; role: string; joined_at: string; team_name: string }>(
    `SELECT tm.team_id, tm.role, tm.joined_at, t.name AS team_name
     FROM team_memberships tm
     JOIN teams t ON t.id = tm.team_id
     WHERE tm.user_id = ?
     ORDER BY tm.joined_at ASC`,
    userId,
  );
  return rows.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    role: r.role as MembershipRole,
    joinedAt: r.joined_at,
  }));
}

export async function listTeamMembers(db: DbAdapter, teamId: string): Promise<TeamMemberView[]> {
  const rows = await db.all<{
    user_id: string;
    role: string;
    joined_at: string;
    email: string;
    name: string | null;
  }>(
    `SELECT tm.user_id, tm.role, tm.joined_at, u.email, u.name
     FROM team_memberships tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ?
     ORDER BY tm.joined_at ASC`,
    teamId,
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
  teamId: string,
  role: MembershipRole,
): Promise<void> {
  await db.run(
    'UPDATE team_memberships SET role = ? WHERE user_id = ? AND team_id = ?',
    role, userId, teamId,
  );
}

export async function removeMembership(
  db: DbAdapter,
  userId: string,
  teamId: string,
): Promise<void> {
  await db.run(
    'DELETE FROM team_memberships WHERE user_id = ? AND team_id = ?',
    userId, teamId,
  );
}

export async function countOwners(db: DbAdapter, teamId: string): Promise<number> {
  const row = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM team_memberships WHERE team_id = ? AND role = 'owner'",
    teamId,
  );
  return row!.c;
}

export async function getMembership(
  db: DbAdapter,
  userId: string,
  teamId: string,
): Promise<Membership | null> {
  const row = await db.get<MembershipRow>(
    'SELECT * FROM team_memberships WHERE user_id = ? AND team_id = ?',
    userId, teamId,
  );
  if (!row) return null;
  return {
    userId: row.user_id,
    teamId: row.team_id,
    role: row.role as MembershipRole,
    invitedBy: row.invited_by,
    joinedAt: row.joined_at,
  };
}
