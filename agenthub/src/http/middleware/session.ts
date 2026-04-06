import { createMiddleware } from 'hono/factory';
import type { DbAdapter } from '../../db/adapter.js';
import { getSession } from '../../models/session.js';

export interface SessionAuth {
  userId: string;
  sessionId: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    session?: SessionAuth;
  }
}

const COOKIE_NAME = 'lt_session';

function parseSessionCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Attaches `session` to the Hono context if a valid lt_session cookie is present.
 * Does NOT reject when missing — downstream routes that require a session must
 * use `requireSession`.
 */
export function createSessionMiddleware(db: DbAdapter) {
  return createMiddleware(async (c, next) => {
    const cookieHeader = c.req.header('Cookie') || c.req.header('cookie');
    const raw = parseSessionCookie(cookieHeader);
    if (raw) {
      const session = await getSession(db, raw);
      if (session) {
        c.set('session', { userId: session.userId, sessionId: session.sessionId });
      }
    }
    await next();
  });
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
