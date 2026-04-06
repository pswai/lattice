import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import type { AppConfig } from '../../config.js';
import { ValidationError } from '../../errors.js';
import {
  createUser,
  getUserById,
  getUserByEmail,
  authenticateUser,
  setEmailVerified,
  hashPassword,
  createPasswordReset,
  consumePasswordReset,
  deleteUser,
  deleteWorkspaceData,
} from '../../models/user.js';
import {
  createSession,
  revokeSession,
  listUserSessions,
  revokeUserSessionsExcept,
  revokeAllUserSessions,
  type CreateSessionResult,
} from '../../models/session.js';
import { listUserMemberships } from '../../models/membership.js';
import { requireSession } from '../middleware/require-session.js';
import { SESSION_COOKIE_NAME } from '../middleware/session.js';
import type { EmailSender } from '../../services/email.js';
import { writeAudit } from '../../models/audit.js';
import { getLogger } from '../../logger.js';

/**
 * In-memory sliding-window rate limiter for forgot-password.
 * Key = lowercased email, value = array of request timestamps.
 */
const forgotPasswordBuckets = new Map<string, number[]>();
const FORGOT_PW_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FORGOT_PW_MAX = 3;

/** Test helper — clears in-memory forgot-password rate-limit state. */
export function __resetForgotPasswordRateLimit(): void {
  forgotPasswordBuckets.clear();
}

