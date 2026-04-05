import { createMiddleware } from 'hono/factory';

/** Rejects with 401 if no session is attached to the context. */
export const requireSession = createMiddleware(async (c, next) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Sign in required' }, 401);
  }
  await next();
});
