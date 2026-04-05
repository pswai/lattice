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
  logFormat: string;
  auditEnabled: boolean;
  auditRetentionDays: number;
  metricsEnabled: boolean;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  hstsEnabled: boolean;
  cookieSecure: boolean;
  emailVerificationReturnTokens: boolean;
  githubOAuthClientId: string;
  githubOAuthClientSecret: string;
  githubOAuthRedirectUri: string;
  emailProvider: 'stub' | 'resend';
  emailResendApiKey: string;
  emailFromAddress: string;
  appBaseUrl: string;
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
    logFormat: process.env.LOG_FORMAT || '',
    auditEnabled: (process.env.AUDIT_ENABLED || 'true').toLowerCase() !== 'false',
    auditRetentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS || '365', 10),
    metricsEnabled: (process.env.METRICS_ENABLED || 'true').toLowerCase() !== 'false',
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MIN || '300', 10),
    maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES || '1048576', 10),
    hstsEnabled: (process.env.HSTS_ENABLED || 'false').toLowerCase() === 'true',
    cookieSecure:
      (process.env.COOKIE_SECURE || (process.env.NODE_ENV === 'production' ? 'true' : 'false'))
        .toLowerCase() === 'true',
    emailVerificationReturnTokens:
      (process.env.EMAIL_VERIFICATION_RETURN_TOKENS ||
        (process.env.NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true',
    githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
    githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
    githubOAuthRedirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI || '',
    emailProvider:
      (process.env.EMAIL_PROVIDER || 'stub').toLowerCase() === 'resend' ? 'resend' : 'stub',
    emailResendApiKey: process.env.RESEND_API_KEY || '',
    emailFromAddress: process.env.EMAIL_FROM || 'noreply@agenthub.local',
    appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  };
}
