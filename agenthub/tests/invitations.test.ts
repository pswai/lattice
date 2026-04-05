import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
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

function makeTeam(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, `Team ${id}`);
}

describe('invitations model', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    makeTeam(db, 'team-a');
  });

  it('createInvitation + getInvitationByToken round-trip', () => {
    const user = createUser(db, { email: 'owner@example.com', password: 'longenough' });
    const { raw, invitationId } = createInvitation(db, {
      teamId: 'team-a',
      email: 'invitee@example.com',
      role: 'member',
      invitedBy: user.id,
    });
    expect(invitationId).toMatch(/^inv_[a-f0-9]{24}$/);
    const looked = getInvitationByToken(db, raw);
    expect(looked).not.toBeNull();
    expect(looked!.id).toBe(invitationId);
    expect(looked!.teamId).toBe('team-a');
    expect(looked!.role).toBe('member');
  });

  it('rejects expired invitations', () => {
    const user = createUser(db, { email: 'owner@example.com', password: 'longenough' });
    const { raw, invitationId } = createInvitation(db, {
      teamId: 'team-a',
      email: 'a@example.com',
      role: 'viewer',
      invitedBy: user.id,
    });
    // Force expiry into the past
    db.prepare('UPDATE team_invitations SET expires_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      invitationId,
    );
    expect(getInvitationByToken(db, raw)).toBeNull();
  });

  it('rejects revoked invitations', () => {
    const user = createUser(db, { email: 'owner@example.com', password: 'longenough' });
    const { raw, invitationId } = createInvitation(db, {
      teamId: 'team-a',
      email: 'a@example.com',
      role: 'viewer',
      invitedBy: user.id,
    });
    revokeInvitation(db, invitationId);
    expect(getInvitationByToken(db, raw)).toBeNull();
  });

  it('rejects already-used invitations', () => {
    const inviter = createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = createUser(db, { email: 'i@example.com', password: 'longenough' });
    const { raw } = createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    acceptInvitation(db, raw, invitee.id);
    expect(getInvitationByToken(db, raw)).toBeNull();
  });

  it('listTeamInvitations returns only pending', () => {
    const inviter = createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = createUser(db, { email: 'i@example.com', password: 'longenough' });
    const inv1 = createInvitation(db, {
      teamId: 'team-a',
      email: 'pending@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    const inv2 = createInvitation(db, {
      teamId: 'team-a',
      email: 'revoked@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    revokeInvitation(db, inv2.invitationId);
    const inv3 = createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    acceptInvitation(db, inv3.raw, invitee.id);

    const pending = listTeamInvitations(db, 'team-a');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(inv1.invitationId);
    expect(pending[0].email).toBe('pending@example.com');
  });

  it('acceptInvitation creates membership with the invitation role', () => {
    const inviter = createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = createUser(db, { email: 'i@example.com', password: 'longenough' });
    const { raw } = createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'admin',
      invitedBy: inviter.id,
    });
    const result = acceptInvitation(db, raw, invitee.id);
    expect(result).toEqual({ teamId: 'team-a', role: 'admin' });
    const m = getMembership(db, invitee.id, 'team-a');
    expect(m).not.toBeNull();
    expect(m!.role).toBe('admin');
    expect(m!.invitedBy).toBe(inviter.id);
  });

  it('accept twice is rejected (token one-shot)', () => {
    const inviter = createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = createUser(db, { email: 'i@example.com', password: 'longenough' });
    const { raw } = createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'member',
      invitedBy: inviter.id,
    });
    acceptInvitation(db, raw, invitee.id);
    expect(() => acceptInvitation(db, raw, invitee.id)).toThrow();
  });

  it('cannot accept for a user already a member', () => {
    const inviter = createUser(db, { email: 'o@example.com', password: 'longenough' });
    const invitee = createUser(db, { email: 'i@example.com', password: 'longenough' });
    addMembership(db, { userId: invitee.id, teamId: 'team-a', role: 'member' });
    const { raw } = createInvitation(db, {
      teamId: 'team-a',
      email: 'i@example.com',
      role: 'admin',
      invitedBy: inviter.id,
    });
    expect(() => acceptInvitation(db, raw, invitee.id)).toThrow();
  });
});
