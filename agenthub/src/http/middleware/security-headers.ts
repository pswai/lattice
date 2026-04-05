import { createMiddleware } from 'hono/factory';

export interface SecurityHeadersOptions {
  /** When true, emit Strict-Transport-Security. Default false. */
  hstsEnabled?: boolean;
}

/**
 * Set conservative security response headers. Content-Security-Policy is
 * intentionally left to the caller — it can easily break the dashboard.
 */
export function createSecurityHeadersMiddleware(
  { hstsEnabled = false }: SecurityHeadersOptions = {},
) {
  return createMiddleware(async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    // Dashboard is served on `/` and we allow it to be framed by the same
    // origin (useful for embed/preview). Everything else forbids framing.
    const frameOption = c.req.path === '/' ? 'SAMEORIGIN' : 'DENY';
    c.header('X-Frame-Options', frameOption);
    c.header('Referrer-Policy', 'no-referrer');
    if (hstsEnabled) {
      c.header(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }
  });
}
