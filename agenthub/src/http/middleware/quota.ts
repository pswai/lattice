import { createMiddleware } from 'hono/factory';
import type { DbAdapter } from '../../db/adapter.js';
import { getCurrentUsageWithLimits } from '../../models/usage.js';
import { incrementUsageForced } from '../../models/usage.js';
import { getLogger } from '../../logger.js';

export interface QuotaMiddlewareConfig {
  quotaEnforcement: boolean;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function secondsToNextPeriod(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export function createQuotaMiddleware(
  db: DbAdapter,
  config: QuotaMiddlewareConfig,
) {
  return createMiddleware(async (c, next) => {
    if (!config.quotaEnforcement) {
      await next();
      return;
    }
    const auth = c.get('auth');
    if (!auth) {
      await next();
      return;
    }
    const method = c.req.method.toUpperCase();
    const isMutating = MUTATING_METHODS.has(method);

    if (isMutating) {
      const state = await getCurrentUsageWithLimits(db, auth.workspaceId);
      if (state.hard) {
        c.header('Retry-After', String(secondsToNextPeriod()));
        return c.json(
          {
            error: 'QUOTA_EXCEEDED',
            message: 'Monthly quota exceeded for this workspace',
            period: state.period,
            limits: {
              exec_quota: state.limits.execQuota,
              api_call_quota: state.limits.apiCallQuota,
              storage_bytes_quota: state.limits.storageBytesQuota,
            },
            usage: {
              exec_count: state.usage.execCount,
              api_call_count: state.usage.apiCallCount,
              storage_bytes: state.usage.storageBytes,
            },
          },
          429,
        );
      }
      if (state.soft) {
        c.header('X-Quota-Warning', 'exceeded-80pct');
      }
    }

    await next();

    // Bump api_call_count on successful mutating responses (2xx), fire-and-forget.
    if (isMutating) {
      const status = c.res.status;
      if (status >= 200 && status < 300) {
        incrementUsageForced(db, auth.workspaceId, { apiCall: 1 }).catch((err) => {
          getLogger().error('quota_counter_bump_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  });
}
