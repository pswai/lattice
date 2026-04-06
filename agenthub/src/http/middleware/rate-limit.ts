import { createMiddleware } from 'hono/factory';
import { createHash } from 'crypto';

/**
 * In-memory sliding-window rate limiter keyed by API key hash.
 * Not suitable for multi-instance deployments; fine for single-node.
 */

interface Bucket {
  /** Request timestamps (ms) within the current window. */
  hits: number[];
}

const buckets = new Map<string, Bucket>();
const workspaceBuckets = new Map<string, Bucket>();

/** Test helper — clears in-memory rate-limit state. */
export function __resetRateLimit(): void {
  buckets.clear();
  workspaceBuckets.clear();
}

function pruneOld(bucket: Bucket, windowStart: number): void {
  // Hits are pushed in order, so drop from the front while stale.
  let drop = 0;
  for (const t of bucket.hits) {
    if (t < windowStart) drop++;
    else break;
  }
  if (drop > 0) bucket.hits.splice(0, drop);
}

export interface RateLimitOptions {
  perMinute: number;
  windowMs?: number;
}

export function createRateLimitMiddleware({ perMinute, windowMs = 60_000 }: RateLimitOptions) {
  return createMiddleware(async (c, next) => {
    if (perMinute <= 0) {
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      // Let auth middleware reject this request.
      await next();
      return;
    }

    const keyId = createHash('sha256').update(authHeader).digest('hex');
    const now = Date.now();
    const windowStart = now - windowMs;
    let bucket = buckets.get(keyId);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(keyId, bucket);
    }
    pruneOld(bucket, windowStart);

    if (bucket.hits.length >= perMinute) {
      const oldest = bucket.hits[0];
      const resetMs = oldest + windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((resetMs - now) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      c.header('X-RateLimit-Limit', String(perMinute));
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
      return c.json(
        { error: 'RATE_LIMITED', message: 'Too many requests' },
        429,
      );
    }

    bucket.hits.push(now);
    const remaining = Math.max(0, perMinute - bucket.hits.length);
    c.header('X-RateLimit-Limit', String(perMinute));
    c.header('X-RateLimit-Remaining', String(remaining));
    await next();
  });
}

/**
 * Standalone rate-limit check for use outside middleware (e.g. MCP handler).
 * Returns { limited: false } or { limited: true, retryAfterSec }.
 */
export function checkRateLimit(
  key: string,
  perMinute: number,
  windowMs = 60_000,
): { limited: false } | { limited: true; retryAfterSec: number } {
  if (perMinute <= 0) return { limited: false };
  const now = Date.now();
  const windowStart = now - windowMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  pruneOld(bucket, windowStart);
  if (bucket.hits.length >= perMinute) {
    const oldest = bucket.hits[0];
    const resetMs = oldest + windowMs;
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((resetMs - now) / 1000)) };
  }
  bucket.hits.push(now);
  return { limited: false };
}

/**
 * Per-workspace rate limiter. Must run AFTER auth middleware so `c.get('auth')`
 * is available. Aggregates all requests for a given workspaceId.
 */
export function createWorkspaceRateLimitMiddleware({ perMinute, windowMs = 60_000 }: RateLimitOptions) {
  return createMiddleware(async (c, next) => {
    if (perMinute <= 0) {
      await next();
      return;
    }

    const auth = c.get('auth');
    if (!auth?.workspaceId) {
      await next();
      return;
    }

    const wsId = auth.workspaceId;
    const now = Date.now();
    const windowStart = now - windowMs;
    let bucket = workspaceBuckets.get(wsId);
    if (!bucket) {
      bucket = { hits: [] };
      workspaceBuckets.set(wsId, bucket);
    }
    pruneOld(bucket, windowStart);

    if (bucket.hits.length >= perMinute) {
      const oldest = bucket.hits[0];
      const resetMs = oldest + windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((resetMs - now) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      c.header('X-RateLimit-Workspace-Limit', String(perMinute));
      c.header('X-RateLimit-Workspace-Remaining', '0');
      c.header('X-RateLimit-Workspace-Reset', String(Math.ceil(resetMs / 1000)));
      return c.json(
        { error: 'RATE_LIMITED', message: 'Workspace rate limit exceeded' },
        429,
      );
    }

    bucket.hits.push(now);
    const remaining = Math.max(0, perMinute - bucket.hits.length);
    c.header('X-RateLimit-Workspace-Limit', String(perMinute));
    c.header('X-RateLimit-Workspace-Remaining', String(remaining));
    await next();
  });
}
