import { createMiddleware } from 'hono/factory';
import { randomUUID } from 'crypto';
import { getLogger, type Logger } from '../../logger.js';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    logger: Logger;
  }
}

// Accept incoming X-Request-ID only if it looks sane. Prevents injection
// of huge / weird values into our log pipeline.
const REQUEST_ID_RE = /^[A-Za-z0-9_.\-]{6,64}$/;

/**
 * Request-scoped context middleware.
 *
 * - Assigns (or honors) X-Request-ID for every HTTP request
 * - Echoes the ID back in the response header for client correlation
 * - Creates a per-request child logger bound with req_id
 * - Logs a single `http_request` line on completion (method, path,
 *   status, duration_ms, workspace_id, agent_id) — one line per request,
 *   suitable for any log aggregator (Loki, CloudWatch, Datadog, etc).
 */
export function createRequestContextMiddleware(baseLogger?: Logger) {
  return createMiddleware(async (c, next) => {
    const incoming = c.req.header('X-Request-ID');
    const reqId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    const log = (baseLogger ?? getLogger()).child({ req_id: reqId });

    c.set('requestId', reqId);
    c.set('logger', log);
    c.header('X-Request-ID', reqId);

    const start = performance.now();
    try {
      await next();
    } finally {
      const dur = Math.round(performance.now() - start);
      // auth context is only present after auth middleware ran; may be undefined
      const auth = c.get('auth' as never) as
        | { workspaceId?: string; agentId?: string }
        | undefined;
      // c.error is set by Hono when a downstream middleware/handler throws,
      // even after onError converts it into a 500 response.
      const caught = c.error;
      const fields: Record<string, unknown> = {
        method: c.req.method,
        path: c.req.path,
        status: caught ? 500 : c.res.status,
        duration_ms: dur,
      };
      if (auth?.workspaceId) fields.workspace_id = auth.workspaceId;
      if (auth?.agentId && auth.agentId !== 'anonymous') fields.agent_id = auth.agentId;
      if (caught instanceof Error) fields.error = caught.message;
      log.info('http_request', fields);
    }
  });
}
