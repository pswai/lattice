import { createMiddleware } from 'hono/factory';
import { httpRequestsTotal, httpRequestDurationMs } from '../../metrics.js';

/**
 * Collapse high-cardinality segments in a URL path so we don't explode the
 * metrics label space. Numeric IDs become `:id`, long opaque tokens (>=16
 * chars, mostly hex/uuid-shaped) become `:id` too.
 */
export function normalizeRoute(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      if (seg.length === 0) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-fA-F-]{16,}$/.test(seg)) return ':id';
      return seg;
    })
    .join('/');
}

/**
 * HTTP metrics middleware: observes duration + increments request counter
 * for every response. Safe to use before or after auth — it reads
 * `c.get('auth')` defensively.
 */
export function createMetricsMiddleware() {
  return createMiddleware(async (c, next) => {
    // Never observe the metrics endpoint itself; avoids a feedback loop
    // where scrapers inflate their own counters.
    if (c.req.path === '/metrics') {
      await next();
      return;
    }

    const start = performance.now();
    let threw = false;
    try {
      await next();
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      const dur = performance.now() - start;
      // Prefer route template when available so label cardinality stays low.
      const rawRoute =
        (c.req as unknown as { routePath?: string }).routePath ?? c.req.path;
      const route = normalizeRoute(rawRoute);
      const method = c.req.method;
      const status = threw ? 500 : c.res.status;
      const auth = c.get('auth' as never) as { workspaceId?: string } | undefined;
      const team = auth?.workspaceId ?? 'unknown';

      httpRequestDurationMs.observe({ method, route }, dur);
      httpRequestsTotal.inc({ method, route, status, team }, 1);
    }
  });
}
