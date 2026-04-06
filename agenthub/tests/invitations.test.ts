import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './helpers.js';
import {
  createInvitation,
  getInvitationByToken,
  listTeamInvitations,
  revokeInvitation,
  acceptInvitation,
} from '../src/models/invitation.js';
import { createUser } from '../src/models/user.js';
import { addMembership, getMembership } from '../src/models/membership.js';

function makeTeam(db: ReturnType<typeof createTestDb>, id: string): void {
  db.rawDb.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, `Team ${id}`);
}

describe('invitations model', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    makeTeam(db, 'team-a');
  });

  it('createInvitation + getInvitationByToken round-trip', async () => {
    const user = await createUser(db, { email: 'owner@example.com', password: 'longenough' });
    const { raw, invitationId } = await createInvitation(db, {
      teamId: 'team-a',
      email: 'invitee@example.com',
      role: 'member',
      invitedBy: user.id,
    });
    expect(invitationId).toMatch(/^inv_[a-f0-9]{24}$/);
    const looked = await getInvitationByToken(db, raw);
    expect(looked).not.toBeNull();
    expect(looked!.id).toBe(invitationId);
    expect(looked!.teamId).toBe('team-a');
    expect(looked!.role).toBe('member');
  });

  it('rejects expired invitations', async () => {
    const user = await createUser(db, { email: 'owner@example.com', password: 'longenough' });
    const { raw, invitationId } = await createInvitation(db, {
      teamId: 'team-a',
      email: 'a@example.com',
      role: 'viewer',
      invitedBy: user.id,
    });
    // Force expiry into the past
    db.rawDb.prepare('UPDATE team_invitations SET expires_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      invitationId,
    );
    expect(await getInvitationByToken(db, raw)).toBeNull();
  });

  it('rejects revoked invitations', async () => {
    const user = await createUser(db, { email: 'owner@example.com', password: 'longenough' });
    const { raw, invitationId } = await createInvitation(db, {
      teamId: 'team-a',
      email: 'a@example.com',
      role: 'viewer',
      invitedBy: user.id,
    });
    await revokeInvitation(db, invitationId);
    expect(await getInvitationByToken(db, raw)).toBeNull();
  });

  it('rejects already-used invitations', async () => {
    const inviter = await createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = await createUser(db, { email: 'i@example.com', password: 'longenough' });
    const { raw } = await createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    await acceptInvitation(db, raw, invitee.id);
    expect(await getInvitationByToken(db, raw)).toBeNull();
  });

  it('listTeamInvitations returns only pending', async () => {
    const inviter = await createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = await createUser(db, { email: 'i@example.com', password: 'longenough' });
    const inv1 = await createInvitation(db, {
      teamId: 'team-a',
      email: 'pending@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    const inv2 = await createInvitation(db, {
      teamId: 'team-a',
      email: 'revoked@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    await revokeInvitation(db, inv2.invitationId);
    const inv3 = await createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    await acceptInvitation(db, inv3.raw, invitee.id);

    const pending = await listTeamInvitations(db, 'team-a');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(inv1.invitationId);
    expect(pending[0].email).toBe('pending@example.com');
  });

  it('acceptInvitation creates membership with the invitation role', async () => {
    const inviter = await createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = await createUser(db, { email: 'i@example.com', password: 'longenough' });
    const { raw } = await createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'admin',
      invitedBy: inviter.id,
    });
    const result = await acceptInvitation(db, raw, invitee.id);
    expect(result).toEqual({ teamId: 'team-a', role: 'admin' });
    const m = await getMembership(db, invitee.id, 'team-a');
    expect(m).not.toBeNull();
    expect(m!.role).toBe('admin');
    expect(m!.invitedBy).toBe(inviter.id);
  });

  it('accept twice is rejected (token one-shot)', async () => {
    const inviter = await createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = await createUser(db, { email: 'i@example.com', password: 'longenough' });
    const { raw } = await createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    await acceptInvitation(db, raw, invitee.id);
    await expect(acceptInvitation(db, raw, invitee.id)).rejects.toThrow();
  });

  it('cannot accept for a user already a member', async () => {
    const inviter = await createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = await createUser(db, { email: 'i@example.com', password: 'longenough' });
    await addMembership(db, { userId: invitee.id, teamId: 'team-a', role: 'member' });
    const { raw } = await createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'admin',
      invitedBy: inviter.id,
    });
    await expect(acceptInvitation(db, raw, invitee.id)).rejects.toThrow();
  });
});
