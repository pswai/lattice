import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import { createUser } from '../src/models/user.js';
import {
  addMembership,
  listUserMemberships,
  listTeamMembers,
  getMembership,
} from '../src/models/membership.js';

function makeTeam(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, name);
}

describe('Membership model', () => {
  let db: Database.Database;
  let userId: string;

  beforeEach(() => {
    db = createTestDb();
    userId = createUser(db, { email: 'owner@example.com', password: 'longenough-pass' }).id;
    makeTeam(db, 'team-a', 'Team A');
    makeTeam(db, 'team-b', 'Team B');
  });

  it('adds and fetches memberships', () => {
    const m = addMembership(db, { userId, teamId: 'team-a', role: 'owner' });
    expect(m.role).toBe('owner');
    const fetched = getMembership(db, userId, 'team-a');
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe('owner');
    expect(getMembership(db, userId, 'never')).toBeNull();
  });

  it('lists memberships by user, joined with team name', () => {
    addMembership(db, { userId, teamId: 'team-a', role: 'owner' });
    addMembership(db, { userId, teamId: 'team-b', role: 'member' });
    const list = listUserMemberships(db, userId);
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.teamId).sort()).toEqual(['team-a', 'team-b']);
    expect(list.find((m) => m.teamId === 'team-a')!.teamName).toBe('Team A');
    expect(list.find((m) => m.teamId === 'team-a')!.role).toBe('owner');
  });

  it('lists team members, joined with user email', () => {
    const other = createUser(db, { email: 'other@example.com', password: 'longenough-pass' }).id;
    addMembership(db, { userId, teamId: 'team-a', role: 'owner' });
    addMembership(db, { userId: other, teamId: 'team-a', role: 'member' });
    const members = listTeamMembers(db, 'team-a');
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.email).sort()).toEqual(['other@example.com', 'owner@example.com']);
  });

  it('enforces role CHECK constraint', () => {
    expect(() =>
      addMembership(db, { userId, teamId: 'team-a', role: 'superlord' as never }),
    ).toThrow();
  });

  it('enforces PK uniqueness on (user_id, team_id)', () => {
    addMembership(db, { userId, teamId: 'team-a', role: 'owner' });
    expect(() => addMembership(db, { userId, teamId: 'team-a', role: 'member' })).toThrow();
  });
});
