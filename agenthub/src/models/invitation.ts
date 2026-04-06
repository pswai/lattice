import type { DbAdapter } from '../db/adapter.js';
import { createHash, randomBytes } from 'crypto';
import { ValidationError } from '../errors.js';
import { addMembership, getMembership, type MembershipRole } from './membership.js';

export type InvitationRole = 'admin' | 'member' | 'viewer';

export interface Invitation {
  id: string;
  workspaceId: string;
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
  workspace_id: string;
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
    workspaceId: row.workspace_id,
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
  workspaceId: string;
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

export async function createInvitation(
  db: DbAdapter,
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  const ttlDays = input.ttlDays ?? 7;
  const invitationId = `inv_${randomBytes(12).toString('hex')}`;
  const raw = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  await db.run(
    `INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    invitationId, input.workspaceId, input.email, input.role, tokenHash, input.invitedBy, expiresAt,
  );
  return { raw, invitationId, expiresAt };
}

export async function getInvitationByToken(db: DbAdapter, raw: string): Promise<Invitation | null> {
  if (!raw) return null;
  const tokenHash = hashToken(raw);
  const row = await db.get<InvitationRow>(
    'SELECT * FROM workspace_invitations WHERE token_hash = ?',
    tokenHash,
  );
  if (!row) return null;
  if (row.accepted_at) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return rowToInvitation(row);
}

export async function getInvitationById(db: DbAdapter, id: string): Promise<Invitation | null> {
  const row = await db.get<InvitationRow>(
    'SELECT * FROM workspace_invitations WHERE id = ?',
    id,
  );
  if (!row) return null;
  return rowToInvitation(row);
}

export async function listWorkspaceInvitations(db: DbAdapter, workspaceId: string): Promise<Invitation[]> {
  const rows = await db.all<InvitationRow>(
    `SELECT * FROM workspace_invitations
     WHERE workspace_id = ?
       AND accepted_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > ?
     ORDER BY created_at DESC`,
    workspaceId, new Date().toISOString(),
  );
  return rows.map(rowToInvitation);
}

export async function revokeInvitation(db: DbAdapter, id: string): Promise<void> {
  await db.run(
    "UPDATE workspace_invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND accepted_at IS NULL",
    new Date().toISOString(), id,
  );
}

export interface AcceptInvitationResult {
  workspaceId: string;
  role: MembershipRole;
}

export async function acceptInvitation(
  db: DbAdapter,
  raw: string,
  userId: string,
): Promise<AcceptInvitationResult> {
  const inv = await getInvitationByToken(db, raw);
  if (!inv) {
    throw new ValidationError('Invitation is invalid, expired, or already used');
  }
  const existing = await getMembership(db, userId, inv.workspaceId);
  if (existing) {
    throw new ValidationError('User is already a member of this workspace');
  }
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE workspace_invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
      new Date().toISOString(), inv.id,
    );
    await addMembership(db, {
      userId,
      workspaceId: inv.workspaceId,
      role: inv.role,
      invitedBy: inv.invitedBy ?? undefined,
    });
  });
  return { workspaceId: inv.workspaceId, role: inv.role };
}
