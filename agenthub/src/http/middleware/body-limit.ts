import { createMiddleware } from 'hono/factory';

/**
 * Reject POST/PUT/PATCH requests whose body exceeds `maxBytes`.
 * Checks Content-Length header first (fast reject), then enforces
 * the limit on the actual body read to prevent header-lying attacks.
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
    // Fast reject via Content-Length header
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

    // Enforce actual body size by consuming the stream with a byte counter.
    // Replace the original request with one whose body is verified.
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            reader.cancel();
            return c.json(
              {
                error: 'PAYLOAD_TOO_LARGE',
                message: `Request body exceeds limit of ${maxBytes} bytes`,
              },
              413,
            );
          }
          chunks.push(value);
        }
      } catch {
        return c.json(
          { error: 'BAD_REQUEST', message: 'Failed to read request body' },
          400,
        );
      }
      // Reconstruct the body so downstream handlers can read it
      const body = new Blob(chunks);
      const newReq = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body,
        // @ts-expect-error duplex is required for Request with body in Node
        duplex: 'half',
      });
      // Replace the raw request with the body-verified one
      Object.defineProperty(c.req, 'raw', { value: newReq, writable: true });
    }

    await next();
  });
}
