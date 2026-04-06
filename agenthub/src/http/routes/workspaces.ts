import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import type { AppConfig } from '../../config.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../../errors.js';
import {
  addMembership,
  listUserMemberships,
  getMembership,
  listTeamMembers,
  changeRole,
  removeMembership,
  countOwners,
  type MembershipRole,
} from '../../models/membership.js';
import { getCurrentUsageWithLimits } from '../../models/usage.js';
import {
  createInvitation,
  listTeamInvitations,
  getInvitationById,
  revokeInvitation,
  acceptInvitation,
} from '../../models/invitation.js';
import { requireSession } from '../middleware/require-session.js';
import {
  queryAuditLog,
  encodeAuditCursor,
  decodeAuditCursor,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
} from '../../models/audit-query.js';
import type { EmailSender } from '../../services/email.js';
import { getLogger } from '../../logger.js';

const CreateWorkspaceSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/, 'id must be lowercase alphanumeric, hyphens, or underscores'),
  name: z.string().min(1).max(255),
});

const RenameWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const InviteSchema = z.object({
  email: z.string().regex(EMAIL_RE, 'Invalid email').max(320),
  role: z.enum(['admin', 'member', 'viewer']),
});

const AcceptInviteSchema = z.object({
  token: z.string().min(1).max(500),
});

const ChangeRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

async function assertMembership(
  db: DbAdapter,
  userId: string,
  teamId: string,
): Promise<MembershipRole> {
  const membership = await getMembership(db, userId, teamId);
  if (!membership) {
    throw new NotFoundError('Workspace', teamId);
  }
  return membership.role;
}

async function assertRole(
  db: DbAdapter,
  userId: string,
  teamId: string,
  allowed: MembershipRole[],
): Promise<MembershipRole> {
  const role = await assertMembership(db, userId, teamId);
  if (!allowed.includes(role)) {
    throw new ForbiddenError(
      `This action requires one of roles: ${allowed.join(', ')}`,
    );
  }
  return role;
}

