export interface AppConfig {
  port: number;
  dbPath: string;
  databaseUrl: string;
  pollIntervalMs: number;
  taskReapTimeoutMinutes: number;
  taskReapIntervalMs: number;
  eventRetentionDays: number;
  agentHeartbeatTimeoutMinutes: number;
  adminKey: string;
  logLevel: string;
  logFormat: string;
  auditEnabled: boolean;
  auditRetentionDays: number;
  metricsEnabled: boolean;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  hstsEnabled: boolean;
  corsOrigins: string[] | '*';
  rateLimitPerMinuteWorkspace: number;
  latticeTools: string;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    dbPath: process.env.DB_PATH || './data/lattice.db',
    databaseUrl: process.env.DATABASE_URL || '',
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
    taskReapTimeoutMinutes: parseInt(process.env.TASK_REAP_TIMEOUT_MINUTES || '30', 10),
    taskReapIntervalMs: parseInt(process.env.TASK_REAP_INTERVAL_MS || '60000', 10),
    eventRetentionDays: parseInt(process.env.EVENT_RETENTION_DAYS || '30', 10),
    agentHeartbeatTimeoutMinutes: parseInt(process.env.AGENT_HEARTBEAT_TIMEOUT_MINUTES || '10', 10),
    adminKey: process.env.ADMIN_KEY || '',
    logLevel: process.env.LOG_LEVEL || 'info',
    logFormat: process.env.LOG_FORMAT || '',
    auditEnabled: (process.env.AUDIT_ENABLED || 'true').toLowerCase() !== 'false',
    auditRetentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '365', 10),
    metricsEnabled: (process.env.METRICS_ENABLED || 'true').toLowerCase() !== 'false',
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MIN || '300', 10),
    maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES || '1048576', 10),
    hstsEnabled: (process.env.HSTS_ENABLED || 'false').toLowerCase() === 'true',
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    rateLimitPerMinuteWorkspace: parseInt(process.env.RATE_LIMIT_PER_MIN_WORKSPACE || '1000', 10),
    latticeTools: process.env.LATTICE_TOOLS || 'all',
  };
}

function parseCorsOrigins(raw: string | undefined): string[] | '*' {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed === '*') return '*';
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
