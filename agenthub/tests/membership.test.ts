import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './helpers.js';
import { createUser } from '../src/models/user.js';
import {
  addMembership,
  listUserMemberships,
  listTeamMembers,
  getMembership,
} from '../src/models/membership.js';

function makeTeam(db: ReturnType<typeof createTestDb>, id: string, name: string): void {
  db.rawDb.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, name);
}

describe('Membership model', () => {
  let db: ReturnType<typeof createTestDb>;
  let userId: string;

  beforeEach(async () => {
    db = createTestDb();
    userId = (await createUser(db, { email: 'owner@example.com', password: 'longenough-pass' })).id;
    makeTeam(db, 'team-a', 'Team A');
    makeTeam(db, 'team-b', 'Team B');
  });

  it('adds and fetches memberships', async () => {
    const m = await addMembership(db, { userId, teamId: 'team-a', role: 'owner' });
    expect(m.role).toBe('owner');
    const fetched = await getMembership(db, userId, 'team-a');
    expect(fetched).not.toBeNull();
    expect(fetched!.role).toBe('owner');
    expect(await getMembership(db, userId, 'never')).toBeNull();
  });

  it('lists memberships by user, joined with team name', async () => {
    await addMembership(db, { userId, teamId: 'team-a', role: 'owner' });
    await addMembership(db, { userId, teamId: 'team-b', role: 'member' });
    const list = await listUserMemberships(db, userId);
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.teamId).sort()).toEqual(['team-a', 'team-b']);
    expect(list.find((m) => m.teamId === 'team-a')!.teamName).toBe('Team A');
    expect(list.find((m) => m.teamId === 'team-a')!.role).toBe('owner');
  });

  it('lists team members, joined with user email', async () => {
    const other = (await createUser(db, { email: 'other@example.com', password: 'longenough-pass' })).id;
    await addMembership(db, { userId, teamId: 'team-a', role: 'owner' });
    await addMembership(db, { userId: other, teamId: 'team-a', role: 'member' });
    const members = await listTeamMembers(db, 'team-a');
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.email).sort()).toEqual(['other@example.com', 'owner@example.com']);
  });

  it('enforces role CHECK constraint', async () => {
    await expect(
      addMembership(db, { userId, teamId: 'team-a', role: 'superlord' as never }),
    ).rejects.toThrow();
  });

  it('enforces PK uniqueness on (user_id, team_id)', async () => {
    await addMembership(db, { userId, teamId: 'team-a', role: 'owner' });
    await expect(addMembership(db, { userId, teamId: 'team-a', role: 'member' })).rejects.toThrow();
  });
});
