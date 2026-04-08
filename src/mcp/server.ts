import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DbAdapter } from '../db/adapter.js';
import { loadConfig } from '../config.js';
import { registerTools, parseEnabledTiers } from './tools/registry.js';

import { contextTools } from './tools/context.js';
import { taskTools } from './tools/tasks.js';
import { eventTools } from './tools/events.js';
import { agentTools } from './tools/agents.js';
import { messageTools } from './tools/messages.js';
import { automationTools } from './tools/automation.js';
import { observeTools } from './tools/observe.js';
import { artifactTools } from './tools/artifacts.js';

export function createMcpServer(db: DbAdapter): McpServer {
  const server = new McpServer({
    name: 'lattice',
    version: '0.1.0',
  });

  const config = loadConfig();
  const enabledTiers = parseEnabledTiers(config.latticeTools);

  registerTools(server, db, [
    ...contextTools,
    ...taskTools,
    ...eventTools,
    ...agentTools,
    ...messageTools,
    ...automationTools,
    ...observeTools,
    ...artifactTools,
  ], enabledTiers);

  return server;
}
