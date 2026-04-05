import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAuthMiddleware, resolveTeamFromRequest } from './middleware/auth.js';
import { createRequestContextMiddleware } from './middleware/request-context.js';
import { createMetricsMiddleware } from './middleware/metrics.js';
import { createAuditMiddleware } from './middleware/audit.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';
import { createBodyLimitMiddleware } from './middleware/body-limit.js';
import { createSecurityHeadersMiddleware } from './middleware/security-headers.js';
import { createContextRoutes } from './routes/context.js';
import { createEventRoutes } from './routes/events.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createAgentRoutes } from './routes/agents.js';
import { createMessageRoutes } from './routes/messages.js';
import { createPlaybookRoutes } from './routes/playbooks.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import { createWorkflowRunRoutes } from './routes/workflow-runs.js';
import { createScheduleRoutes } from './routes/schedules.js';
import { createProfileRoutes } from './routes/profiles.js';
import { createWebhookRoutes } from './routes/webhooks.js';
import {
  createInboundReceiverRoutes,
  createInboundManagementRoutes,
} from './routes/inbound.js';
import { createTeamRoutes } from './routes/teams.js';
import { createExportRoutes } from './routes/export.js';
import { createSseRoutes } from './routes/sse.js';
import { createAnalyticsRoutes } from './routes/analytics.js';
import { createAdminRoutes } from './routes/admin.js';
import { createAdminKeyRoutes } from './routes/admin-keys.js';
import { createOpsRoutes } from './routes/ops.js';
import { createAuditRoutes } from './routes/audit.js';
import { mcpAuthStorage } from '../mcp/auth-context.js';
import { AppError } from '../errors.js';
import type { AppConfig } from '../config.js';
import { DASHBOARD_HTML } from '../dashboard.js';
import { getLogger } from '../logger.js';

export function createApp(db: Database.Database, createMcpServer: () => McpServer, config?: AppConfig): Hono {
  const app = new Hono();

  // Request context (X-Request-ID + per-request logger + access log)
  // Runs first so every response carries the header even for errors.
  app.use('*', createRequestContextMiddleware());

  // Security response headers (cheap, always-on)
  app.use('*', createSecurityHeadersMiddleware({ hstsEnabled: !!config?.hstsEnabled }));

  // Body size limit (Content-Length based; 0 = disabled)
  if (config && config.maxBodyBytes > 0) {
    app.use('*', createBodyLimitMiddleware(config.maxBodyBytes));
  }

  // Prometheus request counters + histogram
  app.use('*', createMetricsMiddleware());

  // Global error handler
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400);
    }
    const log = c.get('logger') ?? getLogger();
    log.error('unhandled_error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    }, 500);
  });

  // Dashboard (no auth required — API key lives in client localStorage)
  app.get('/', (c) => c.html(DASHBOARD_HTML));

  // Health check (no auth required) — legacy; /healthz below is the canonical one
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Operational endpoints: /metrics (Prometheus), /healthz, /readyz — all public.
  app.route('/', createOpsRoutes(db, { metricsEnabled: config?.metricsEnabled ?? true }));

  // MCP endpoint — authenticated, stateless per-request mode.
  //
  // The Streamable HTTP transport handles POST (JSON-RPC requests),
  // GET (SSE event streams), and DELETE (session cleanup) internally.
  // In stateless mode the SDK requires a fresh transport per request, and
  // McpServer.connect() can only be called when no transport is attached,
  // so we create a fresh McpServer+transport pair for every request to
  // avoid concurrency issues with overlapping connections.
  app.all('/mcp', async (c) => {
    // Authenticate the MCP request using the same scheme as REST routes,
    // including X-Team-Override support so a single session can switch teams.
    const result = resolveTeamFromRequest(db, c);
    if (!result.ok) {
      return c.json({ error: result.error, message: result.message }, result.status);
    }

    const agentId = c.req.header('X-Agent-ID') || 'anonymous';
    const auth = { teamId: result.resolved.teamId, agentId, scope: result.resolved.scope };

    // Run the MCP handler within the auth context so tool handlers can access it
    return mcpAuthStorage.run(auth, async () => {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      return transport.handleRequest(c.req.raw);
    });
  });

  // Public inbound webhook receiver — mounted BEFORE auth middleware.
  // The endpoint_key in the URL IS the auth for these receivers.
  app.route('/api/v1/inbound', createInboundReceiverRoutes(db));

  // Admin routes (separate auth via ADMIN_KEY) — must be mounted before the API auth middleware.
  // admin-keys is mounted FIRST: its POST /teams/:id/keys supersedes the legacy one
  // with additive `expires_in_days` support. Audit query lives under /admin/audit-log.
  if (config) {
    app.route('/admin', createAdminKeyRoutes(db, config));
    app.route('/admin', createAuditRoutes(db, config));
    app.route('/admin', createAdminRoutes(db, config));
  }

  // API routes — all require team API key auth
  const api = new Hono();
  api.use('*', createAuthMiddleware(db));

  // Rate limit per-key (after auth so we can attribute); 0 disables.
  if (config && config.rateLimitPerMinute > 0) {
    api.use('*', createRateLimitMiddleware({ perMinute: config.rateLimitPerMinute }));
  }

  // Append-only audit log on mutating requests (after auth so actor is known).
  if (config?.auditEnabled ?? true) {
    api.use('*', createAuditMiddleware(db));
  }
  api.route('/context', createContextRoutes(db));
  api.route('/events', createEventRoutes(db));
  api.route('/tasks', createTaskRoutes(db));
  api.route('/agents', createAgentRoutes(db));
  api.route('/messages', createMessageRoutes(db));
  api.route('/events', createSseRoutes(db));
  api.route('/analytics', createAnalyticsRoutes(db));
  api.route('/playbooks', createPlaybookRoutes(db));
  api.route('/artifacts', createArtifactRoutes(db));
  api.route('/workflow-runs', createWorkflowRunRoutes(db));
  api.route('/schedules', createScheduleRoutes(db));
  api.route('/profiles', createProfileRoutes(db));
  api.route('/webhooks', createWebhookRoutes(db));
  api.route('/inbound', createInboundManagementRoutes(db));
  api.route('/teams', createTeamRoutes(db));
  api.route('/export', createExportRoutes(db));

  app.route('/api/v1', api);

  return app;
}
