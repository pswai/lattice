import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type { DbAdapter } from '../../db/adapter.js';
import type { AppConfig } from '../../config.js';
import { ValidationError } from '../../errors.js';
import {
  createUser,
  getUserById,
  authenticateUser,
  setEmailVerified,
} from '../../models/user.js';
import {
  createSession,
  revokeSession,
  listUserSessions,
  revokeUserSessionsExcept,
  type CreateSessionResult,
} from '../../models/session.js';
import { listUserMemberships } from '../../models/membership.js';
import { requireSession } from '../middleware/require-session.js';
import { SESSION_COOKIE_NAME } from '../middleware/session.js';
import type { EmailSender } from '../../services/email.js';
import { getLogger } from '../../logger.js';

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
        team_id: m.teamId,
        team_name: m.teamName,
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