function isForgotPasswordRateLimited(email: string): boolean {
  const key = email.trim().toLowerCase();
  const now = Date.now();
  const windowStart = now - FORGOT_PW_WINDOW_MS;
  let hits = forgotPasswordBuckets.get(key);
  if (!hits) {
    hits = [];
    forgotPasswordBuckets.set(key, hits);
  }
  // Prune old entries
  let drop = 0;
  for (const t of hits) {
    if (t < windowStart) drop++;
    else break;
  }
  if (drop > 0) hits.splice(0, drop);

  if (hits.length >= FORGOT_PW_MAX) return true;
  hits.push(now);
  return false;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGNUP_TTL_DAYS = 30;

const SignupSchema = z.object({
  email: z.string().regex(EMAIL_RE, 'Invalid email').max(320),
  password: z.string().min(8).max(200),
  name: z.string().max(200).optional(),
});

const LoginSchema = z.object({
  email: z.string().max(320),
  password: z.string().min(1).max(200),
});

const VerifyEmailSchema = z.object({
  token: z.string().min(1).max(200),
});

const ForgotPasswordSchema = z.object({
  email: z.string().max(320),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
});

function sessionCookieHeader(result: CreateSessionResult, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${result.raw}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SIGNUP_TTL_DAYS * 24 * 60 * 60}`,
    `Expires=${new Date(result.expiresAt).toUTCString()}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookieHeader(secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function requestMeta(c: {
  req: { header: (n: string) => string | undefined };
}): { ip?: string; userAgent?: string } {
  const ip =
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    undefined;
  const userAgent = c.req.header('User-Agent') || undefined;
  return { ip, userAgent };
}

export function createAuthRoutes(
  db: DbAdapter,
  config: AppConfig,
  emailSender: EmailSender | null = null,
): Hono {
  const router = new Hono();

  router.post('/signup', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SignupSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const user = await createUser(db, parsed.data);
    const { ip, userAgent } = requestMeta(c);
    const session = await createSession(db, user.id, { ip, userAgent, ttlDays: SIGNUP_TTL_DAYS });

    // Issue an email verification token (one-shot, hashed at rest).
    const verifyRaw = randomBytes(24).toString('base64url');
    const verifyHash = createHash('sha256').update(verifyRaw).digest('hex');
    const verifyExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
      'INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      verifyHash, user.id, verifyExpiresAt,
    );

    c.header('Set-Cookie', sessionCookieHeader(session, config.cookieSecure));

    if (emailSender) {
      const verifyUrl = `${config.appBaseUrl}/auth/verify-email?token=${verifyRaw}`;
      const emailBody = `Welcome to Lattice!\n\nPlease verify your email by clicking the link below:\n\n${verifyUrl}\n\nThis link expires in 7 days.`;
      emailSender
        .send(user.email, 'Verify your Lattice email', emailBody)
        .catch((err: unknown) => {
          getLogger().error('email_send_failed', {
            to: user.email,
            kind: 'verify',
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    const resBody: Record<string, unknown> = {
      user: { id: user.id, email: user.email, name: user.name },
    };
    if (config.emailVerificationReturnTokens) {
      resBody.email_verification_token = verifyRaw;
    }
    return c.json(resBody, 201);
  });

  router.post('/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    const user = await authenticateUser(db, parsed.data.email, parsed.data.password);
    if (!user) {
      return c.json({ error: 'INVALID_CREDENTIALS', message: 'Email or password incorrect' }, 401);
    }
    const { ip, userAgent } = requestMeta(c);
    const session = await createSession(db, user.id, { ip, userAgent, ttlDays: SIGNUP_TTL_DAYS });
    c.header('Set-Cookie', sessionCookieHeader(session, config.cookieSecure));
    return c.json({ user: { id: user.id, email: user.email, name: user.name } });
  });

  router.post('/logout', async (c) => {
    const session = c.get('session');
    if (session) {
      await revokeSession(db, session.sessionId);
    }
    c.header('Set-Cookie', clearCookieHeader(config.cookieSecure));
    return c.body(null, 204);
  });

  router.get('/me', requireSession, async (c) => {
    const session = c.get('session')!;
    const user = await getUserById(db, session.userId);
    if (!user) {
      return c.json({ error: 'NOT_FOUND', message: 'User not found' }, 404);
    }
    const memberships = await listUserMemberships(db, user.id);
    return c.json({
      user: { id: user.id, email: user.email, name: user.name, email_verified_at: user.emailVerifiedAt },
      memberships: memberships.map((m) => ({
        workspace_id: m.workspaceId,
        workspace_name: m.workspaceName,
        role: m.role,
        joined_at: m.joinedAt,
      })),
    });
  });

  router.get('/sessions', requireSession, async (c) => {
    const session = c.get('session')!;
    const sessions = await listUserSessions(db, session.userId);
    return c.json(
      sessions.map((s) => ({
        id: s.id,
        created_at: s.createdAt,
        expires_at: s.expiresAt,
        ip: s.ip,
        user_agent: s.userAgent,
        current: s.id === session.sessionId,
      })),
    );
  });

  router.delete('/sessions/:id', requireSession, async (c) => {
    const session = c.get('session')!;
    const targetId = c.req.param('id');
    // Verify the target session belongs to the current user (don't leak existence).
    const row = await db.get<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE id = ?',
      targetId,
    );
    if (!row || row.user_id !== session.userId) {
      return c.json({ error: 'NOT_FOUND', message: 'Session not found' }, 404);
    }
    await revokeSession(db, targetId);
    return c.body(null, 204);
  });

  router.delete('/sessions', requireSession, async (c) => {
    const session = c.get('session')!;
    const result = await revokeUserSessionsExcept(db, session.userId, session.sessionId);
    return c.json({ revoked: result.revoked });
  });

  router.post('/forgot-password', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ForgotPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    // Rate limit: 3 requests per hour per email address.
    if (isForgotPasswordRateLimited(parsed.data.email)) {
      // Still return the same generic 200 to avoid leaking info.
      return c.json({ message: 'If that email is registered, a reset link has been sent.' });
    }

    // Always return 200 to avoid leaking whether the email exists.
    const user = await getUserByEmail(db, parsed.data.email);
    if (user) {
      const rawToken = await createPasswordReset(db, user.id);
      if (emailSender) {
        const resetUrl = `${config.appBaseUrl}/auth/reset-password?token=${rawToken}`;
        const emailBody = `You requested a password reset for your Lattice account.\n\nClick the link below to set a new password:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`;
        emailSender
          .send(user.email, 'Reset your Lattice password', emailBody)
          .catch((err: unknown) => {
            getLogger().error('email_send_failed', {
              to: user.email,
              kind: 'password_reset',
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    }

    return c.json({ message: 'If that email is registered, a reset link has been sent.' });
  });

  router.post('/reset-password', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ResetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const newHash = hashPassword(parsed.data.password);
    const userId = await consumePasswordReset(db, parsed.data.token, newHash);
    if (!userId) {
      return c.json({ error: 'INVALID_TOKEN', message: 'Token invalid or expired' }, 400);
    }
    // Invalidate all existing sessions after password change
    await revokeAllUserSessions(db, userId);
    return c.json({ message: 'Password has been reset.' });
  });

  router.delete('/account', requireSession, async (c) => {
    const session = c.get('session')!;
    const userId = session.userId;

    const user = await getUserById(db, userId);

    // Find workspaces owned by this user.
    const ownedWorkspaces = await db.all<{ id: string; name: string }>(
      'SELECT id, name FROM workspaces WHERE owner_user_id = ?',
      userId,
    );

    // Find memberships (for summary).
    const memberships = await listUserMemberships(db, userId);

    // Log the deletion in audit log BEFORE deleting data.
    // We log to each owned workspace's audit log.
    for (const ws of ownedWorkspaces) {
      await writeAudit(db, {
        workspaceId: ws.id,
        actor: userId,
        action: 'account.delete',
        resourceType: 'user',
        resourceId: userId,
        metadata: {
          email: user?.email,
          reason: 'GDPR account deletion',
          owned_workspace_ids: ownedWorkspaces.map((w) => w.id),
        },
      });
    }

    // Also log to any workspace the user is a member of (but doesn't own).
    for (const m of memberships) {
      const isOwned = ownedWorkspaces.some((ws) => ws.id === m.workspaceId);
      if (!isOwned) {
        await writeAudit(db, {
          workspaceId: m.workspaceId,
          actor: userId,
          action: 'account.delete',
          resourceType: 'user',
          resourceId: userId,
          metadata: {
            email: user?.email,
            reason: 'GDPR account deletion — member removed',
          },
        });
      }
    }

    // Delete owned workspaces and all their data.
    for (const ws of ownedWorkspaces) {
      await deleteWorkspaceData(db, ws.id);
    }

    // Delete the user and user-scoped data.
    await deleteUser(db, userId);

    c.header('Set-Cookie', clearCookieHeader(config.cookieSecure));
    return c.json({
      message: 'Account deleted',
      summary: {
        user_id: userId,
        email: user?.email,
        workspaces_deleted: ownedWorkspaces.map((ws) => ({ id: ws.id, name: ws.name })),
        memberships_removed: memberships
          .filter((m) => !ownedWorkspaces.some((ws) => ws.id === m.workspaceId))
          .map((m) => ({ workspace_id: m.workspaceId, role: m.role })),
      },
    });
  });

  router.post('/verify-email', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = VerifyEmailSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    const tokenHash = createHash('sha256').update(parsed.data.token).digest('hex');
    const row = await db.get<{ user_id: string; expires_at: string; used_at: string | null }>(
      'SELECT user_id, expires_at, used_at FROM email_verifications WHERE token_hash = ?',
      tokenHash,
    );
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
      return c.json({ error: 'INVALID_TOKEN', message: 'Token invalid or expired' }, 400);
    }
    await db.run(
      "UPDATE email_verifications SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?",
      tokenHash,
    );
    await setEmailVerified(db, row.user_id);
    return c.body(null, 204);
  });

  return router;
}
