import { createHash, randomUUID } from 'crypto';
import { Hono } from 'hono';
import type { DbAdapter } from '../db/adapter.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAuthMiddleware, resolveTeamFromRequest } from './middleware/auth.js';
import { createRequestContextMiddleware } from './middleware/request-context.js';
import { createMetricsMiddleware } from './middleware/metrics.js';
import { createAuditMiddleware } from './middleware/audit.js';
import { createRateLimitMiddleware, createWorkspaceRateLimitMiddleware, checkRateLimit } from './middleware/rate-limit.js';
import { createBodyLimitMiddleware } from './middleware/body-limit.js';
import { createSecurityHeadersMiddleware } from './middleware/security-headers.js';
import { createCorsMiddleware } from './middleware/cors.js';
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
import { createWorkspaceTeamRoutes } from './routes/teams.js';
import { createExportRoutes } from './routes/export.js';
import { createDashboardSnapshotRoutes } from './routes/dashboard-snapshot.js';
import { createSseRoutes } from './routes/sse.js';
import { createAnalyticsRoutes } from './routes/analytics.js';
import { createAdminRoutes } from './routes/admin.js';
import { createAdminKeyRoutes } from './routes/admin-keys.js';
import { createOpsRoutes } from './routes/ops.js';
import { createAuditRoutes } from './routes/audit.js';
import { mcpAuthStorage } from '../mcp/auth-context.js';
import { sessionRegistry } from '../mcp/session-registry.js';
import { AppError } from '../errors.js';
import type { AppConfig } from '../config.js';
import { getLogger } from '../logger.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createApp(
  db: DbAdapter,
  createMcpServer: () => McpServer,
  config?: AppConfig,
): Hono {
  const app = new Hono();

  // Request context (X-Request-ID + per-request logger + access log)
  // Runs first so every response carries the header even for errors.
  app.use('*', createRequestContextMiddleware());

  // Security response headers (cheap, always-on)
  app.use('*', createSecurityHeadersMiddleware({ hstsEnabled: !!config?.hstsEnabled }));

  // CORS — mounted only when origins are configured. Fully inert by default.
  if (config) {
    const origins = config.corsOrigins;
    const isEnabled = origins === '*' || (Array.isArray(origins) && origins.length > 0);
    if (isEnabled) {
      app.use('*', createCorsMiddleware({ origins, credentials: false }));
    }
  }

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

  // Dashboard — serve React app from dashboard/dist/
  // Resolve path relative to this file's location (src/http/) → ../../dashboard/dist/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const dashboardDir = resolve(__dirname, '../../dashboard/dist');
  const dashboardExists = existsSync(resolve(dashboardDir, 'index.html'));

  // Cache index.html in memory once for both root route and SPA fallback
  const indexHtml = dashboardExists
    ? readFileSync(resolve(dashboardDir, 'index.html'), 'utf-8')
    : null;

  if (indexHtml) {
    // Serve static assets (JS, CSS, images) from dashboard/dist/assets/
    app.use('/assets/*', serveStatic({ root: './dashboard/dist/' }));

    // Root route serves the React app
    app.get('/', (c) => c.html(indexHtml));
  } else {
    // Fallback: dashboard not built yet — show a helpful message
    app.get('/', (c) => c.html(
      '<html><body style="background:#0a0a0f;color:#e2e2ea;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">' +
      '<div style="text-align:center"><h1>Lattice</h1><p>Dashboard not built. Run <code>npm run build:dashboard</code> first.</p></div>' +
      '</body></html>',
    ));
  }

  // Health check (no auth required) — legacy; /healthz below is the canonical one
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Operational endpoints: /metrics (Prometheus), /healthz, /readyz — all public.
  app.route('/', createOpsRoutes(db, { metricsEnabled: config?.metricsEnabled ?? true }));

  // MCP endpoint — session-based Streamable HTTP mode.
  //
  // The Streamable HTTP transport handles POST (JSON-RPC requests),
  // GET (SSE event streams for server-to-client push), and DELETE
  // (session cleanup) internally.
  //
  // Sessions are created on initialization and reused for subsequent
  // requests from the same client. This enables server-initiated
  // notifications (e.g., pushing direct messages to idle agents).
  app.all('/mcp', async (c) => {
    // Authenticate the MCP request using the same scheme as REST routes,
    // including X-Team-Override support so a single session can switch teams.
    const result = await resolveTeamFromRequest(db, c);
    if (!result.ok) {
      return c.json({ error: result.error, message: result.message }, result.status);
    }

    // Rate-limit MCP requests using the same per-key bucket as REST
    if (config && config.rateLimitPerMinute > 0) {
      const authHeader = c.req.header('Authorization') || '';
      const keyId = createHash('sha256').update(authHeader).digest('hex');
      const rl = checkRateLimit(keyId, config.rateLimitPerMinute);
      if (rl.limited) {
        return c.json({ error: 'RATE_LIMITED', message: 'Too many requests' }, 429);
      }
    }

    const agentId = c.req.header('X-Agent-ID') || 'anonymous';
    const xff = c.req.header('X-Forwarded-For');
    const ip = xff ? xff.split(',')[0]?.trim() : c.req.header('X-Real-IP')?.trim() || '';
    const requestId = c.get('requestId') as string | undefined;
    const auth = { workspaceId: result.resolved.workspaceId, agentId, scope: result.resolved.scope, ip: ip || undefined, requestId };

    // Reuse existing session if client provides a session ID
    const incomingSessionId = c.req.header('mcp-session-id');
    const existingSession = incomingSessionId ? sessionRegistry.getSession(incomingSessionId) : undefined;

    if (existingSession) {
      // Reject if the authenticated workspace doesn't match the session's workspace.
      // Prevents cross-workspace session hijacking via stolen session IDs.
      if (existingSession.workspaceId !== auth.workspaceId) {
        return c.json({ error: 'INVALID_SESSION', message: 'Session does not belong to this workspace' }, 403);
      }
      return mcpAuthStorage.run(auth, () =>
        existingSession.transport.handleRequest(c.req.raw),
      );
    }

    // New session — create transport with session management
    const mcpServer = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessionRegistry.registerSession({
          sessionId: id,
          transport,
          server: mcpServer,
          workspaceId: auth.workspaceId,
          agentId: auth.agentId,
        });
      },
      onsessionclosed: (id) => {
        sessionRegistry.removeSession(id);
      },
    });

    await mcpServer.connect(transport);

    return mcpAuthStorage.run(auth, () => transport.handleRequest(c.req.raw));
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

  // Rate limit per-workspace (after auth so workspaceId is available); 0 disables.
  if (config && config.rateLimitPerMinuteWorkspace > 0) {
    api.use('*', createWorkspaceRateLimitMiddleware({ perMinute: config.rateLimitPerMinuteWorkspace }));
  }

  // Append-only audit log on mutating requests (after auth so actor is known).
  if (config?.auditEnabled ?? true) {
    api.use('*', createAuditMiddleware(db));
  }

  api.route('/context', createContextRoutes(db));
  // Both event routes and SSE routes mount on /events — no conflict because
  // events.ts handles POST /events (broadcast) + GET /events (polling),
  // while sse.ts handles GET /events/stream (Server-Sent Events).
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
  api.route('/teams', createWorkspaceTeamRoutes(db));
  api.route('/export', createExportRoutes(db));
  api.route('/dashboard-snapshot', createDashboardSnapshotRoutes(db));

  app.route('/api/v1', api);

  // SPA fallback — any unmatched GET that isn't an API route serves index.html
  // so client-side routing works (e.g. deep links, browser refresh).
  if (indexHtml) {
    app.get('*', (c) => {
      // Don't intercept API, MCP, admin, auth, or operational routes
      const path = c.req.path;
      if (path.startsWith('/api/') || path.startsWith('/mcp') || path.startsWith('/admin') ||
          path.startsWith('/health') || path.startsWith('/metrics') ||
          path.startsWith('/readyz') || path.startsWith('/healthz')) {
        return c.notFound();
      }
      return c.html(indexHtml);
    });
  }

  return app;
}
