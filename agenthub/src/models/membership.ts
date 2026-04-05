import type Database from 'better-sqlite3';

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

export function addMembership(db: Database.Database, input: AddMembershipInput): Membership {
  db.prepare(
    'INSERT INTO team_memberships (user_id, team_id, role, invited_by) VALUES (?, ?, ?, ?)',
  ).run(input.userId, input.teamId, input.role, input.invitedBy ?? null);
  const row = db
    .prepare('SELECT * FROM team_memberships WHERE user_id = ? AND team_id = ?')
    .get(input.userId, input.teamId) as MembershipRow;
  return {
    userId: row.user_id,
    teamId: row.team_id,
    role: row.role as MembershipRole,
    invitedBy: row.invited_by,
    joinedAt: row.joined_at,
  };
}

export function listUserMemberships(
  db: Database.Database,
  userId: string,
): UserMembershipView[] {
  const rows = db
    .prepare(
      `SELECT tm.team_id, tm.role, tm.joined_at, t.name AS team_name
       FROM team_memberships tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = ?
       ORDER BY tm.joined_at ASC`,
    )
    .all(userId) as Array<{ team_id: string; role: string; joined_at: string; team_name: string }>;
  return rows.map((r) => ({
    teamId: r.team_id,
    teamName: r.team_name,
    role: r.role as MembershipRole,
    joinedAt: r.joined_at,
  }));
}

export function listTeamMembers(db: Database.Database, teamId: string): TeamMemberView[] {
  const rows = db
    .prepare(
      `SELECT tm.user_id, tm.role, tm.joined_at, u.email, u.name
       FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ?
       ORDER BY tm.joined_at ASC`,
    )
    .all(teamId) as Array<{
    user_id: string;
    role: string;
    joined_at: string;
    email: string;
    name: string | null;
  }>;
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    role: r.role as MembershipRole,
    joinedAt: r.joined_at,
  }));
}

export function getMembership(
  db: Database.Database,
  userId: string,
  teamId: string,
): Membership | null {
  const row = db
    .prepare('SELECT * FROM team_memberships WHERE user_id = ? AND team_id = ?')
    .get(userId, teamId) as MembershipRow | undefined;
  if (!row) return null;
  return {
    userId: row.user_id,
    teamId: row.team_id,
    role: row.role as MembershipRole,
    invitedBy: row.invited_by,
    joinedAt: row.joined_at,
  };
}
