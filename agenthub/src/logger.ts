/**
 * Zero-dep structured logger.
 *
 * - JSON output by default (machine-parseable, safe to pipe to any log shipper)
 * - Pretty-printed TTY output when stdout is a terminal
 * - Levels: silent, error, warn, info, debug (LOG_LEVEL env)
 * - Format override: LOG_FORMAT=json|pretty
 * - Automatic secret redaction (API keys, bearer tokens, etc) on every line
 * - Child loggers carry bound fields (req_id, team_id, agent_id, component…)
 * - Auto-silent under vitest to keep test output clean
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  fields?: Record<string, unknown>;
  stream?: { write(s: string): unknown };
}

// Patterns scrubbed from every emitted log line. Mirrors secret-scanner but
// broader — we never want an API key ending up on disk or in a log shipper.
const REDACT_PATTERNS: RegExp[] = [
  /\bah_[0-9a-f]{48}\b/gi, // AgentHub API keys
  /\bBearer\s+[A-Za-z0-9_\-\.=]{20,}/gi,
  /\bsk_live_[0-9a-zA-Z]{24,}\b/g,
  /\bsk_test_[0-9a-zA-Z]{24,}\b/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bghs_[A-Za-z0-9]{36}\b/g,
  /\bgho_[A-Za-z0-9]{36}\b/g,
  /\bAIza[A-Za-z0-9_\-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
];

export function redactSecrets(line: string): string {
  let out = line;
  for (const r of REDACT_PATTERNS) out = out.replace(r, '[REDACTED]');
  return out;
}

function resolveLevel(opt?: LogLevel): LogLevel {
  if (opt) return opt;
  // Silent under vitest so test runs stay clean.
  if (process.env.VITEST) return 'silent';
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_WEIGHT) return env as LogLevel;
  return 'info';
}

function resolveFormat(opt?: 'json' | 'pretty'): 'json' | 'pretty' {
  if (opt) return opt;
  const env = process.env.LOG_FORMAT?.toLowerCase();
  if (env === 'json' || env === 'pretty') return env;
  return process.stdout.isTTY ? 'pretty' : 'json';
}

const LEVEL_COLORS: Record<Exclude<LogLevel, 'silent'>, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function formatPretty(rec: Record<string, unknown>): string {
  const { ts, level, msg, ...rest } = rec;
  const color = LEVEL_COLORS[level as Exclude<LogLevel, 'silent'>] ?? '';
  const time = typeof ts === 'string' ? ts.slice(11, 23) : '';
  const pairs = Object.entries(rest)
    .map(([k, v]) => `${DIM}${k}${RESET}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `${DIM}${time}${RESET} ${color}${String(level).toUpperCase().padEnd(5)}${RESET} ${msg}${pairs ? ' ' + pairs : ''}`;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = resolveLevel(opts.level);
  const format = resolveFormat(opts.format);
  const baseFields = opts.fields ?? {};
  const stream = opts.stream ?? process.stdout;
  const threshold = LEVEL_WEIGHT[level];

  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_WEIGHT[lvl] > threshold) return;
    const rec: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...baseFields,
      ...fields,
    };
    const line = format === 'json' ? JSON.stringify(rec) : formatPretty(rec);
    stream.write(redactSecrets(line) + '\n');
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) =>
      createLogger({
        level,
        format,
        fields: { ...baseFields, ...fields },
        stream,
      }),
  };
}

let rootLogger: Logger = createLogger();

export function getLogger(): Logger {
  return rootLogger;
}

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}
