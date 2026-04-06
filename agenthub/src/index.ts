import { serve } from '@hono/node-server';
import { createApp } from './http/app.js';
import { createMcpServer } from './mcp/server.js';
import { createSqliteAdapter } from './db/connection.js';
import { startTaskReaper } from './services/task-reaper.js';
import { startEventCleanup } from './services/event-cleanup.js';
import { startWebhookDispatcher } from './services/webhook-dispatcher.js';
import { startScheduler } from './services/scheduler.js';
import { startAuditCleanup } from './services/audit-cleanup.js';
import { startSessionCleanup } from './services/session-cleanup.js';
import { createEmailSender } from './services/email.js';
import { loadConfig } from './config.js';
import { createLogger, setRootLogger, getLogger } from './logger.js';
import { setUsageTracking } from './models/usage.js';

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

const adapter = createSqliteAdapter(config.dbPath);
setUsageTracking(true);
const emailSender = createEmailSender(config);
const app = createApp(adapter, () => createMcpServer(adapter), config, emailSender);

startTaskReaper(adapter, config);
startEventCleanup(adapter, config);
startWebhookDispatcher(adapter);
startScheduler(adapter);
startAuditCleanup(adapter, config);
startSessionCleanup(adapter);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  getLogger().info('lattice_started', {
    port: info.port,
    mcp: `http://localhost:${info.port}/mcp`,
    rest: `http://localhost:${info.port}/api/v1`,
  });
});
