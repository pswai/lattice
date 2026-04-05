export interface AppConfig {
  port: number;
  dbPath: string;
  pollIntervalMs: number;
  taskReapTimeoutMinutes: number;
  taskReapIntervalMs: number;
  eventRetentionDays: number;
  agentHeartbeatTimeoutMinutes: number;
  adminKey: string;
  logLevel: string;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    dbPath: process.env.DB_PATH || './data/agenthub.db',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
    taskReapTimeoutMinutes: parseInt(process.env.TASK_REAP_TIMEOUT_MINUTES || '30', 10),
    taskReapIntervalMs: parseInt(process.env.TASK_REAP_INTERVAL_MS || '60000', 10),
    eventRetentionDays: parseInt(process.env.EVENT_RETENTION_DAYS || '30', 10),
    agentHeartbeatTimeoutMinutes: parseInt(process.env.AGENT_HEARTBEAT_TIMEOUT_MINUTES || '10', 10),
    adminKey: process.env.ADMIN_KEY || '',
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}
