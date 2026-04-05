import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
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

export function createAuthRoutes(db: Database.Database, config: AppConfig): Hono {
  const router = new Hono();

  router.post('/signup', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SignupSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }

    const user = createUser(db, parsed.data);
    const { ip, userAgent } = requestMeta(c);
    const session = createSession(db, user.id, { ip, userAgent, ttlDays: SIGNUP_TTL_DAYS });

    // Issue an email verification token (one-shot, hashed at rest).
    const verifyRaw = randomBytes(24).toString('base64url');
    const verifyHash = createHash('sha256').update(verifyRaw).digest('hex');
    const verifyExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      'INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    ).run(verifyHash, user.id, verifyExpiresAt);

    c.header('Set-Cookie', sessionCookieHeader(session, config.cookieSecure));
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
    const user = authenticateUser(db, parsed.data.email, parsed.data.password);
    if (!user) {
      return c.json({ error: 'INVALID_CREDENTIALS', message: 'Email or password incorrect' }, 401);
    }
    const { ip, userAgent } = requestMeta(c);
    const session = createSession(db, user.id, { ip, userAgent, ttlDays: SIGNUP_TTL_DAYS });
    c.header('Set-Cookie', sessionCookieHeader(session, config.cookieSecure));
    return c.json({ user: { id: user.id, email: user.email, name: user.name } });
  });

  router.post('/logout', async (c) => {
    const session = c.get('session');
    if (session) {
      revokeSession(db, session.sessionId);
    }
    c.header('Set-Cookie', clearCookieHeader(config.cookieSecure));
    return c.body(null, 204);
  });

  router.get('/me', requireSession, (c) => {
    const session = c.get('session')!;
    const user = getUserById(db, session.userId);
    if (!user) {
      return c.json({ error: 'NOT_FOUND', message: 'User not found' }, 404);
    }
    const memberships = listUserMemberships(db, user.id);
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

  router.get('/sessions', requireSession, (c) => {
    const session = c.get('session')!;
    const sessions = listUserSessions(db, session.userId);
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

  router.delete('/sessions/:id', requireSession, (c) => {
    const session = c.get('session')!;
    const targetId = c.req.param('id');
    // Verify the target session belongs to the current user (don't leak existence).
    const row = db
      .prepare('SELECT user_id FROM sessions WHERE id = ?')
      .get(targetId) as { user_id: string } | undefined;
    if (!row || row.user_id !== session.userId) {
      return c.json({ error: 'NOT_FOUND', message: 'Session not found' }, 404);
    }
    revokeSession(db, targetId);
    return c.body(null, 204);
  });

  router.delete('/sessions', requireSession, (c) => {
    const session = c.get('session')!;
    const result = revokeUserSessionsExcept(db, session.userId, session.sessionId);
    return c.json({ revoked: result.revoked });
  });

  router.post('/verify-email', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = VerifyEmailSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', { issues: parsed.error.flatten().fieldErrors });
    }
    const tokenHash = createHash('sha256').update(parsed.data.token).digest('hex');
    const row = db
      .prepare('SELECT user_id, expires_at, used_at FROM email_verifications WHERE token_hash = ?')
      .get(tokenHash) as { user_id: string; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
      return c.json({ error: 'INVALID_TOKEN', message: 'Token invalid or expired' }, 400);
    }
    db.prepare(
      "UPDATE email_verifications SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?",
    ).run(tokenHash);
    setEmailVerified(db, row.user_id);
    return c.body(null, 204);
  });

  return router;
}
