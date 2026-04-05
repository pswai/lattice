import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'crypto';
import { ValidationError } from '../errors.js';
import { addMembership, getMembership, type MembershipRole } from './membership.js';

export type InvitationRole = 'admin' | 'member' | 'viewer';

export interface Invitation {
  id: string;
  teamId: string;
  email: string;
  role: InvitationRole;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface InvitationRow {
  id: string;
  team_id: string;
  email: string;
  role: string;
  token_hash: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function rowToInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    teamId: row.team_id,
    email: row.email,
    role: row.role as InvitationRole,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface CreateInvitationInput {
  teamId: string;
  email: string;
  role: InvitationRole;
  invitedBy: string;
  ttlDays?: number;
}

export interface CreateInvitationResult {
  raw: string;
  invitationId: string;
  expiresAt: string;
}

export function createInvitation(
  db: Database.Database,
  input: CreateInvitationInput,
): CreateInvitationResult {
  const ttlDays = input.ttlDays ?? 7;
  const invitationId = `inv_${randomBytes(12).toString('hex')}`;
  const raw = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO team_invitations (id, team_id, email, role, token_hash, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(invitationId, input.teamId, input.email, input.role, tokenHash, input.invitedBy, expiresAt);
  return { raw, invitationId, expiresAt };
}

export function getInvitationByToken(db: Database.Database, raw: string): Invitation | null {
  if (!raw) return null;
  const tokenHash = hashToken(raw);
  const row = db
    .prepare('SELECT * FROM team_invitations WHERE token_hash = ?')
    .get(tokenHash) as InvitationRow | undefined;
  if (!row) return null;
  if (row.accepted_at) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return rowToInvitation(row);
}

export function getInvitationById(db: Database.Database, id: string): Invitation | null {
  const row = db
    .prepare('SELECT * FROM team_invitations WHERE id = ?')
    .get(id) as InvitationRow | undefined;
  if (!row) return null;
  return rowToInvitation(row);
}

export function listTeamInvitations(db: Database.Database, teamId: string): Invitation[] {
  const rows = db
    .prepare(
      `SELECT * FROM team_invitations
       WHERE team_id = ?
         AND accepted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ORDER BY created_at DESC`,
    )
    .all(teamId) as InvitationRow[];
  return rows.map(rowToInvitation);
}

export function revokeInvitation(db: Database.Database, id: string): void {
  db.prepare(
    "UPDATE team_invitations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL AND accepted_at IS NULL",
  ).run(id);
}

export interface AcceptInvitationResult {
  teamId: string;
  role: MembershipRole;
}

export function acceptInvitation(
  db: Database.Database,
  raw: string,
  userId: string,
): AcceptInvitationResult {
  const inv = getInvitationByToken(db, raw);
  if (!inv) {
    throw new ValidationError('Invitation is invalid, expired, or already used');
  }
  const existing = getMembership(db, userId, inv.teamId);
  if (existing) {
    throw new ValidationError('User is already a member of this workspace');
  }
  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE team_invitations SET accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
    ).run(inv.id);
    addMembership(db, {
      userId,
      teamId: inv.teamId,
      role: inv.role,
      invitedBy: inv.invitedBy ?? undefined,
    });
  });
  tx();
  return { teamId: inv.teamId, role: inv.role };
}
