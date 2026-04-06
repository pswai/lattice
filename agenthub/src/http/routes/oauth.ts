import { Hono } from 'hono';
import { randomBytes } from 'crypto';
import type { DbAdapter } from '../../db/adapter.js';
import type { AppConfig } from '../../config.js';
import { findOrCreateOAuthUser } from '../../models/oauth.js';
import { createSession, type CreateSessionResult } from '../../models/session.js';
import { SESSION_COOKIE_NAME } from '../middleware/session.js';

const OAUTH_STATE_COOKIE = 'oauth_state';
const STATE_TTL_SECONDS = 600;
const SESSION_TTL_DAYS = 30;

function sessionCookieHeader(result: CreateSessionResult, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${result.raw}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}`,
    `Expires=${new Date(result.expiresAt).toUTCString()}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function stateCookieHeader(state: string, secure: boolean): string {
  const attrs = [
    `${OAUTH_STATE_COOKIE}=${state}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${STATE_TTL_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearStateCookieHeader(secure: boolean): string {
  const attrs = [
    `${OAUTH_STATE_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = rest.join('=');
  }
  return out;
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

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function createOAuthRoutes(db: DbAdapter, config: AppConfig): Hono {
  const router = new Hono();

  router.get('/github', (c) => {
    if (!config.githubOAuthClientId) {
      return c.json(
        { error: 'OAUTH_NOT_CONFIGURED', message: 'GitHub OAuth is not configured' },
        503,
      );
    }
    const state = randomBytes(24).toString('base64url');
    const redirectUri = config.githubOAuthRedirectUri;
    const params = new URLSearchParams({
      client_id: config.githubOAuthClientId,
      scope: 'user:email',
      state,
    });
    if (redirectUri) params.set('redirect_uri', redirectUri);
    const url = `https://github.com/login/oauth/authorize?${params.toString()}`;
    c.header('Set-Cookie', stateCookieHeader(state, config.cookieSecure));
    return c.redirect(url, 302);
  });

  router.get('/github/callback', async (c) => {
    if (!config.githubOAuthClientId || !config.githubOAuthClientSecret) {
      return c.json(
        { error: 'OAUTH_NOT_CONFIGURED', message: 'GitHub OAuth is not configured' },
        503,
      );
    }
    const code = c.req.query('code');
    const stateParam = c.req.query('state');
    if (!code) {
      return c.json({ error: 'MISSING_CODE', message: 'Missing code parameter' }, 400);
    }
    const cookies = parseCookies(c.req.header('Cookie'));
    const stateCookie = cookies[OAUTH_STATE_COOKIE];
    if (!stateCookie) {
      return c.json({ error: 'MISSING_STATE', message: 'Missing oauth state cookie' }, 400);
    }
    if (!stateParam || stateParam !== stateCookie) {
      return c.json({ error: 'STATE_MISMATCH', message: 'OAuth state mismatch' }, 400);
    }

    // Exchange code for access token.
    let token: string;
    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: config.githubOAuthClientId,
          client_secret: config.githubOAuthClientSecret,
          code,
          redirect_uri: config.githubOAuthRedirectUri || undefined,
        }),
      });
      if (!tokenRes.ok) {
        return c.json(
          { error: 'TOKEN_EXCHANGE_FAILED', message: `Token exchange returned ${tokenRes.status}` },
          400,
        );
      }
      const tokenBody = (await tokenRes.json()) as GitHubTokenResponse;
      if (!tokenBody.access_token) {
        return c.json(
          {
            error: 'TOKEN_EXCHANGE_FAILED',
            message: tokenBody.error_description || tokenBody.error || 'No access_token',
          },
          400,
        );
      }
      token = tokenBody.access_token;
    } catch (err) {
      return c.json(
        {
          error: 'TOKEN_EXCHANGE_FAILED',
          message: err instanceof Error ? err.message : 'fetch failed',
        },
        400,
      );
    }

    // Fetch user profile + emails.
    let ghUser: GitHubUser;
    let emails: GitHubEmail[];
    try {
      const [userRes, emailsRes] = await Promise.all([
        fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Lattice',
          },
        }),
        fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Lattice',
          },
        }),
      ]);
      if (!userRes.ok) {
        return c.json(
          { error: 'USER_FETCH_FAILED', message: `GitHub user fetch ${userRes.status}` },
          400,
        );
      }
      ghUser = (await userRes.json()) as GitHubUser;
      emails = emailsRes.ok ? ((await emailsRes.json()) as GitHubEmail[]) : [];
    } catch (err) {
      return c.json(
        {
          error: 'USER_FETCH_FAILED',
          message: err instanceof Error ? err.message : 'fetch failed',
        },
        400,
      );
    }

    const primaryVerified = emails.find((e) => e.primary && e.verified);
    const anyVerified = emails.find((e) => e.verified);
    const email =
      primaryVerified?.email ?? anyVerified?.email ?? ghUser.email ?? null;

    const user = await findOrCreateOAuthUser(db, {
      provider: 'github',
      providerUid: String(ghUser.id),
      email,
      name: ghUser.name ?? ghUser.login,
    });

    const { ip, userAgent } = requestMeta(c);
    const session = await createSession(db, user.id, {
      ip,
      userAgent,
      ttlDays: SESSION_TTL_DAYS,
    });

    // Multiple Set-Cookie: use c.header append.
    c.header('Set-Cookie', sessionCookieHeader(session, config.cookieSecure), { append: true });
    c.header('Set-Cookie', clearStateCookieHeader(config.cookieSecure), { append: true });
    return c.redirect(config.appBaseUrl, 302);
  });

  return router;
}
