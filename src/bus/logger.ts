export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Emit a structured JSON log line to stderr.
 * Format: {"t":<ms-epoch>,"level":"info|warn|error","event":"<name>",...fields}
 */
export function log(
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>,
): void {
  process.stderr.write(
    JSON.stringify({ t: Date.now(), level, event, ...fields }) + '\n',
  );
}