export function createWorkspaceRoutes(
  db: DbAdapter,
  config?: AppConfig,
  emailSender: EmailSender | null = null,
): Hono {
  const router = new Hono();

  // IMPORTANT: must come before `/:id` routes so `/invites/accept` isn't
  // interpreted as a workspace id.
  router.post('/invites/accept', requireSession, async (c) => {
    const session = c.get('session')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = AcceptInviteSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    const result = await acceptInvitation(db, parsed.data.token, session.userId);
    return c.json({ team_id: result.teamId, role: result.role }, 201);
  });

  router.post('/', requireSession, async (c) => {
    const session = c.get('session')!;
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const { id, name } = parsed.data;
    const rawKey = `lt_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    await db.transaction(async (tx) => {
      try {
        await tx.run(
          'INSERT INTO teams (id, name, owner_user_id, slug) VALUES (?, ?, ?, ?)',
          id, name, session.userId, id,
        );
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('UNIQUE')) {
          throw new ValidationError(`Workspace "${id}" already exists`);
        }
        throw err;
      }
      await addMembership(tx, { userId: session.userId, teamId: id, role: 'owner' });
      await tx.run(
        'INSERT INTO api_keys (team_id, key_hash, label, scope) VALUES (?, ?, ?, ?)',
        id, keyHash, 'default', 'write',
      );
    });

    return c.json(
      { team_id: id, name, api_key: rawKey, scope: 'write' as const, role: 'owner' as const },
      201,
    );
  });

  router.get('/', requireSession, async (c) => {
    const session = c.get('session')!;
    const memberships = await listUserMemberships(db, session.userId);
    return c.json({
      workspaces: memberships.map((m) => ({
        team_id: m.teamId,
        name: m.teamName,
        role: m.role,
        joined_at: m.joinedAt,
      })),
    });
  });

  router.patch('/:id', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    await assertRole(db, session.userId, teamId, ['owner', 'admin']);
    const body = await c.req.json().catch(() => ({}));
    const parsed = RenameWorkspaceSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    await db.run('UPDATE teams SET name = ? WHERE id = ?', parsed.data.name, teamId);
    return c.json({ team_id: teamId, name: parsed.data.name });
  });

  router.delete('/:id', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    const membership = await getMembership(db, session.userId, teamId);
    if (!membership) {
      return c.json({ error: 'NOT_FOUND', message: 'Workspace not found' }, 404);
    }
    if (membership.role !== 'owner') {
      return c.json({ error: 'FORBIDDEN', message: 'Only the workspace owner can delete it' }, 403);
    }

    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM api_keys WHERE team_id = ?', teamId);
      await tx.run('DELETE FROM team_memberships WHERE team_id = ?', teamId);
      await tx.run('DELETE FROM team_invitations WHERE team_id = ?', teamId);
      await tx.run('DELETE FROM teams WHERE id = ?', teamId);
    });

    return c.body(null, 204);
  });

  // --- Invitations ---

  router.post('/:id/invites', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    await assertRole(db, session.userId, teamId, ['owner', 'admin']);
    const body = await c.req.json().catch(() => ({}));
    const parsed = InviteSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    const { raw, invitationId, expiresAt } = await createInvitation(db, {
      teamId,
      email: parsed.data.email,
      role: parsed.data.role,
      invitedBy: session.userId,
    });

    if (emailSender && config) {
      const acceptUrl = `${config.appBaseUrl}/workspaces/invites/accept?token=${raw}`;
      const emailBody = `You've been invited to join workspace "${teamId}" on Lattice as ${parsed.data.role}.\n\nAccept the invitation by clicking the link below:\n\n${acceptUrl}\n\nThis invite expires on ${expiresAt}.`;
      emailSender
        .send(parsed.data.email, `You're invited to ${teamId} on Lattice`, emailBody)
        .catch((err: unknown) => {
          getLogger().error('email_send_failed', {
            to: parsed.data.email,
            kind: 'invite',
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    const resBody: Record<string, unknown> = {
      invitation_id: invitationId,
      expires_at: expiresAt,
    };
    if (config?.emailVerificationReturnTokens) {
      resBody.invite_token = raw;
    }
    return c.json(resBody, 201);
  });

  router.get('/:id/invites', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    await assertRole(db, session.userId, teamId, ['owner', 'admin']);
    const invitations = await listTeamInvitations(db, teamId);
    return c.json(
      invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        invited_by: inv.invitedBy,
        created_at: inv.createdAt,
        expires_at: inv.expiresAt,
      })),
    );
  });

  router.delete('/:id/invites/:invId', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    const invId = c.req.param('invId');
    await assertRole(db, session.userId, teamId, ['owner', 'admin']);
    const inv = await getInvitationById(db, invId);
    if (!inv || inv.teamId !== teamId) {
      return c.json({ error: 'NOT_FOUND', message: 'Invitation not found' }, 404);
    }
    await revokeInvitation(db, invId);
    return c.body(null, 204);
  });

  // --- Members ---

  router.get('/:id/members', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    await assertMembership(db, session.userId, teamId);
    const members = await listTeamMembers(db, teamId);
    return c.json(
      members.map((m) => ({
        user_id: m.userId,
        email: m.email,
        name: m.name,
        role: m.role,
        joined_at: m.joinedAt,
      })),
    );
  });

  router.patch('/:id/members/:userId', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    const targetUserId = c.req.param('userId');
    await assertRole(db, session.userId, teamId, ['owner']);
    const body = await c.req.json().catch(() => ({}));
    const parsed = ChangeRoleSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    const target = await getMembership(db, targetUserId, teamId);
    if (!target) {
      return c.json({ error: 'NOT_FOUND', message: 'Member not found' }, 404);
    }
    const newRole = parsed.data.role;
    if (target.role === 'owner' && newRole !== 'owner' && await countOwners(db, teamId) === 1) {
      return c.json(
        {
          error: 'LAST_OWNER_DEMOTION',
          message: 'Cannot demote the last owner of a workspace',
        },
        409,
      );
    }
    await changeRole(db, targetUserId, teamId, newRole);
    const refreshed = (await getMembership(db, targetUserId, teamId))!;
    return c.json({
      user_id: refreshed.userId,
      team_id: refreshed.teamId,
      role: refreshed.role,
    });
  });

  router.delete('/:id/members/:userId', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    const targetUserId = c.req.param('userId');
    const selfRole = await assertMembership(db, session.userId, teamId);
    const isSelf = session.userId === targetUserId;
    if (!isSelf && selfRole !== 'owner') {
      throw new ForbiddenError('Only the workspace owner can remove other members');
    }
    const target = await getMembership(db, targetUserId, teamId);
    if (!target) {
      return c.json({ error: 'NOT_FOUND', message: 'Member not found' }, 404);
    }
    if (target.role === 'owner' && await countOwners(db, teamId) === 1) {
      return c.json(
        {
          error: 'LAST_OWNER_REMOVAL',
          message: 'Cannot remove the last owner of a workspace',
        },
        409,
      );
    }
    await removeMembership(db, targetUserId, teamId);
    return c.body(null, 204);
  });

  // --- Audit log query (any member can read) ---

  router.get('/:id/audit', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    const membership = await getMembership(db, session.userId, teamId);
    if (!membership) {
      return c.json({ error: 'FORBIDDEN', message: 'Not a member of this workspace' }, 403);
    }

    const q = c.req.query();
    let limit = DEFAULT_AUDIT_LIMIT;
    if (q.limit) {
      const n = parseInt(q.limit, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError('limit must be a positive integer');
      }
      limit = Math.min(n, MAX_AUDIT_LIMIT);
    }
    let beforeId: number | undefined;
    if (q.cursor) {
      const decoded = decodeAuditCursor(q.cursor);
      if (decoded === null) {
        throw new ValidationError('invalid cursor');
      }
      beforeId = decoded;
    }

    const rows = await queryAuditLog(db, teamId, {
      actor: q.actor,
      action: q.action,
      resource: q.resource,
      since: q.since,
      until: q.until,
      limit,
      beforeId,
    });

    const entries = rows.map((r) => {
      let metadata: unknown = {};
      try {
        metadata = JSON.parse(r.metadata);
      } catch {
        metadata = {};
      }
      // Compose resource string from (resource_type, resource_id) so callers
      // can filter/correlate without seeing the underlying columns.
      const resource = r.resource_type
        ? (r.resource_id ? `${r.resource_type}:${r.resource_id}` : r.resource_type)
        : null;
      return {
        id: r.id,
        actor: r.actor,
        action: r.action,
        resource,
        metadata,
        ip: r.ip,
        request_id: r.request_id,
        created_at: r.created_at,
      };
    });

    const nextCursor = rows.length === limit && rows.length > 0
      ? encodeAuditCursor(rows[rows.length - 1].id)
      : null;

    return c.json({ entries, next_cursor: nextCursor });
  });

  // ─── Usage ────────────────────────────────────────────────────────
  router.get('/:id/usage', requireSession, async (c) => {
    const session = c.get('session')!;
    const teamId = c.req.param('id');
    await assertMembership(db, session.userId, teamId);

    const result = await getCurrentUsageWithLimits(db, teamId);
    return c.json({
      period: result.period,
      usage: {
        exec_count: result.usage.execCount,
        api_call_count: result.usage.apiCallCount,
        storage_bytes: result.usage.storageBytes,
      },
      limits: {
        plan_id: result.limits.id,
        plan_name: result.limits.name,
        exec_quota: result.limits.execQuota,
        api_call_quota: result.limits.apiCallQuota,
        storage_bytes_quota: result.limits.storageBytesQuota,
        seat_quota: result.limits.seatQuota,
      },
      soft_warning: result.soft,
      hard_exceeded: result.hard,
    });
  });

  return router;
}
