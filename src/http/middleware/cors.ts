import { createMiddleware } from 'hono/factory';

export interface CorsOptions {
  /** Allowed origins — exact-match list, or `'*'` wildcard. */
  origins: string[] | '*';
  /** When true, emit Access-Control-Allow-Credentials: true. */
  credentials?: boolean;
  /** Cache preflight response for this many seconds. Default 600. */
  maxAge?: number;
}

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, X-Agent-ID, X-Team-Override, X-Request-ID';

/**
 * CORS middleware. Supports exact-match origin list or `'*'`. Never emits
 * `Access-Control-Allow-Origin: *` when `credentials: true`.
 *
 * Throws at construction time if `origins === '*'` and `credentials === true`.
 * Callers should guard with `origins.length > 0` or `'*'` — when `origins=[]`,
 * mount nothing (the middleware is not meant to be inert at runtime).
 */
export function createCorsMiddleware(opts: CorsOptions) {
  const { origins, credentials = false, maxAge = 600 } = opts;

  if (origins === '*' && credentials) {
    throw new Error(
      'CORS: cannot combine origins="*" with credentials=true; browsers reject this combination',
    );
  }

  const matchOrigin = (requestOrigin: string | null | undefined): string | null => {
    if (!requestOrigin) return null;
    if (origins === '*') return '*';
    return origins.includes(requestOrigin) ? requestOrigin : null;
  };

  return createMiddleware(async (c, next) => {
    const requestOrigin = c.req.header('Origin') ?? null;
    const allowOrigin = matchOrigin(requestOrigin);

    // Always vary on Origin so shared caches don't leak the wrong ACAO.
    c.header('Vary', 'Origin');

    // Preflight
    if (c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Method')) {
      if (!allowOrigin) {
        // Origin not allowed — return 204 with no CORS headers; the browser blocks.
        return c.body(null, 204);
      }
      c.header('Access-Control-Allow-Origin', allowOrigin);
      c.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
      const reqHeaders = c.req.header('Access-Control-Request-Headers');
      c.header('Access-Control-Allow-Headers', reqHeaders || ALLOWED_HEADERS);
      c.header('Access-Control-Max-Age', String(maxAge));
      if (credentials) {
        c.header('Access-Control-Allow-Credentials', 'true');
      }
      return c.body(null, 204);
    }

    // Actual request — set headers then continue.
    if (allowOrigin) {
      c.header('Access-Control-Allow-Origin', allowOrigin);
      if (credentials) {
        c.header('Access-Control-Allow-Credentials', 'true');
      }
    }
    await next();
  });
}
