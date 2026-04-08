import { serve } from '@hono/node-server';
import { createApp } from './http/app.js';
import { createMcpServer } from './mcp/server.js';
import { createAdapter } from './db/connection.js';
import { startTaskReaper } from './services/task-reaper.js';
import { startEventCleanup } from './services/event-cleanup.js';
import { startWebhookDispatcher } from './services/webhook-dispatcher.js';
import { startScheduler } from './services/scheduler.js';
import { startAuditCleanup } from './services/audit-cleanup.js';
import { loadConfig } from './config.js';
import { createLogger, setRootLogger, getLogger } from './logger.js';

const config = loadConfig();

// Initialize structured logger before anything else so the whole boot
// sequence and background services log through it.
setRootLogger(
  createLogger({
    level: config.logLevel as 'silent' | 'error' | 'warn' | 'info' | 'debug',
    format:
      config.logFormat === 'json' || config.logFormat === 'pretty'
        ? config.logFormat
        : undefined,
  }),
);

const adapter = await createAdapter({
  databaseUrl: config.databaseUrl,
  dbPath: config.dbPath,
});
const app = createApp(adapter, () => createMcpServer(adapter), config);

startTaskReaper(adapter, config);
startEventCleanup(adapter, config);
startWebhookDispatcher(adapter);
startScheduler(adapter);
startAuditCleanup(adapter, config);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  getLogger().info('lattice_started', {
    port: info.port,
    mcp: `http://localhost:${info.port}/mcp`,
    rest: `http://localhost:${info.port}/api/v1`,
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    getLogger().error('port_in_use', {
      port: config.port,
      hint: `Port ${config.port} is already in use. Set PORT to use a different port.`,
    });
  } else {
    getLogger().error('server_error', { error: err.message });
  }
  process.exit(1);
});
