import { serve } from '@hono/node-server';
import { createApp } from './http/app.js';
import { createMcpServer } from './mcp/server.js';
import { initDatabase } from './db/connection.js';
import { startTaskReaper } from './services/task-reaper.js';
import { startEventCleanup } from './services/event-cleanup.js';
import { startWebhookDispatcher } from './services/webhook-dispatcher.js';
import { startScheduler } from './services/scheduler.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = initDatabase(config.dbPath);
const app = createApp(db, () => createMcpServer(db), config);

startTaskReaper(db, config);
startEventCleanup(db, config);
startWebhookDispatcher(db);
startScheduler(db);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`AgentHub listening on http://localhost:${info.port}`);
  console.log(`MCP endpoint: http://localhost:${info.port}/mcp`);
  console.log(`REST API: http://localhost:${info.port}/api/v1`);
});
