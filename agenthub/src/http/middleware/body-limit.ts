import { createMiddleware } from 'hono/factory';

/**
 * Reject POST/PUT/PATCH requests whose Content-Length header exceeds
 * `maxBytes`. If Content-Length is missing we let the request through —
 * streaming uploads are rare here and not worth the extra complexity.
 *
 * Pass maxBytes=0 to disable.
 */
export function createBodyLimitMiddleware(maxBytes: number) {
  return createMiddleware(async (c, next) => {
    if (maxBytes <= 0) {
      await next();
      return;
    }
    const method = c.req.method.toUpperCase();
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      await next();
      return;
    }
    const cl = c.req.header('Content-Length');
    if (cl !== undefined) {
      const size = Number(cl);
      if (Number.isFinite(size) && size > maxBytes) {
        return c.json(
          {
            error: 'PAYLOAD_TOO_LARGE',
            message: `Request body exceeds limit of ${maxBytes} bytes`,
          },
          413,
        );
      }
    }
    await next();
  });
}
